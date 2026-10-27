//! The client side of sync (design/ARCHITECTURE.md §5.3): push the outbox
//! (local updates, encrypted), pull what other devices pushed after the
//! cursor, apply it through the store's single write path; then report the
//! versions this device now has and collect the other devices' reports
//! (`device_acks`, which compaction goes by).
//!
//! The store lock is held only to read the outbox or to apply a batch, never
//! across a network call, so editing goes on while a sync runs.

use std::sync::Mutex;

use folio_core::{DocId, DocKind};
use folio_store::Store;

use crate::crypto::{b64, unb64, Keys};
use crate::protocol::{AcksResponse, DeviceInfo, PullResponse, PushItem};
use crate::{Result, SyncError};

/// The server's side of the conversation; HTTP in the app, the relay
/// itself in the simulator.
pub trait Transport {
    /// The device the requests are made as.
    fn device(&self) -> &str;
    /// Stores updates; returns the new head.
    fn push(&self, items: &[PushItem]) -> Result<i64>;
    fn pull(&self, after: i64, limit: u32) -> Result<PullResponse>;
    fn set_device_name(&self, sealed: &[u8]) -> Result<()>;
    fn devices(&self) -> Result<Vec<DeviceInfo>>;
    fn push_acks(&self, items: &[PushItem]) -> Result<()>;
    fn pull_acks(&self, after: i64, limit: u32) -> Result<AcksResponse>;
}

/// Updates sent per push.
const PUSH_BATCH: u32 = 200;
/// Updates asked for per pull.
const PULL_BATCH: u32 = 500;
/// `sync_state` key of the pull cursor: the last sequence applied.
pub const CURSOR: &str = "sync.cursor";
/// `sync_state` key of the acks cursor: the last report collected.
pub const ACKS_CURSOR: &str = "sync.acks.cursor";
/// `sync_state` key: documents written after this change number
/// (`docs.changed`) may have a version not yet reported.
pub const ACKS_CHANGED: &str = "sync.acks.changed";

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
    /// Reporting versions failed (the sync itself went through).
    pub acks_error: Option<String>,
}

/// A device of the workspace, its name opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    /// None until it sent one, or if it cannot be opened.
    pub name: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
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

fn read_i64(store: &Store, key: &str, default: i64) -> Result<i64> {
    Ok(store.sync_value(key)?.and_then(|v| v.try_into().ok()).map(i64::from_le_bytes).unwrap_or(default))
}

/// What a report or a name is sealed with besides the workspace: bound to
/// the device, so the server cannot pass one device's off as another's.
fn ack_aad(tag: &str, device: &str) -> String {
    format!("{tag}\nack\n{device}")
}

fn name_aad(device: &str) -> String {
    format!("device\n{device}")
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

    /// Reports the version this device has of each document written since
    /// the last report; returns how many.
    pub fn send_acks(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        let device = t.device();
        let (todo, newest) = {
            let mut s = lock(store);
            let after = read_i64(&s, ACKS_CHANGED, -1)?;
            let mut todo = Vec::new();
            let mut newest = after;
            for (id, kind, changed) in s.docs_changed_after(after)? {
                newest = newest.max(changed);
                let version = s.doc_version(&id, kind)?;
                // Encodings of one version can differ in peer order.
                let sent = s.device_ack(&id, device)?.and_then(|v| loro::VersionVector::decode(&v).ok());
                if sent != loro::VersionVector::decode(&version).ok() {
                    todo.push((id, kind, version));
                }
            }
            (todo, newest)
        };
        for chunk in todo.chunks(PUSH_BATCH as usize) {
            let items: Vec<PushItem> = chunk
                .iter()
                .map(|(id, kind, version)| {
                    let tag = self.keys.doc_tag(id.as_str());
                    let blob = self.keys.seal(&self.workspace, &ack_aad(&tag, device), &envelope(*kind, id, version));
                    PushItem { doc: tag, blob: b64(&blob) }
                })
                .collect();
            t.push_acks(&items)?;
            let s = lock(store);
            for (id, _, version) in chunk {
                s.set_device_ack(id, device, version, now_ms())?;
            }
        }
        lock(store).set_sync_value(ACKS_CHANGED, &newest.to_le_bytes())?;
        Ok(todo.len())
    }

    /// Collects the other devices' reports after the acks cursor; returns
    /// how many. One that cannot be opened stops it, as in `pull`.
    pub fn pull_acks(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        let mut pulled = 0;
        loop {
            let cursor = read_i64(&lock(store), ACKS_CURSOR, 0)?;
            let resp = t.pull_acks(cursor, PULL_BATCH)?;
            let Some(last) = resp.acks.last().map(|a| a.seq) else { return Ok(pulled) };
            let mut opened = Vec::with_capacity(resp.acks.len());
            for a in resp.acks.iter().filter(|a| a.device != t.device()) {
                let plain = self.keys.open(&self.workspace, &ack_aad(&a.doc, &a.device), &unb64(&a.blob)?)?;
                opened.push((a.device.clone(), plain));
            }
            {
                let s = lock(store);
                for (device, plain) in &opened {
                    let (_, doc, version) = open_envelope(plain)?;
                    loro::VersionVector::decode(version).map_err(|e| SyncError::Protocol(format!("bad version: {e}")))?;
                    s.set_device_ack(&doc, device, version, now_ms())?;
                }
                s.set_sync_value(ACKS_CURSOR, &last.to_le_bytes())?;
            }
            pulled += resp.acks.len();
            if last >= resp.head {
                return Ok(pulled);
            }
        }
    }

    /// Sends this device's name, sealed.
    pub fn set_device_name(&self, t: &dyn Transport, name: &str) -> Result<()> {
        t.set_device_name(&self.keys.seal(&self.workspace, &name_aad(t.device()), name.as_bytes()))
    }

    /// The workspace's devices, names opened.
    pub fn devices(&self, t: &dyn Transport) -> Result<Vec<Device>> {
        Ok(t.devices()?
            .into_iter()
            .map(|d| {
                let name = d
                    .name
                    .and_then(|n| unb64(&n).ok())
                    .and_then(|n| self.keys.open(&self.workspace, &name_aad(&d.device), &n).ok())
                    .and_then(|n| String::from_utf8(n).ok());
                Device { id: d.device, name, first_seen: d.first_seen, last_seen: d.last_seen }
            })
            .collect())
    }

    /// Push, pull, then exchange version reports. A failed report does not
    /// fail the sync (an older server may not take them); it is in the
    /// report.
    pub fn sync(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<Report> {
        let pushed = self.push(store, t)?;
        let (pulled, applied) = self.pull(store, t)?;
        let acks_error = self.send_acks(store, t).and_then(|_| self.pull_acks(store, t)).err().map(|e| e.to_string());
        Ok(Report { pushed, pulled, applied, acks_error })
    }

    pub fn cursor(store: &Store) -> Result<i64> {
        read_i64(store, CURSOR, 0)
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
