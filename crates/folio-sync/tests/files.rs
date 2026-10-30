//! Images and attachments through the relay (design/attachments.md §5, §10):
//! a file added on one device reaches another whole and checked; the same
//! file is stored once; an upload cut off goes on where it stopped; a server
//! that hands out the wrong bytes is caught.

use std::cell::Cell;
use std::sync::Mutex;

use folio_core::body::add_block;
use folio_core::card::{init_card, CardKind};
use folio_core::{DocId, DocKind};
use folio_store::{Incoming, Origin, Store};
use folio_sync::client::{Engine, Transport};
use folio_sync::crypto::{Keys, WorkspaceKey, CHUNK};
use folio_sync::files::{is_damaged, Fetched};
use folio_sync::protocol::{Round, AcksResponse, BlobsResponse, DeviceInfo, HeavyDoc, PullResponse, PushItem};
use folio_sync::relay::Relay;
use folio_sync::SyncError;
use loro::LoroValue;

const WS: &str = "files-ws";

/// The relay called directly, with ways to make it misbehave.
struct Direct<'a> {
    relay: &'a Relay,
    device: String,
    /// Chunk uploads that fail before this one goes through (a dropped
    /// connection), counted down.
    fail_put_after: Cell<Option<usize>>,
    /// Flip a byte in every chunk handed out.
    tamper: bool,
    puts: Cell<usize>,
}

fn direct<'a>(relay: &'a Relay, device: &str) -> Direct<'a> {
    Direct { relay, device: device.into(), fail_put_after: Cell::new(None), tamper: false, puts: Cell::new(0) }
}

impl Transport for Direct<'_> {
    fn device(&self) -> &str {
        &self.device
    }
    fn push(&self, items: &[PushItem]) -> folio_sync::Result<i64> {
        self.relay.push(WS, &self.device, items)
    }
    fn pull(&self, after: i64, limit: u32) -> folio_sync::Result<PullResponse> {
        self.relay.pull(WS, &self.device, after, limit)
    }
    fn set_device_name(&self, sealed: &[u8]) -> folio_sync::Result<()> {
        self.relay.set_device_name(WS, &self.device, sealed)
    }
    fn devices(&self) -> folio_sync::Result<Vec<DeviceInfo>> {
        self.relay.devices(WS, &self.device)
    }
    fn push_acks(&self, items: &[PushItem], round: Option<Round>) -> folio_sync::Result<Option<bool>> {
        self.relay.push_acks(WS, &self.device, items, round).map(Some)
    }
    fn pull_acks(&self, after: i64, limit: u32) -> folio_sync::Result<AcksResponse> {
        self.relay.pull_acks(WS, &self.device, after, limit)
    }
    fn remove_device(&self, other: &str) -> folio_sync::Result<()> {
        self.relay.remove_device(WS, &self.device, other)
    }
    fn heavy_docs(&self) -> folio_sync::Result<Vec<HeavyDoc>> {
        self.relay.heavy_docs(WS, &self.device)
    }
    fn push_snapshot(&self, item: &PushItem, covers: i64) -> folio_sync::Result<i64> {
        self.relay.push_snapshot(WS, &self.device, item, covers)
    }
    fn blobs(&self, ids: &[String]) -> folio_sync::Result<BlobsResponse> {
        self.relay.blobs(WS, &self.device, ids)
    }
    fn put_chunk(&self, id: &str, n: u32, sealed: &[u8]) -> folio_sync::Result<()> {
        if let Some(left) = self.fail_put_after.get() {
            if left == 0 {
                self.fail_put_after.set(None);
                return Err(SyncError::Network("connection reset".into()));
            }
            self.fail_put_after.set(Some(left - 1));
        }
        self.puts.set(self.puts.get() + 1);
        self.relay.put_chunk(WS, &self.device, id, n, sealed)
    }
    fn finish_blob(&self, id: &str, chunks: u32) -> folio_sync::Result<()> {
        self.relay.finish_blob(WS, &self.device, id, chunks)
    }
    fn purge(&self, docs: &[String]) -> folio_sync::Result<()> {
        self.relay.purge(WS, &self.device, docs)
    }
    fn report_refs(&self, ids: &[String]) -> folio_sync::Result<Vec<String>> {
        self.relay.report_refs(WS, &self.device, ids)
    }
    fn get_chunk(&self, id: &str, n: u32) -> folio_sync::Result<Vec<u8>> {
        let mut bytes = self.relay.get_chunk(WS, &self.device, id, n)?;
        if self.tamper {
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
        }
        Ok(bytes)
    }
}

