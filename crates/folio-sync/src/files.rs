//! Images and attachments in sync (design/attachments.md §5): files go up
//! sealed in chunks under an id the server cannot link to their hash, and
//! come down the same way, checked against the hash before they are kept.
//!
//! Files have their own queue, apart from documents: a sync of edits never
//! waits for a file. The store lock is held only to read or record state;
//! files are read and written outside it (stored files never change).
//!
//! The device also tells the server which files it still uses (§6), so the
//! server can delete the rest; a file the server lost or deleted while a
//! card here uses it goes up again.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use folio_store::{AssetInfo, Incoming, Store};

use crate::client::{lock, now_ms, Engine, Transport};
use crate::crypto::{chunks_for, CHUNK};
use crate::protocol::{BlobState, MAX_BLOB_IDS};
use sha2::{Digest, Sha256};
use crate::{Result, SyncError};

/// `sync_state` key: what was last reported of the files in use (a digest
/// of the ids, then when, little-endian ms).
pub const REFS_REPORTED: &str = "sync.files.reported";

/// The files in use are reported again this often even when unchanged, so
/// the server knows the device is still there.
pub const REPORT_EVERY_MS: i64 = 6 * 60 * 60 * 1000;

/// What became of a download.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fetched {
    /// Here now.
    Done(AssetInfo),
    /// Not on the server (yet): the device that has it has not uploaded it.
    NotOnServer,
}

fn read_full(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match file.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn io(e: std::io::Error) -> SyncError {
    SyncError::Store(e.into())
}

impl Engine {
    /// Uploads the files the server does not have yet, smallest first;
    /// returns how many went up. Stops between files when `stop` says so.
    pub fn upload_files(&self, store: &Mutex<Store>, t: &dyn Transport, stop: &dyn Fn() -> bool) -> Result<usize> {
        let todo = lock(store).assets_to_upload()?;
        let mut sent = 0;
        for batch in todo.chunks(MAX_BLOB_IDS) {
            let ids: Vec<String> = batch.iter().map(|(sha, _)| self.keys.blob_id(sha)).collect();
            let known: HashMap<String, BlobState> = t.blobs(&ids)?.blobs.into_iter().map(|b| (b.id.clone(), b)).collect();
            for ((sha, _), id) in batch.iter().zip(&ids) {
                if stop() {
                    return Ok(sent);
                }
                let have = match known.get(id) {
                    // Another device uploaded the same file.
                    Some(b) if b.complete => {
                        lock(store).set_asset_uploaded(sha)?;
                        continue;
                    }
                    Some(b) => b.have.clone(),
                    None => Vec::new(),
                };
                // Gone since the list was made (swept).
                let Some((path, _)) = lock(store).asset_file(sha)? else { continue };
                self.upload_one(t, id, &path, &have)?;
                lock(store).set_asset_uploaded(sha)?;
                tracing::info!(asset = %sha, "uploaded a file");
                sent += 1;
            }
        }
        Ok(sent)
    }

    /// Sends the chunks the server lacks, then says the file is whole.
    fn upload_one(&self, t: &dyn Transport, id: &str, path: &std::path::Path, have: &[u32]) -> Result<()> {
        let mut file = std::fs::File::open(path).map_err(io)?;
        let chunks = chunks_for(file.metadata().map_err(io)?.len());
        let mut buf = vec![0u8; CHUNK];
        for n in 0..chunks {
            let len = read_full(&mut file, &mut buf).map_err(io)?;
            if have.contains(&n) {
                continue;
            }
            let sealed = self.keys.seal_chunk(&self.workspace, id, n, n + 1 == chunks, &buf[..len]);
            t.put_chunk(id, n, &sealed)?;
        }
        t.finish_blob(id, chunks)
    }

    /// Downloads one file and keeps it if it is what its hash says. A chunk
    /// that cannot be opened or a hash that does not match fails it, and
    /// nothing is kept.
    pub fn download_file(&self, store: &Mutex<Store>, t: &dyn Transport, sha256: &str, mime: Option<&str>) -> Result<Fetched> {
        let id = self.keys.blob_id(sha256);
        let Some(state) = t.blobs(std::slice::from_ref(&id))?.blobs.into_iter().find(|b| b.id == id && b.complete) else {
            return Ok(Fetched::NotOnServer);
        };
        let dir = lock(store).assets_dir();
        let mut incoming = Incoming::create(&dir)?;
        let written = (0..state.chunks).try_for_each(|n| {
            let sealed = t.get_chunk(&id, n)?;
            let plain = self.keys.open_chunk(&self.workspace, &id, n, n + 1 == state.chunks, &sealed)?;
            incoming.write(&plain).map_err(SyncError::from)
        });
        if let Err(e) = written {
            incoming.discard();
            return Err(e);
        }
        let mime = mime.filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
        let info = lock(store).add_downloaded_asset(incoming, sha256, mime, now_ms())?;
        tracing::info!(asset = %sha256, size = info.size, "downloaded a file");
        Ok(Fetched::Done(info))
    }

    /// Tells the server the files this device uses, when they changed since
    /// the last report or that was long ago. Returns how many of them the
    /// server lacked and were queued to go up again, or None when there was
    /// nothing to report.
    pub fn report_files(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<Option<usize>> {
        let shas = lock(store).used_assets()?;
        let mut ids: Vec<(String, &String)> = shas.iter().map(|sha| (self.keys.blob_id(sha), sha)).collect();
        ids.sort();
        let mut digest = Sha256::new();
        for (id, _) in &ids {
            digest.update(id.as_bytes());
            digest.update(b"\n");
        }
        let digest = digest.finalize();
        let now = now_ms();
        if let Some(last) = lock(store).sync_value(REFS_REPORTED)? {
            if last.len() == 40 && last[..32] == digest[..] {
                let at = i64::from_le_bytes(last[32..].try_into().expect("8 bytes"));
                if now - at < REPORT_EVERY_MS && at <= now {
                    return Ok(None);
                }
            }
        }
        let missing = t.report_refs(&ids.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>())?;
        let by_id: HashMap<&str, &String> = ids.iter().map(|(id, sha)| (id.as_str(), *sha)).collect();
        let s = lock(store);
        let mut requeued = 0;
        for id in &missing {
            if let Some(sha) = by_id.get(id.as_str()) {
                if s.asset_file(sha)?.is_some() {
                    s.set_asset_not_uploaded(sha)?;
                    requeued += 1;
                }
            }
        }
        let mut value = digest.to_vec();
        value.extend_from_slice(&now.to_le_bytes());
        s.set_sync_value(REFS_REPORTED, &value)?;
        if requeued > 0 {
            tracing::info!(files = requeued, "the server lacks files in use here; uploading them again");
        }
        Ok(Some(requeued))
    }

    /// The bytes the workspace's files take on the server.
    pub fn server_file_bytes(&self, t: &dyn Transport) -> Result<i64> {
        Ok(t.blobs(&[])?.total_bytes)
    }
}

/// A download failed because what came was not the file (a chunk would not
/// open, or the hash did not match), rather than because of the network.
pub fn is_damaged(e: &SyncError) -> bool {
    matches!(e, SyncError::Crypto(_) | SyncError::Store(folio_store::StoreError::Damaged(_)))
}
