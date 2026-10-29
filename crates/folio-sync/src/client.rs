//! The client side of sync (design/ARCHITECTURE.md §5.3): push the outbox
//! (local updates, encrypted), pull what other devices pushed after the
//! cursor, apply it through the store's single write path; then report the
//! versions this device now has, collect the other devices' reports
//! (`device_acks`), and now and then compare them (the convergence check):
//! a device that should have what this one has but lacks part of it gets
//! that part sent again.
//!
//! The store lock is held only to read the outbox or to apply a batch, never
//! across a network call, so editing goes on while a sync runs.

use std::sync::Mutex;

use folio_core::{DocId, DocKind};
use folio_store::Store;

use crate::crypto::{b64, unb64, Keys};
use crate::protocol::{Round, AcksResponse, BlobsResponse, DeviceInfo, HeavyDoc, PullResponse, PushItem};
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
    /// Stores version reports, and with the last request of a round, the
    /// round. Returns whether the server took the round (None from a server
    /// that does not say; see `AcksStored`).
    fn push_acks(&self, items: &[PushItem], round: Option<Round>) -> Result<Option<bool>>;
    fn pull_acks(&self, after: i64, limit: u32) -> Result<AcksResponse>;
    fn remove_device(&self, other: &str) -> Result<()>;
    fn heavy_docs(&self) -> Result<Vec<HeavyDoc>>;
    /// Stores a document's snapshot covering its updates up to `covers`;
    /// returns its seq.
    fn push_snapshot(&self, item: &PushItem, covers: i64) -> Result<i64>;
    /// Which of these files the server has (design/attachments.md §5.1).
    fn blobs(&self, ids: &[String]) -> Result<BlobsResponse>;
    fn put_chunk(&self, id: &str, n: u32, sealed: &[u8]) -> Result<()>;
    fn finish_blob(&self, id: &str, chunks: u32) -> Result<()>;
    fn get_chunk(&self, id: &str, n: u32) -> Result<Vec<u8>>;
    /// Reports the files this device uses (replacing its last report);
    /// returns those the server does not have whole.
    fn report_refs(&self, ids: &[String]) -> Result<Vec<String>>;
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
/// `sync_state` key: the pull cursor this device's reports are true as of.
pub const ACKS_THROUGH: &str = "sync.acks.through";
/// `sync_state` key: the number of this device's last round of reports.
const ACKS_ROUND: &str = "sync.acks.round";
/// `sync_state` key: when this device began numbering its rounds.
const ACKS_STARTED: &str = "sync.acks.started";
/// `sync_state` key: when the convergence check last ran (ms).
const CHECKED_AT: &str = "sync.check.at";
/// How often the convergence check runs.
pub const CHECK_EVERY_MS: i64 = 10 * 60 * 1000;

/// `sync_state` key: the version of a document another device had when its
/// lacking part was last sent again (not sent twice for one version).
/// `sync_state` key: when another device began numbering its rounds, as
/// last seen.
fn started_key(device: &str) -> String {
    format!("sync.started.{device}")
}

fn resent_key(device: &str, doc: &DocId) -> String {
    format!("sync.resent.{device}.{doc}")
}

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
    /// Documents the convergence check queued to send again.
    pub resent: usize,
}

/// A device of the workspace, its name opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    /// None until it sent one, or if it cannot be opened.
    pub name: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    /// The cursor its version reports are true as of, and the number of
    /// its last round of them.
    pub acked_through: Option<i64>,
    pub acked_round: Option<i64>,
    pub acked_started: Option<i64>,
    pub acked_docs: Option<i64>,
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

/// Forgets this device's place in a workspace (it left, or was removed and
/// joins again as a new device): cursors and reports start over. Its notes
/// stay; joining queues their whole history again (`Store::queue_everything`).
pub fn forget_workspace(store: &Store) -> Result<()> {
    for key in [CURSOR, ACKS_CURSOR, ACKS_CHANGED, ACKS_THROUGH, ACKS_ROUND, ACKS_STARTED, CHECKED_AT, crate::files::REFS_REPORTED] {
        store.set_sync_value(key, &[])?;
    }
    store.clear_device_acks()?;
    store.forget_uploads()?;
    Ok(())
}

