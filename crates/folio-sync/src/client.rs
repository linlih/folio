//! The client side of sync (design/ARCHITECTURE.md §5.3): push the outbox
//! (local updates, encrypted), pull what other devices pushed after the
//! cursor, apply it through the store's single write path.
//!
//! The store lock is held only to read the outbox or to apply a batch, never
//! across a network call, so editing goes on while a sync runs.

use std::sync::Mutex;

use folio_core::{DocId, DocKind};
use folio_store::Store;

use crate::crypto::{b64, unb64, Keys};
use crate::protocol::{PullResponse, PushItem};
use crate::{Result, SyncError};

/// The server's side of the conversation; HTTP in the app, the relay
/// itself in the simulator.
pub trait Transport {
    /// Stores updates; returns the new head.
    fn push(&self, items: &[PushItem]) -> Result<i64>;
    fn pull(&self, after: i64, limit: u32) -> Result<PullResponse>;
}

/// Updates sent per push.
const PUSH_BATCH: u32 = 200;
/// Updates asked for per pull.
const PULL_BATCH: u32 = 500;
/// `sync_state` key of the pull cursor: the last sequence applied.
pub const CURSOR: &str = "sync.cursor";

/// An update from another device that changed a document here.
#[derive(Clone, Debug)]
pub struct Applied {
    pub doc: DocId,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct Report {
    pub pushed: usize,
    pub pulled: usize,
    pub applied: Vec<Applied>,
}

const ENVELOPE_VERSION: u8 = 1;

fn kind_byte(kind: DocKind) -> u8 {
    match kind {
        DocKind::Card => 0,
        DocKind::Board => 1,
        DocKind::Workspace => 2,
    }
}

fn kind_of(b: u8) -> Result<DocKind> {
    match b {
        0 => Ok(DocKind::Card),
        1 => Ok(DocKind::Board),
        2 => Ok(DocKind::Workspace),
        _ => Err(SyncError::Protocol(format!("unknown document kind {b}"))),
    }
}

/// What is sealed: the document's kind and id (the server sees only an
/// opaque tag), then the Loro update.
fn envelope(kind: DocKind, doc: &DocId, update: &[u8]) -> Vec<u8> {
    let id = doc.as_str().as_bytes();
    let mut out = Vec::with_capacity(4 + id.len() + update.len());
    out.push(ENVELOPE_VERSION);
    out.push(kind_byte(kind));
    out.extend_from_slice(&(id.len() as u16).to_le_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(update);
    out
}

fn open_envelope(bytes: &[u8]) -> Result<(DocKind, DocId, &[u8])> {
    if bytes.len() < 4 || bytes[0] != ENVELOPE_VERSION {
        return Err(SyncError::Protocol("unknown envelope".into()));
    }
    let kind = kind_of(bytes[1])?;
    let len = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
    let id = bytes.get(4..4 + len).ok_or_else(|| SyncError::Protocol("short envelope".into()))?;
    let id = std::str::from_utf8(id).map_err(|e| SyncError::Protocol(e.to_string()))?;
    Ok((kind, DocId::parse(id).map_err(|e| SyncError::Protocol(e.to_string()))?, &bytes[4 + len..]))
}

fn lock(store: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// One workspace's keys and name; stateless otherwise (the cursor and the
/// outbox live in the store).
pub struct Engine {
    workspace: String,
    keys: Keys,
}

impl Engine {
    pub fn new(workspace: impl Into<String>, keys: Keys) -> Self {
        Engine { workspace: workspace.into(), keys }
    }

    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    /// Sends every queued local update; returns how many.
    pub fn push(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        let mut pushed = 0;
        loop {
            let batch = lock(store).outbox_batch(PUSH_BATCH)?;
            if batch.is_empty() {
                return Ok(pushed);
            }
            let items: Vec<PushItem> = batch
                .iter()
                .map(|it| {
                    let tag = self.keys.doc_tag(it.doc.as_str());
                    let blob = self.keys.seal(&self.workspace, &tag, &envelope(it.kind, &it.doc, &it.bytes));
                    PushItem { doc: tag, blob: b64(&blob) }
                })
                .collect();
            t.push(&items)?;
            lock(store).outbox_ack(&batch.iter().map(|it| it.id).collect::<Vec<_>>())?;
            pushed += batch.len();
        }
    }

    /// Applies everything pushed after the cursor. A blob that cannot be
    /// opened stops the pull without moving the cursor (wrong key, damaged
    /// data): nothing is skipped silently.
    pub fn pull(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<(usize, Vec<Applied>)> {
        let mut pulled = 0;
        let mut applied = Vec::new();
        loop {
            let cursor = Self::cursor(&lock(store))?;
            let resp = t.pull(cursor, PULL_BATCH)?;
            let Some(last) = resp.updates.last().map(|u| u.seq) else { return Ok((pulled, applied)) };
            // Decrypt outside the lock.
            let mut opened = Vec::with_capacity(resp.updates.len());
            for u in &resp.updates {
                let plain = self.keys.open(&self.workspace, &u.doc, &unb64(&u.blob)?)?;
                opened.push(plain);
            }
            {
                let mut s = lock(store);
                for plain in &opened {
                    let (kind, doc, bytes) = open_envelope(plain)?;
                    if s.apply_remote(&doc, kind, bytes, now_ms())? {
                        applied.push(Applied { doc, bytes: bytes.to_vec() });
                    }
                }
                s.set_sync_value(CURSOR, &last.to_le_bytes())?;
            }
            pulled += resp.updates.len();
            if last >= resp.head {
                return Ok((pulled, applied));
            }
        }
    }

    /// Push, then pull.
    pub fn sync(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<Report> {
        let pushed = self.push(store, t)?;
        let (pulled, applied) = self.pull(store, t)?;
        Ok(Report { pushed, pulled, applied })
    }

    pub fn cursor(store: &Store) -> Result<i64> {
        Ok(store
            .sync_value(CURSOR)?
            .and_then(|v| v.try_into().ok())
            .map(i64::from_le_bytes)
            .unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips() {
        let doc = DocId::parse("journal:2026-10-24").unwrap();
        let e = envelope(DocKind::Card, &doc, b"loro bytes");
        let (kind, id, bytes) = open_envelope(&e).unwrap();
        assert_eq!((kind, id, bytes), (DocKind::Card, doc, &b"loro bytes"[..]));
        assert!(open_envelope(&[9, 0, 0, 0]).is_err());
    }
}