/// Bytes that differ chunk by chunk, so a swapped chunk would show.
fn content(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| (i / 7) as u8 ^ seed ^ (i / CHUNK) as u8).collect()
}

fn add_file(s: &Mutex<Store>, bytes: &[u8]) -> String {
    let mut s = s.lock().unwrap();
    let mut inc = Incoming::create(&s.assets_dir()).unwrap();
    inc.write(bytes).unwrap();
    s.add_asset(inc, "photo.jpg", "image/jpeg", 1).unwrap().sha256
}

fn card_with(s: &Mutex<Store>, sha256: &str) -> DocId {
    let id = DocId::new_card();
    let doc = loro::LoroDoc::new();
    init_card(&doc, CardKind::Note, "有图的卡片", 1).unwrap();
    add_block(&doc, None, "image", &[("asset", LoroValue::from(sha256)), ("mime", LoroValue::from("image/jpeg"))]).unwrap();
    doc.commit();
    let bytes = doc.export(loro::ExportMode::all_updates()).unwrap();
    s.lock().unwrap().apply_update(&id, DocKind::Card, &bytes, Origin::Local, 2).unwrap();
    id
}

fn store() -> (tempfile::TempDir, Mutex<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let s = Mutex::new(Store::open(dir.path()).unwrap());
    (dir, s)
}

fn setup() -> (Relay, Engine, Keys) {
    let relay = Relay::open_in_memory().unwrap();
    let key = WorkspaceKey::generate();
    relay.create_workspace(WS, &folio_sync::crypto::wrap(&key, "passphrase", (1024, 1, 1)).unwrap()).unwrap();
    (relay, Engine::new(WS, Keys::derive(&key)), Keys::derive(&key))
}

#[test]
fn a_file_reaches_another_device_whole() {
    let (relay, engine, keys) = setup();
    let ((_da, a), (_db, b)) = (store(), store());
    let (ta, tb) = (direct(&relay, "a"), direct(&relay, "b"));
    let bytes = content(2 * CHUNK + 12_345, 1);
    let sha = add_file(&a, &bytes);
    card_with(&a, &sha);

    // Documents and files go separately: the card arrives first.
    engine.sync(&a, &ta).unwrap();
    engine.sync(&b, &tb).unwrap();
    assert_eq!(b.lock().unwrap().missing_assets().unwrap(), vec![(sha.clone(), Some("image/jpeg".into()))]);
    assert_eq!(engine.download_file(&b, &tb, &sha, Some("image/jpeg")).unwrap(), Fetched::NotOnServer);

    assert_eq!(engine.upload_files(&a, &ta, &|| false).unwrap(), 1);
    assert_eq!(ta.puts.get(), 3, "three chunks");
    assert!(a.lock().unwrap().assets_to_upload().unwrap().is_empty());
    assert_eq!(engine.upload_files(&a, &ta, &|| false).unwrap(), 0, "nothing more to send");

    let Fetched::Done(info) = engine.download_file(&b, &tb, &sha, Some("image/jpeg")).unwrap() else { panic!("not downloaded") };
    assert_eq!((info.sha256.as_str(), info.size), (sha.as_str(), bytes.len() as u64));
    let (path, mime) = b.lock().unwrap().asset_file(&sha).unwrap().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(mime, "image/jpeg");
    assert!(b.lock().unwrap().missing_assets().unwrap().is_empty());
    // B does not send it back up.
    assert!(b.lock().unwrap().assets_to_upload().unwrap().is_empty());

    // The server holds sealed chunks under an id that is not the hash.
    let id = keys.blob_id(&sha);
    assert!(!id.contains(&sha[..32]));
    let stored = relay.blobs(WS, "a", &[]).unwrap().total_bytes;
    assert!(stored as usize > bytes.len(), "padded and sealed: {stored}");
    let first = relay.get_chunk(WS, "a", &id, 0).unwrap();
    assert!(!first.windows(32).any(|w| w == &bytes[..32]), "the content is not in the clear");
    assert!(matches!(relay.get_chunk(WS, "a", &id, 3), Err(SyncError::NotFound(_))), "only three chunks");
}