/// After the server went back to an older copy (restored from a backup):
/// sync as a device joining, pulling from the start and sending everything,
/// so nothing sent after that copy stays lost and no reused seq is skipped.
fn start_over(store: &mut Store) -> Result<()> {
    forget_workspace(store)?;
    store.queue_everything(now_ms())?;
    Ok(())
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

pub(crate) fn lock(store: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// One workspace's keys and name; stateless otherwise (the cursor and the
/// outbox live in the store).
pub struct Engine {
    pub(crate) workspace: String,
    pub(crate) keys: Keys,
    check_every: i64,
}

impl Engine {
    pub fn new(workspace: impl Into<String>, keys: Keys) -> Self {
        Engine { workspace: workspace.into(), keys, check_every: CHECK_EVERY_MS }
    }

    /// Runs the convergence check this often instead (0: every sync).
    pub fn with_check_every(mut self, ms: i64) -> Self {
        self.check_every = ms;
        self
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
            if resp.head < cursor {
                tracing::warn!(cursor, head = resp.head, "the server is behind this device; syncing everything again");
                start_over(&mut lock(store))?;
                continue;
            }
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
    /// the last report, then the cursor they are all true as of; returns
    /// how many. Run after a pull to the head: every reported version is
    /// then on the server at or before the cursor. A document with updates
    /// still to send is left for a later round, since its version is not.
    pub fn send_acks(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        let sent = self.send_acks_once(store, t)?;
        let Some((n, accepted)) = sent else { return Ok(0) };
        // The server lacks this device's round before: it was put back to an
        // older copy, which may also have reused seqs this device thinks it
        // has pulled.
        if accepted == Some(false) {
            tracing::warn!("the server lost this device's version reports; syncing everything again");
            start_over(&mut lock(store))?;
        }
        Ok(n)
    }

    /// One round of reports: how many, and whether the server took the
    /// round (when it says).
    fn send_acks_once(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<Option<(usize, Option<bool>)>> {
        let device = t.device();
        let (todo, newest, through, reported, number, started) = {
            let mut s = lock(store);
            let after = read_i64(&s, ACKS_CHANGED, -1)?;
            let unsent = s.outbox_docs()?;
            let mut todo = Vec::new();
            let mut newest = after;
            let mut held = i64::MAX;
            for (id, kind, changed) in s.docs_changed_after(after)? {
                if unsent.contains(&id) {
                    held = held.min(changed);
                    continue;
                }
                newest = newest.max(changed);
                let version = s.doc_version(&id, kind)?;
                // Encodings of one version can differ in peer order.
                let sent = s.device_ack(&id, device)?.and_then(|v| loro::VersionVector::decode(&v).ok());
                if sent != loro::VersionVector::decode(&version).ok() {
                    todo.push((id, kind, version));
                }
            }
            // The held documents are looked at again next time.
            if held != i64::MAX {
                newest = newest.min(held - 1);
            }
            let started = match read_i64(&s, ACKS_STARTED, -1)? {
                -1 => {
                    let now = now_ms();
                    s.set_sync_value(ACKS_STARTED, &now.to_le_bytes())?;
                    now
                }
                at => at,
            };
            (todo, newest, Self::cursor(&s)?, s.sync_value(ACKS_THROUGH)?, read_i64(&s, ACKS_ROUND, 0)? + 1, started)
        };
        let round = Round { through, number, started };
        let chunks: Vec<_> = todo.chunks(PUSH_BATCH as usize).collect();
        let mut accepted = None;
        if chunks.is_empty() {
            if reported.as_deref() == Some(&through.to_le_bytes()[..]) {
                lock(store).set_sync_value(ACKS_CHANGED, &newest.to_le_bytes())?;
                return Ok(None);
            }
            accepted = t.push_acks(&[], Some(round))?;
        }
        for (i, chunk) in chunks.iter().enumerate() {
            let items: Vec<PushItem> = chunk
                .iter()
                .map(|(id, kind, version)| {
                    let tag = self.keys.doc_tag(id.as_str());
                    let blob = self.keys.seal(&self.workspace, &ack_aad(&tag, device), &envelope(*kind, id, version));
                    PushItem { doc: tag, blob: b64(&blob) }
                })
                .collect();
            let last = i + 1 == chunks.len();
            let took = t.push_acks(&items, last.then_some(round))?;
            if last {
                accepted = took;
            }
            let s = lock(store);
            for (id, _, version) in chunk.iter() {
                s.set_device_ack(id, device, version, now_ms())?;
            }
        }
        let s = lock(store);
        s.set_sync_value(ACKS_CHANGED, &newest.to_le_bytes())?;
        s.set_sync_value(ACKS_THROUGH, &through.to_le_bytes())?;
        s.set_sync_value(ACKS_ROUND, &number.to_le_bytes())?;
        Ok(Some((todo.len(), accepted)))
    }

    /// The convergence check (design/ARCHITECTURE.md §5.3). Another
    /// device's reports are true as of its cursor; once that is at or past
    /// this device's own, it has pulled everything this device reported
    /// having. A document it still lacks part of was lost on the way (the
    /// server went back to an older copy, an update never arrived or could
    /// not be applied): what it lacks is queued to send again, once for each
    /// version it reports. Sending twice is harmless; updates import once.
    /// Returns how many were queued.
    pub fn check(&self, store: &Mutex<Store>, devices: &[Device], me: &str) -> Result<usize> {
        let mut s = lock(store);
        let Some(mine) = s.sync_value(ACKS_THROUGH)?.and_then(|v| v.try_into().ok()).map(i64::from_le_bytes) else { return Ok(0) };
        let others: Vec<&Device> = devices.iter().filter(|d| d.id != me && d.acked_through.is_some_and(|t| t >= mine)).collect();
        if others.is_empty() {
            return Ok(0);
        }
        let decode = |b: Vec<u8>| loro::VersionVector::decode(&b).ok();
        let mut queued = 0;
        for (id, _) in s.all_docs()? {
            let Some(have) = s.device_ack(&id, me)?.and_then(decode) else { continue };
            for other in &others {
                let theirs = s.device_ack(&id, &other.id)?.and_then(decode).unwrap_or_default();
                if theirs.includes_vv(&have) {
                    continue;
                }
                let key = resent_key(&other.id, &id);
                let version = theirs.encode();
                if s.sync_value(&key)?.as_deref() == Some(&version[..]) {
                    continue;
                }
                let Some(bytes) = s.doc_updates_since(&id, &theirs)? else { continue };
                tracing::warn!(doc = %id, device = %other.id, "convergence check: a device lacks part of a document; sending it again");
                s.queue_update(&id, &bytes, now_ms())?;
                s.set_sync_value(&key, &version)?;
                queued += 1;
            }
        }
        Ok(queued)
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

    /// Replaces the server's log of each document it says is long with the
    /// document's full snapshot (§5.3); returns how many. The snapshot holds
    /// every update this device has applied, so it covers the server's log
    /// up to the pull cursor. A document with an update still waiting for
    /// another is left for later.
    pub fn upload_snapshots(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        let heavy = t.heavy_docs()?;
        if heavy.is_empty() {
            return Ok(0);
        }
        let (covers, docs) = {
            let s = lock(store);
            (Self::cursor(&s)?, s.all_docs()?)
        };
        let by_tag: std::collections::HashMap<String, (DocId, DocKind)> =
            docs.into_iter().map(|(id, kind)| (self.keys.doc_tag(id.as_str()), (id, kind))).collect();
        let mut sent = 0;
        for h in heavy {
            // Not here yet: it arrives with a later pull.
            let Some((id, kind)) = by_tag.get(&h.doc) else { continue };
            let Some(snapshot) = lock(store).settled_snapshot(id)? else { continue };
            let blob = self.keys.seal(&self.workspace, &h.doc, &envelope(*kind, id, &snapshot));
            t.push_snapshot(&PushItem { doc: h.doc.clone(), blob: b64(&blob) }, covers)?;
            tracing::info!(doc = %id, updates = h.updates, bytes = h.bytes, snapshot = snapshot.len(), "replaced the server's log with a snapshot");
            sent += 1;
        }
        Ok(sent)
    }

    /// Removes another device from the workspace.
    pub fn remove_device(&self, t: &dyn Transport, other: &str) -> Result<()> {
        t.remove_device(other)
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
                Device { id: d.device, name, first_seen: d.first_seen, last_seen: d.last_seen, acked_through: d.acked_through, acked_round: d.acked_round, acked_started: d.acked_started, acked_docs: d.acked_docs }
            })
            .collect())
    }

    /// Push, pull, then exchange version reports and, when due, run the
    /// convergence check. A failed report does not fail the sync (an older
    /// server may not take them); it is in the report.
    pub fn sync(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<Report> {
        let pushed = self.push(store, t)?;
        let (pulled, applied) = self.pull(store, t)?;
        let (resent, acks_error) = match self.exchange_acks(store, t) {
            Ok(n) => (n, None),
            Err(e) => (0, Some(e.to_string())),
        };
        Ok(Report { pushed, pulled, applied, acks_error, resent })
    }

    fn exchange_acks(&self, store: &Mutex<Store>, t: &dyn Transport) -> Result<usize> {
        self.send_acks(store, t)?;
        let due = now_ms() - read_i64(&lock(store), CHECKED_AT, 0)? >= self.check_every;
        // The devices (with their cursors) before their reports: a device
        // sends its cursor after its reports, so every report a cursor
        // vouches for is collected below.
        let devices = if due { Some(self.devices(t)?) } else { None };
        // The server behind on this device's rounds (or on another count of
        // them), or holding fewer of its reports than it sent, went back to
        // an older copy; a device with nothing new to report would not see
        // it otherwise. It can be one round ahead: the reply to that round
        // was lost (and then the round sent again may hold other reports,
        // which only the count tells lost).
        let lost = match devices.iter().flatten().find(|d| d.id == t.device()) {
            Some(me) => {
                let s = lock(store);
                let started = read_i64(&s, ACKS_STARTED, -1)?;
                let behind = me.acked_started.is_some()
                    && started != -1
                    && (me.acked_started != Some(started) || me.acked_round.unwrap_or(-1) < read_i64(&s, ACKS_ROUND, -1)?);
                let sent = s.device_ack_count(t.device())?;
                behind || me.acked_docs.is_some_and(|n| n < sent)
            }
            None => false,
        };
        if lost {
            tracing::warn!("the server lost this device's version reports; syncing everything again");
            start_over(&mut lock(store))?;
            return Ok(0);
        }
        if let Some(devices) = &devices {
            self.notice_restarted_rounds(&lock(store), devices, t.device())?;
        }
        self.pull_acks(store, t)?;
        let Some(devices) = devices else { return Ok(0) };
        let resent = self.check(store, &devices, t.device())?;
        lock(store).set_sync_value(CHECKED_AT, &now_ms().to_le_bytes())?;
        Ok(resent)
    }

    /// Another device that began numbering its rounds anew started over
    /// (the server went back to an older copy, or it restored a backup) and
    /// sent its reports again, possibly under sequence numbers this device's
    /// acks cursor has passed: collects every report again (each replacing
    /// the one held).
    fn notice_restarted_rounds(&self, store: &Store, devices: &[Device], me: &str) -> Result<()> {
        let mut restarted = false;
        for d in devices.iter().filter(|d| d.id != me) {
            let Some(started) = d.acked_started else { continue };
            let key = started_key(&d.id);
            let seen = read_i64(store, &key, started)?;
            restarted |= seen != started;
            store.set_sync_value(&key, &started.to_le_bytes())?;
        }
        if restarted {
            tracing::info!("a device started its version reports over; collecting all reports again");
            store.set_sync_value(ACKS_CURSOR, &[])?;
        }
        Ok(())
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
