//! End-to-end encryption (design/ARCHITECTURE.md §5.3). The server stores
//! and relays only ciphertext; it never sees note content or document ids.
//!
//! - A random 32-byte **workspace key** is made by the first device.
//! - It is kept on the server only *wrapped*: sealed with a key derived from
//!   the user's passphrase by Argon2id. A new device needs the passphrase.
//! - Keys are derived from it (HKDF-SHA256): one seals updates
//!   (XChaCha20-Poly1305, random 24-byte nonces), one turns document ids
//!   into opaque tags (HMAC-SHA256) the server can group by, and two do the
//!   same for files (design/attachments.md §5.2): files go up in sealed
//!   chunks under an id that is an HMAC of their hash.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::{Result, SyncError};

const NONCE: usize = 24;

/// A file's plain bytes per chunk.
pub const CHUNK: usize = 1 << 20;
/// The last chunk is padded to a multiple of this, so the server learns a
/// file's size only roughly.
const PAD: usize = 64 * 1024;
/// The largest sealed chunk: a full chunk, its length and the cipher's
/// nonce and tag (a last chunk's padding stays within it).
pub const MAX_SEALED_CHUNK: usize = 4 + CHUNK + PAD + NONCE + 16;

/// How many chunks a file of `size` bytes goes up in (an empty file: one).
pub fn chunks_for(size: u64) -> u32 {
    (size.div_ceil(CHUNK as u64)).max(1) as u32
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("system randomness");
    out
}

/// The workspace key; never leaves a device unwrapped.
#[derive(Clone)]
pub struct WorkspaceKey(pub [u8; 32]);

impl WorkspaceKey {
    pub fn generate() -> Self {
        WorkspaceKey(random_bytes())
    }
}

impl std::fmt::Debug for WorkspaceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorkspaceKey(…)")
    }
}

/// The keys derived from the workspace key.
#[derive(Clone)]
pub struct Keys {
    content: [u8; 32],
    doc_tag: [u8; 32],
    blob: [u8; 32],
    blob_id: [u8; 32],
}

impl Keys {
    pub fn derive(key: &WorkspaceKey) -> Self {
        let hk = Hkdf::<Sha256>::new(None, &key.0);
        let mut content = [0u8; 32];
        let mut doc_tag = [0u8; 32];
        hk.expand(b"folio sync content v1", &mut content).expect("32 bytes");
        hk.expand(b"folio sync doc tag v1", &mut doc_tag).expect("32 bytes");
        let mut blob = [0u8; 32];
        let mut blob_id = [0u8; 32];
        hk.expand(b"folio sync blob v1", &mut blob).expect("32 bytes");
        hk.expand(b"folio sync blob id v1", &mut blob_id).expect("32 bytes");
        Keys { content, doc_tag, blob, blob_id }
    }

    /// The opaque tag the server sees instead of a document id.
    pub fn doc_tag(&self, doc_id: &str) -> String {
        tag(&self.doc_tag, doc_id)
    }

    /// The id the server keeps a file under instead of its hash: files are
    /// still stored once per workspace, but the server cannot tell whether
    /// it holds a file it knows the hash of.
    pub fn blob_id(&self, sha256: &str) -> String {
        tag(&self.blob_id, sha256)
    }

