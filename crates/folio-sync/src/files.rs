//! Images and attachments in sync (design/attachments.md §5): files go up
//! sealed in chunks under an id the server cannot link to their hash, and
//! come down the same way, checked against the hash before they are kept.
//!
//! Files have their own queue, apart from documents: a sync of edits never
//! waits for a file. The store lock is held only to read or record state;
//! files are read and written outside it (stored files never change).

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use folio_store::{AssetInfo, Incoming, Store};

use crate::client::{lock, now_ms, Engine, Transport};
use crate::crypto::{chunks_for, CHUNK};
use crate::protocol::{BlobState, MAX_BLOB_IDS};
use crate::{Result, SyncError};

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
