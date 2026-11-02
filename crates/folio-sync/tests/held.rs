//! An update another device's copy of a document refuses (Loro cannot
//! import it there) is kept aside on that device; it must not stop the
//! updates after it, nor every sync from then on.

use std::sync::Mutex;

use loro::{ExportMode, LoroDoc};
use folio_core::{DocId, DocKind};
use folio_store::{Origin, Store};
use folio_sync::client::{Engine, Transport};
use folio_sync::crypto::{Keys, WorkspaceKey};
use folio_sync::protocol::{AcksResponse, BlobsResponse, DeviceInfo, HeavyDoc, PullResponse, PushItem, Round};
use folio_sync::relay::Relay;

const WS: &str = "held-workspace";

struct Direct<'a> {
    relay: &'a Relay,
    device: &'a str,
}

impl Transport for Direct<'_> {
    fn device(&self) -> &str {
        self.device
    }
    fn push(&self, items: &[PushItem]) -> folio_sync::Result<i64> {
        self.relay.push(WS, self.device, items)
    }
    fn pull(&self, after: i64, limit: u32) -> folio_sync::Result<PullResponse> {
        self.relay.pull(WS, self.device, after, limit)
    }
    fn set_device_name(&self, sealed: &[u8]) -> folio_sync::Result<()> {
        self.relay.set_device_name(WS, self.device, sealed)
    }
    fn devices(&self) -> folio_sync::Result<Vec<DeviceInfo>> {
        self.relay.devices(WS, self.device)
    }
    fn push_acks(&self, items: &[PushItem], round: Option<Round>) -> folio_sync::Result<Option<bool>> {
        self.relay.push_acks(WS, self.device, items, round).map(Some)
    }
    fn pull_acks(&self, after: i64, limit: u32) -> folio_sync::Result<AcksResponse> {
        self.relay.pull_acks(WS, self.device, after, limit)
    }
    fn remove_device(&self, other: &str) -> folio_sync::Result<()> {
        self.relay.remove_device(WS, self.device, other)
    }
    fn heavy_docs(&self) -> folio_sync::Result<Vec<HeavyDoc>> {
        self.relay.heavy_docs(WS, self.device)
    }
    fn push_snapshot(&self, item: &PushItem, covers: i64) -> folio_sync::Result<i64> {
        self.relay.push_snapshot(WS, self.device, item, covers)
    }
    fn blobs(&self, ids: &[String]) -> folio_sync::Result<BlobsResponse> {
        self.relay.blobs(WS, self.device, ids)
    }
    fn put_chunk(&self, id: &str, n: u32, sealed: &[u8]) -> folio_sync::Result<()> {
        self.relay.put_chunk(WS, self.device, id, n, sealed)
    }
    fn finish_blob(&self, id: &str, chunks: u32) -> folio_sync::Result<()> {
        self.relay.finish_blob(WS, self.device, id, chunks)
    }
    fn purge(&self, docs: &[String]) -> folio_sync::Result<()> {
        self.relay.purge(WS, self.device, docs)
    }
    fn report_refs(&self, ids: &[String]) -> folio_sync::Result<Vec<String>> {
        self.relay.report_refs(WS, self.device, ids)
    }
    fn get_chunk(&self, id: &str, n: u32) -> folio_sync::Result<Vec<u8>> {
        self.relay.get_chunk(WS, self.device, id, n)
    }
}

fn store() -> (Mutex<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    (Mutex::new(Store::open(dir.path()).unwrap()), dir)
}

fn text(s: &Mutex<Store>, id: &DocId) -> String {
    let snap = s.lock().unwrap().doc_snapshot(id).unwrap();
    let doc = LoroDoc::new();
    doc.import(&snap).unwrap();
    doc.get_text("t").to_string()
}

#[test]
fn a_refused_update_is_kept_aside_and_sync_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let relay = Relay::open(&dir.path().join("relay.db")).unwrap();
    let key = WorkspaceKey::generate();
    relay.create_workspace(WS, &folio_sync::crypto::wrap(&key, "test", (1024, 1, 1)).unwrap()).unwrap();
    let engine = Engine::new(WS, Keys::derive(&key));
    let (a, _da) = store();
    let (b, _db) = store();
    let (c, _dc) = store();
    let sync = |s: &Mutex<Store>, name: &str| engine.sync(s, &Direct { relay: &relay, device: name }).unwrap();

    // A document written by one editor (peer 7), on every device.
    let id = DocId::new_card();
    let editor = LoroDoc::new();
    editor.set_peer_id(7).unwrap();
    editor.get_text("t").insert(0, "hello").unwrap();
    editor.commit();
    let base = editor.oplog_vv();
    a.lock().unwrap().apply_update(&id, DocKind::Card, &editor.export(ExportMode::all_updates()).unwrap(), Origin::Local, 1).unwrap();
    sync(&a, "a");
    sync(&b, "b");
    sync(&c, "c");

    // A goes on with the editor, B gets it. On C the same peer writes
    // something else from the older copy: its op ids are already used.
    editor.get_text("t").insert(5, " world").unwrap();
    editor.commit();
    a.lock().unwrap().apply_update(&id, DocKind::Card, &editor.export(ExportMode::updates(&base)).unwrap(), Origin::Local, 2).unwrap();
    sync(&a, "a");
    sync(&b, "b");
    let stale = LoroDoc::new();
    stale.set_peer_id(7).unwrap();
    stale.import(&c.lock().unwrap().doc_snapshot(&id).unwrap()).unwrap();
    stale.get_text("t").insert(5, ", everyone here").unwrap();
    stale.commit();
    c.lock().unwrap().apply_update(&id, DocKind::Card, &stale.export(ExportMode::updates(&base)).unwrap(), Origin::Local, 3).unwrap();
    sync(&c, "c");

    // And then a new card on A, after it on the server.
    let other = a.lock().unwrap().create_card(folio_core::card::CardKind::Note, "after", 4).unwrap();
    sync(&a, "a");

    // B keeps C's update aside, takes the card after it, and syncs again.
    let report = sync(&b, "b");
    assert_eq!(Engine::held(&b).unwrap(), 1);
    assert!(report.applied.iter().any(|x| x.doc == other));
    assert_eq!(text(&b, &id), "hello world");
    sync(&b, "b");
    assert_eq!(Engine::held(&b).unwrap(), 1, "tried again, not kept twice");

    // A further edit from A still goes through on B.
    let v = editor.oplog_vv();
    editor.get_text("t").insert(11, "!").unwrap();
    editor.commit();
    a.lock().unwrap().apply_update(&id, DocKind::Card, &editor.export(ExportMode::updates(&v)).unwrap(), Origin::Local, 5).unwrap();
    sync(&a, "a");
    sync(&b, "b");
    assert_eq!(text(&b, &id), "hello world!");
}