    /// Seals chunk `n` of a file. The workspace, the file's id, the chunk's
    /// number and whether it is the last are bound to it, so chunks cannot
    /// be swapped, moved to another file, or the file cut short.
    pub fn seal_chunk(&self, workspace: &str, id: &str, n: u32, last: bool, data: &[u8]) -> Vec<u8> {
        let mut plain = Vec::with_capacity(4 + data.len() + PAD);
        plain.extend_from_slice(&(data.len() as u32).to_le_bytes());
        plain.extend_from_slice(data);
        if last {
            plain.resize(plain.len().div_ceil(PAD) * PAD, 0);
        }
        let nonce: [u8; NONCE] = random_bytes();
        let cipher = XChaCha20Poly1305::new((&self.blob).into());
        let aad = chunk_aad(workspace, id, n, last);
        let ct = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: aad.as_bytes() }).expect("encryption");
        [nonce.as_slice(), &ct].concat()
    }

    pub fn open_chunk(&self, workspace: &str, id: &str, n: u32, last: bool, sealed: &[u8]) -> Result<Vec<u8>> {
        let damaged = || SyncError::Crypto(format!("file chunk {n} cannot be opened: wrong key or damaged data"));
        if sealed.len() < NONCE {
            return Err(damaged());
        }
        let (nonce, ct) = sealed.split_at(NONCE);
        let cipher = XChaCha20Poly1305::new((&self.blob).into());
        let aad = chunk_aad(workspace, id, n, last);
        let mut plain = cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: aad.as_bytes() }).map_err(|_| damaged())?;
        let len = plain.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or_else(damaged)?;
        if 4 + len > plain.len() || (!last && 4 + len != plain.len()) {
            return Err(damaged());
        }
        plain.truncate(4 + len);
        plain.drain(..4);
        Ok(plain)
    }

    /// Seals `plaintext`; the workspace and tag are authenticated with it,
    /// so a blob cannot be replayed under another document.
    pub fn seal(&self, workspace: &str, tag: &str, plaintext: &[u8]) -> Vec<u8> {
        let nonce: [u8; NONCE] = random_bytes();
        let cipher = XChaCha20Poly1305::new((&self.content).into());
        let aad = format!("{workspace}\n{tag}");
        let ct = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: aad.as_bytes() }).expect("encryption");
        [nonce.as_slice(), &ct].concat()
    }

    pub fn open(&self, workspace: &str, tag: &str, blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() < NONCE {
            return Err(SyncError::Crypto("blob too short".into()));
        }
        let (nonce, ct) = blob.split_at(NONCE);
        let cipher = XChaCha20Poly1305::new((&self.content).into());
        let aad = format!("{workspace}\n{tag}");
        cipher
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: aad.as_bytes() })
            .map_err(|_| SyncError::Crypto("cannot decrypt: wrong key or damaged data".into()))
    }
}

fn tag(key: &[u8; 32], s: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(s.as_bytes());
    mac.finalize().into_bytes()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn chunk_aad(workspace: &str, id: &str, n: u32, last: bool) -> String {
    format!("{workspace}\n{id}\n{n}\n{}", u8::from(last))
}

/// The workspace key as the server keeps it: sealed under a key derived
/// from the passphrase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedKey {
    pub salt: String,
    pub nonce: String,
    pub sealed: String,
    /// Argon2id cost: memory (KiB), iterations, lanes.
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// Argon2id cost for new keys: 64 MiB, 3 passes (OWASP's recommendation).
pub const DEFAULT_COST: (u32, u32, u32) = (64 * 1024, 3, 1);

fn kek(passphrase: &str, salt: &[u8], (m, t, p): (u32, u32, u32)) -> Result<[u8; 32]> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| SyncError::Crypto(e.to_string()))?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| SyncError::Crypto(e.to_string()))?;
    Ok(out)
}

pub fn wrap(key: &WorkspaceKey, passphrase: &str, cost: (u32, u32, u32)) -> Result<WrappedKey> {
    let salt: [u8; 16] = random_bytes();
    let nonce: [u8; NONCE] = random_bytes();
    let kek = kek(passphrase, &salt, cost)?;
    let sealed = XChaCha20Poly1305::new((&kek).into()).encrypt(XNonce::from_slice(&nonce), key.0.as_slice()).expect("encryption");
    Ok(WrappedKey { salt: B64.encode(salt), nonce: B64.encode(nonce), sealed: B64.encode(sealed), m_cost: cost.0, t_cost: cost.1, p_cost: cost.2 })
}