#[test]
fn the_same_file_goes_up_once() {
    let (relay, engine, _) = setup();
    let ((_da, a), (_db, b)) = (store(), store());
    let (ta, tb) = (direct(&relay, "a"), direct(&relay, "b"));
    let bytes = content(1000, 2);
    add_file(&a, &bytes);
    add_file(&b, &bytes);
    assert_eq!(engine.upload_files(&a, &ta, &|| false).unwrap(), 1);
    assert_eq!(engine.upload_files(&b, &tb, &|| false).unwrap(), 0, "already there");
    assert_eq!(tb.puts.get(), 0);
    assert!(b.lock().unwrap().assets_to_upload().unwrap().is_empty());
}

#[test]
fn an_upload_cut_off_goes_on_where_it_stopped() {
    let (relay, engine, _) = setup();
    let ((_da, a), (_db, b)) = (store(), store());
    let (ta, tb) = (direct(&relay, "a"), direct(&relay, "b"));
    let bytes = content(3 * CHUNK + 1, 3);
    let sha = add_file(&a, &bytes);
    ta.fail_put_after.set(Some(2));
    assert!(matches!(engine.upload_files(&a, &ta, &|| false), Err(SyncError::Network(_))));
    assert_eq!(a.lock().unwrap().assets_to_upload().unwrap().len(), 1, "still to do");
    assert_eq!(engine.download_file(&b, &tb, &sha, None).unwrap(), Fetched::NotOnServer, "half a file is not handed out");
    assert_eq!(engine.upload_files(&a, &ta, &|| false).unwrap(), 1);
    assert_eq!(ta.puts.get(), 4, "two chunks, then the other two");
    assert!(matches!(engine.download_file(&b, &tb, &sha, None).unwrap(), Fetched::Done(_)));
}

#[test]
fn wrong_bytes_from_the_server_are_not_kept() {
    let (relay, engine, _) = setup();
    let ((_da, a), (_db, b)) = (store(), store());
    let ta = direct(&relay, "a");
    let mut tb = direct(&relay, "b");
    tb.tamper = true;
    let sha = add_file(&a, &content(5000, 4));
    engine.upload_files(&a, &ta, &|| false).unwrap();
    let e = engine.download_file(&b, &tb, &sha, None).unwrap_err();
    assert!(is_damaged(&e), "{e}");
    assert!(b.lock().unwrap().asset_file(&sha).unwrap().is_none());
    let incoming = b.lock().unwrap().assets_dir().join(".incoming");
    assert_eq!(std::fs::read_dir(incoming).unwrap().count(), 0, "nothing left behind");

    // Another workspace's key opens nothing either.
    let stranger = Engine::new(WS, Keys::derive(&WorkspaceKey::generate()));
    assert_eq!(stranger.download_file(&b, &direct(&relay, "b"), &sha, None).unwrap(), Fetched::NotOnServer, "its ids differ");
}

#[test]
fn a_file_in_use_that_the_server_lost_goes_up_again() {
    let (relay, engine, keys) = setup();
    let (_da, a) = store();
    let ta = direct(&relay, "a");
    let sha = add_file(&a, &content(1000, 5));
    card_with(&a, &sha);
    engine.upload_files(&a, &ta, &|| false).unwrap();
    assert_eq!(engine.report_files(&a, &ta).unwrap(), Some(0));
    assert_eq!(engine.report_files(&a, &ta).unwrap(), None, "nothing new to report");

    // The server deletes it (as if no device had used it for 30 days).
    relay.report_refs(WS, "a", &[]).unwrap();
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    relay.sweep_unused(t).unwrap();
    relay.report_refs(WS, "a", &[]).unwrap();
    assert_eq!(relay.sweep_unused(t + folio_sync::relay::UNUSED_GRACE_MS + 1).unwrap(), 1);
    assert!(relay.blobs(WS, "a", &[keys.blob_id(&sha)]).unwrap().blobs.is_empty());

    // The next report (forced here by forgetting the last) finds it gone.
    a.lock().unwrap().set_sync_value(folio_sync::files::REFS_REPORTED, &[]).unwrap();
    assert_eq!(engine.report_files(&a, &ta).unwrap(), Some(1));
    assert_eq!(engine.upload_files(&a, &ta, &|| false).unwrap(), 1);
    assert_eq!(relay.blobs(WS, "a", &[keys.blob_id(&sha)]).unwrap().blobs.len(), 1);
}