pub fn unwrap(wrapped: &WrappedKey, passphrase: &str) -> Result<WorkspaceKey> {
    let decode = |s: &str| B64.decode(s).map_err(|e| SyncError::Crypto(e.to_string()));
    let (salt, nonce, sealed) = (decode(&wrapped.salt)?, decode(&wrapped.nonce)?, decode(&wrapped.sealed)?);
    if nonce.len() != NONCE {
        return Err(SyncError::Crypto("bad nonce".into()));
    }
    let kek = kek(passphrase, &salt, (wrapped.m_cost, wrapped.t_cost, wrapped.p_cost))?;
    let key = XChaCha20Poly1305::new((&kek).into())
        .decrypt(XNonce::from_slice(&nonce), sealed.as_slice())
        .map_err(|_| SyncError::WrongPassphrase)?;
    let key: [u8; 32] = key.try_into().map_err(|_| SyncError::Crypto("bad key length".into()))?;
    Ok(WorkspaceKey(key))
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    B64.decode(s).map_err(|e| SyncError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Light Argon2 cost for tests.
    pub const TEST_COST: (u32, u32, u32) = (1024, 1, 1);

    #[test]
    fn seal_open_and_tags() {
        let keys = Keys::derive(&WorkspaceKey::generate());
        let tag = keys.doc_tag("journal:2026-10-24");
        assert_eq!(tag.len(), 32);
        assert_eq!(tag, keys.doc_tag("journal:2026-10-24"), "stable per document");
        assert_ne!(tag, keys.doc_tag("journal:2026-10-25"));
        let blob = keys.seal("ws", &tag, b"hello");
        assert_eq!(keys.open("ws", &tag, &blob).unwrap(), b"hello");
        // The server cannot move a blob to another document or workspace.
        assert!(keys.open("ws", &keys.doc_tag("other"), &blob).is_err());
        assert!(keys.open("other-ws", &tag, &blob).is_err());
        // Another workspace key cannot read it.
        assert!(Keys::derive(&WorkspaceKey::generate()).open("ws", &tag, &blob).is_err());
    }

    #[test]
    fn file_chunks_open_only_where_they_were_sealed() {
        let keys = Keys::derive(&WorkspaceKey::generate());
        let sha = "ab".repeat(32);
        let id = keys.blob_id(&sha);
        assert_eq!(id.len(), 32);
        assert_ne!(id, keys.doc_tag(&sha), "files and documents use different keys");
        let first = keys.seal_chunk("ws", &id, 0, false, &[7u8; 10]);
        let last = keys.seal_chunk("ws", &id, 1, true, b"tail");
        assert_eq!(keys.open_chunk("ws", &id, 0, false, &first).unwrap(), [7u8; 10]);
        assert_eq!(keys.open_chunk("ws", &id, 1, true, &last).unwrap(), b"tail");
        // The last chunk is padded: 4 bytes and 400 KB look alike.
        assert_eq!(last.len(), keys.seal_chunk("ws", &id, 1, true, &vec![0u8; 400_000]).len() - 6 * PAD);
        assert_eq!(last.len(), NONCE + 16 + PAD);
        // Swapped, moved, cut short, or changed: none opens.
        assert!(keys.open_chunk("ws", &id, 1, false, &first).is_err());
        assert!(keys.open_chunk("ws", &id, 0, true, &first).is_err(), "a middle chunk cannot pass for the last");
        assert!(keys.open_chunk("ws", &keys.blob_id(&"cd".repeat(32)), 0, false, &first).is_err());
        assert!(keys.open_chunk("other", &id, 1, true, &last).is_err());
        let mut changed = last.clone();
        changed[30] ^= 1;
        assert!(keys.open_chunk("ws", &id, 1, true, &changed).is_err());
        assert_eq!(chunks_for(0), 1);
        assert_eq!(chunks_for(CHUNK as u64), 1);
        assert_eq!(chunks_for(CHUNK as u64 + 1), 2);
    }

    #[test]
    fn the_passphrase_unwraps_the_key() {
        let key = WorkspaceKey::generate();
        let wrapped = wrap(&key, "correct horse", TEST_COST).unwrap();
        assert_eq!(unwrap(&wrapped, "correct horse").unwrap().0, key.0);
        assert!(matches!(unwrap(&wrapped, "wrong"), Err(SyncError::WrongPassphrase)));
    }
}
