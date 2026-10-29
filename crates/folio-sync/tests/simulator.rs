//! The sync simulator (design/ARCHITECTURE.md §8, M3 acceptance): devices
//! with their own stores edit at random, go offline and come back, and sync
//! through the relay. Along the way: replies lost on the network, logs
//! folded into snapshots on the server and on the devices, editors holding
//! unsaved edits, libraries restored from a backup, devices removed and
//! joining again, one device away for a long stretch, and the server itself
//! put back to an older copy. However the steps fall, every document must
//! end the same on every device.
//!
//! The quick run is part of the tests; the long one (100 000 steps) is
//! ignored by default:
//!
//!     cargo test --release -p folio-sync --test simulator -- --ignored --nocapture

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use loro::{Container, ExportMode, LoroDoc, LoroValue, TreeID, TreeParentId, ValueOrContainer};
use folio_core::body::{add_block, push_text, tree, TEXTBLOCKS};
use folio_core::card::{init_card, CardKind};
use folio_core::{DocId, DocKind};
use folio_store::backup::{backups_dir, list_backups, replace_library};
use folio_store::{Origin, Store};
use folio_sync::client::{forget_workspace, Engine, Report, Transport};
use folio_sync::SyncError;
use folio_sync::crypto::{Keys, WorkspaceKey};
use folio_sync::protocol::{Round, AcksResponse, BlobsResponse, DeviceInfo, HeavyDoc, PullResponse, PushItem};
use folio_sync::relay::Relay;

const WS: &str = "sim-workspace";

/// Deterministic randomness, so a failure can be replayed by its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// The relay, called directly; with `faults`, now and then the reply to a
/// request is lost on the way back (the server did the work, the device
/// does not know it), or a request never arrives.
struct Direct<'a> {
    relay: &'a Relay,
    device: String,
    faults: Option<Cell<u64>>,
}

impl<'a> Direct<'a> {
    fn new(relay: &'a Relay, device: &str) -> Self {
        Direct { relay, device: device.to_owned(), faults: None }
    }

    fn flaky(relay: &'a Relay, device: &str, seed: u64) -> Self {
        Direct { relay, device: device.to_owned(), faults: Some(Cell::new(seed | 1)) }
    }

    /// One request in twenty fails.
    fn fails(&self) -> bool {
        let Some(state) = &self.faults else { return false };
        let mut rng = Rng(state.get());
        let fail = rng.chance(5);
        state.set(rng.0);
        fail
    }

    /// Runs a request; its reply may be lost.
    fn reply<T>(&self, r: folio_sync::Result<T>) -> folio_sync::Result<T> {
        if r.is_ok() && self.fails() {
            return Err(SyncError::Network("reply lost".into()));
        }
        r
    }

    fn arrive(&self) -> folio_sync::Result<()> {
        if self.fails() {
            return Err(SyncError::Network("request lost".into()));
        }
        Ok(())
    }
}

impl Transport for Direct<'_> {
    fn device(&self) -> &str {
        &self.device
    }
    fn push(&self, items: &[PushItem]) -> folio_sync::Result<i64> {
        self.arrive()?;
        self.reply(self.relay.push(WS, &self.device, items))
    }
    fn pull(&self, after: i64, limit: u32) -> folio_sync::Result<PullResponse> {
        self.arrive()?;
        self.reply(self.relay.pull(WS, &self.device, after, limit))
    }
    fn set_device_name(&self, sealed: &[u8]) -> folio_sync::Result<()> {
        self.relay.set_device_name(WS, &self.device, sealed)
    }
    fn devices(&self) -> folio_sync::Result<Vec<DeviceInfo>> {
        self.relay.devices(WS, &self.device)
    }
    fn push_acks(&self, items: &[PushItem], round: Option<Round>) -> folio_sync::Result<Option<bool>> {
        self.arrive()?;
        self.reply(self.relay.push_acks(WS, &self.device, items, round).map(Some))
    }
    fn pull_acks(&self, after: i64, limit: u32) -> folio_sync::Result<AcksResponse> {
        self.arrive()?;
        self.reply(self.relay.pull_acks(WS, &self.device, after, limit))
    }
    fn remove_device(&self, other: &str) -> folio_sync::Result<()> {
        self.relay.remove_device(WS, &self.device, other)
    }
    fn heavy_docs(&self) -> folio_sync::Result<Vec<HeavyDoc>> {
        self.relay.heavy_docs(WS, &self.device)
    }
    fn push_snapshot(&self, item: &PushItem, covers: i64) -> folio_sync::Result<i64> {
        self.arrive()?;
        self.reply(self.relay.push_snapshot(WS, &self.device, item, covers))
    }
    fn blobs(&self, ids: &[String]) -> folio_sync::Result<BlobsResponse> {
        self.relay.blobs(WS, &self.device, ids)
    }
    fn put_chunk(&self, id: &str, n: u32, sealed: &[u8]) -> folio_sync::Result<()> {
        self.relay.put_chunk(WS, &self.device, id, n, sealed)
    }
    fn finish_blob(&self, id: &str, chunks: u32) -> folio_sync::Result<()> {
        self.relay.finish_blob(WS, &self.device, id, chunks)
    }
    fn report_refs(&self, ids: &[String]) -> folio_sync::Result<Vec<String>> {
        self.relay.report_refs(WS, &self.device, ids)
    }
    fn get_chunk(&self, id: &str, n: u32) -> folio_sync::Result<Vec<u8>> {
        self.relay.get_chunk(WS, &self.device, id, n)
    }
}

struct Device {
    name: String,
    store: Mutex<Store>,
    online: bool,
    /// Times it joined again after being removed.
    joins: usize,
    /// Times its library was restored from a backup.
    restores: usize,
    /// Documents the convergence check sent again.
    resent: usize,
    /// The editor's replicas, kept between edits like open cards.
    replicas: RefCell<HashMap<DocId, LoroDoc>>,
    /// Edits made in an open editor and not saved yet: the version before
    /// the first of them, per document.
    unsaved: RefCell<HashMap<DocId, loro::VersionVector>>,
    dir: tempfile::TempDir,
}

impl Device {
    fn new(i: usize) -> Device {
        let dir = tempfile::tempdir().unwrap();
        Device {
            name: format!("device-{i}"),
            store: Mutex::new(Store::open(dir.path()).unwrap()),
            online: true,
            joins: 0,
            restores: 0,
            resent: 0,
            replicas: RefCell::default(),
            unsaved: RefCell::default(),
            dir,
        }
    }

    fn docs(&self) -> Vec<DocId> {
        let s = self.store.lock().unwrap();
        s.live_cards().unwrap().into_iter().map(|c| DocId::parse(&c.id).unwrap()).collect()
    }

    /// Runs an edit on this device's replica of the document, brought up to
    /// date with the store first, as an open editor would be (with the
    /// frontend's peer id, as the app's editor). Stores the update like a
    /// local edit when `save`; otherwise it waits in the editor, to go with
    /// the next saved edit of the document.
    fn edit(&self, id: &DocId, save: bool, f: impl FnOnce(&LoroDoc)) {
        let mut s = self.store.lock().unwrap();
        let mut replicas = self.replicas.borrow_mut();
        let doc = replicas.entry(id.clone()).or_insert_with(|| {
            let doc = LoroDoc::new();
            doc.set_peer_id(s.frontend_peer().unwrap()).unwrap();
            doc
        });
        if let Some(missing) = s.doc_updates_since(id, &doc.oplog_vv()).unwrap() {
            doc.import(&missing).unwrap();
        }
        let mut unsaved = self.unsaved.borrow_mut();
        let before = unsaved.get(id).cloned().unwrap_or_else(|| doc.oplog_vv());
        f(&doc);
        doc.commit();
        if save {
            unsaved.remove(id);
            let bytes = doc.export(ExportMode::updates(&before)).unwrap();
            s.apply_update(id, DocKind::Card, &bytes, Origin::Local, 1).unwrap();
        } else {
            unsaved.insert(id.clone(), before);
        }
    }

    /// Saves what the editors hold.
    fn save_all(&self) {
        let mut s = self.store.lock().unwrap();
        let replicas = self.replicas.borrow();
        for (id, before) in self.unsaved.borrow_mut().drain() {
            let bytes = replicas[&id].export(ExportMode::updates(&before)).unwrap();
            s.apply_update(&id, DocKind::Card, &bytes, Origin::Local, 1).unwrap();
        }
    }

    /// Replaces the library with one of its backups, as Settings does: the
    /// store is closed, the file swapped, the store opened again, and the
    /// app reloads (open editors start over from the store).
    fn restore(&mut self, rng: &mut Rng, now: i64) -> bool {
        let backups = list_backups(&backups_dir(self.dir.path())).unwrap();
        let candidates: Vec<_> = backups.iter().filter(|b| !b.safety).collect();
        if candidates.is_empty() {
            return false;
        }
        let pick = candidates[rng.below(candidates.len())].name.clone();
        self.save_all();
        let placeholder = tempfile::tempdir().unwrap();
        let mut s = self.store.lock().unwrap();
        drop(std::mem::replace(&mut *s, Store::open(placeholder.path()).unwrap()));
        replace_library(self.dir.path(), &pick, now).unwrap();
        *s = Store::open(self.dir.path()).unwrap();
        self.replicas.borrow_mut().clear();
        self.restores += 1;
        true
    }
}

fn textblocks(doc: &LoroDoc) -> Vec<TreeID> {
    let t = tree(doc);
    t.get_nodes(false)
        .into_iter()
        .filter(|n| {
            let meta = t.get_meta(n.id).unwrap();
            matches!(meta.get("nodeName"), Some(ValueOrContainer::Value(LoroValue::String(s))) if TEXTBLOCKS.contains(&s.as_str()))
        })
        .map(|n| n.id)
        .collect()
}

fn containers(doc: &LoroDoc) -> Vec<TreeID> {
    let t = tree(doc);
    t.get_nodes(false)
        .into_iter()
        .filter(|n| {
            let meta = t.get_meta(n.id).unwrap();
            matches!(meta.get("nodeName"), Some(ValueOrContainer::Value(LoroValue::String(s))) if ["bulletList", "listItem", "blockquote"].contains(&s.as_str()))
        })
        .map(|n| n.id)
        .collect()
}

const WORDS: [&str; 8] = ["同步", "卡片", "笔记", "日记", "sync", "card", "note", " "];

/// One random step on one device.
fn step(devices: &mut [Device], relay: &Relay, engine: &Engine, rng: &mut Rng, now: i64) {
    let d = rng.below(devices.len());
    let roll = rng.below(100);
    let docs = devices[d].docs();
    // Most edits are saved at once; some wait in the editor.
    let save = !rng.chance(15);
    match roll {
        // A new card.
        0..=4 => {
            let s = devices[d].store.lock().unwrap();
            drop(s);
            let id = devices[d].store.lock().unwrap().create_card(CardKind::Note, WORDS[rng.below(4)], 1).unwrap();
            devices[d].edit(&id, true, |doc| {
                let p = add_block(doc, None, "paragraph", &[]).unwrap();
                push_text(doc, p, "first").unwrap();
            });
        }
        // A journal day, started on whichever devices write it first.
        5..=9 => {
            let id = DocId::journal(2026, 10, 1 + rng.below(3) as u32).unwrap();
            let exists = docs.contains(&id);
            let word = WORDS[rng.below(WORDS.len())];
            devices[d].edit(&id, save, |doc| {
                if !exists {
                    init_card(doc, CardKind::Journal, "", 1).unwrap();
                }
                let list = add_block(doc, None, "bulletList", &[]).unwrap();
                let item = add_block(doc, Some(list), "listItem", &[]).unwrap();
                let p = add_block(doc, Some(item), "paragraph", &[]).unwrap();
                push_text(doc, p, word).unwrap();
            });
        }
        // A paragraph at the end.
        10..=24 if !docs.is_empty() => {
            let id = docs[rng.below(docs.len())].clone();
            let word = WORDS[rng.below(WORDS.len())];
            devices[d].edit(&id, save, |doc| {
                let p = add_block(doc, None, "paragraph", &[]).unwrap();
                push_text(doc, p, word).unwrap();
            });
        }
        // Typing or deleting inside a text block.
        25..=54 if !docs.is_empty() => {
            let id = docs[rng.below(docs.len())].clone();
            let (pick, word, del) = (rng.next(), WORDS[rng.below(WORDS.len())], rng.chance(30));
            devices[d].edit(&id, save, |doc| {
                let blocks = textblocks(doc);
                if blocks.is_empty() {
                    return;
                }
                let block = blocks[(pick % blocks.len() as u64) as usize];
                let list = folio_core::body::inline(doc, block).unwrap();
                let text = match list.get(0) {
                    Some(ValueOrContainer::Container(Container::Text(t))) => t,
                    _ => list.insert_container(0, loro::LoroText::new()).unwrap(),
                };
                let len = text.len_unicode();
                let at = (pick >> 8) as usize % (len + 1);
                if del && len > 0 {
                    text.delete(at.min(len - 1), 1).unwrap();
                } else {
                    text.insert(at, word).unwrap();
                }
            });
        }
        // Moving a block to another parent, or to the top level.
        55..=69 if !docs.is_empty() => {
            let id = docs[rng.below(docs.len())].clone();
            let (a, b, top) = (rng.next(), rng.next(), rng.chance(25));
            devices[d].edit(&id, save, |doc| {
                let t = tree(doc);
                let nodes = t.get_nodes(false);
                if nodes.is_empty() {
                    return;
                }
                let target = nodes[(a % nodes.len() as u64) as usize].id;
                let parents = containers(doc);
                let parent: TreeParentId = if top || parents.is_empty() { TreeParentId::Root } else { TreeParentId::Node(parents[(b % parents.len() as u64) as usize]) };
                // Moving a node under itself is refused locally; skip it.
                let _ = t.mov(target, parent);
            });
        }
        // Deleting a block.
        70..=74 if !docs.is_empty() => {
            let id = docs[rng.below(docs.len())].clone();
            let a = rng.next();
            devices[d].edit(&id, save, |doc| {
                let t = tree(doc);
                let nodes = t.get_nodes(false);
                if nodes.len() > 1 {
                    let _ = t.delete(nodes[(a % nodes.len() as u64) as usize].id);
                }
            });
        }
        // Going offline or coming back.
        75..=79 => devices[d].online = !devices[d].online,
        // Housekeeping on the device: folding a document's log into its
        // snapshot, a backup, or (rarely) restoring the library from one.
        80..=84 => {
            let dev = &mut devices[d];
            match rng.below(20) {
                0..=11 if !docs.is_empty() => {
                    let id = &docs[rng.below(docs.len())];
                    dev.store.lock().unwrap().compact_doc(id).unwrap();
                }
                12..=18 => {
                    dev.store.lock().unwrap().backup(&backups_dir(dev.dir.path()), now).unwrap();
                }
                19 => {
                    dev.restore(rng, now);
                }
                _ => {}
            }
        }
        // Syncing, over a network that loses replies; now and then
        // replacing long logs on the server with snapshots, or removing
        // another device.
        _ if devices[d].online => {
            let seed = rng.next();
            sync(&mut devices[d], relay, engine, Some(seed));
            let t = Direct::flaky(relay, &devices[d].name, seed.rotate_left(17));
            if rng.chance(10) {
                match engine.upload_snapshots(&devices[d].store, &t) {
                    // Conflict: the server went back; the next sync sees to it.
                    Ok(_) | Err(SyncError::Removed) | Err(SyncError::Network(_)) | Err(SyncError::Conflict(_)) => {}
                    Err(e) => panic!("{}: snapshots: {e}", devices[d].name),
                }
            }
            if rng.chance(1) {
                let o = (d + 1 + rng.below(devices.len() - 1)) % devices.len();
                match engine.remove_device(&t, &devices[o].name) {
                    // Already removed, or this device itself was.
                    Ok(()) | Err(SyncError::NotFound(_)) | Err(SyncError::Removed) => {}
                    Err(e) => panic!("{}: removing {}: {e}", devices[d].name, devices[o].name),
                }
            }
        }
        _ => {}
    }
}

/// One sync, over a flaky network when given a seed; a device that was
/// removed joins again as a new one, its notes (and what it wrote offline)
/// going up with its whole history.
fn sync(device: &mut Device, relay: &Relay, engine: &Engine, faults: Option<u64>) -> Report {
    let t = match faults {
        Some(seed) => Direct::flaky(relay, &device.name, seed),
        None => Direct::new(relay, &device.name),
    };
    match engine.sync(&device.store, &t) {
        Ok(r) => {
            device.resent += r.resent;
            if faults.is_none() {
                assert_eq!(r.acks_error, None);
            }
            r
        }
        // The next sync picks it up.
        Err(SyncError::Network(_)) if faults.is_some() => Report::default(),
        Err(SyncError::Removed) => {
            device.joins += 1;
            device.name = format!("{}-again{}", device.name.split("-again").next().unwrap(), device.joins);
            {
                let mut s = device.store.lock().unwrap();
                forget_workspace(&s).unwrap();
                s.queue_everything(1).unwrap();
            }
            sync(device, relay, engine, faults)
        }
        Err(e) => panic!("{}: sync: {e}", device.name),
    }
}

/// Everyone online with their edits saved, syncing until nothing moves.
fn settle(devices: &mut [Device], relay: &Relay, engine: &Engine) {
    for d in devices.iter_mut() {
        d.online = true;
        d.save_all();
    }
    for _ in 0..10 {
        let mut quiet = true;
        for d in devices.iter_mut() {
            let r = sync(d, relay, engine, None);
            quiet &= r.pushed == 0 && r.applied.is_empty() && r.resent == 0;
        }
        if quiet {
            return;
        }
    }
    panic!("sync did not settle");
}

fn assert_converged(devices: &[Device]) -> usize {
    let ids: BTreeSet<DocId> = devices.iter().flat_map(|d| d.docs()).collect();
    for id in &ids {
        let states: Vec<(loro::VersionVector, LoroValue)> = devices
            .iter()
            .map(|d| {
                let snap = d.store.lock().unwrap().doc_snapshot_if_exists(id).unwrap().unwrap_or_else(|| panic!("{} lacks {id}", d.name));
                let doc = LoroDoc::new();
                doc.import(&snap).unwrap();
                (doc.oplog_vv(), doc.get_deep_value())
            })
            .collect();
        for (i, s) in states.iter().enumerate().skip(1) {
            assert_eq!(s.0, states[0].0, "{id}: version differs on {}", devices[i].name);
            assert_eq!(s.1, states[0].1, "{id}: content differs on {}", devices[i].name);
        }
        let summaries: Vec<String> = devices.iter().map(|d| d.store.lock().unwrap().card_summary(id).unwrap().text).collect();
        assert!(summaries.windows(2).all(|w| w[0] == w[1]), "{id}: index text differs");
    }
    ids.len()
}

/// After two more rounds (one to report the settled versions, one to
/// collect them), every device knows the version every other device has of
/// every document: what compaction will go by.
fn assert_acks_agree(devices: &[Device], relay: &Relay, engine: &Engine) {
    for _ in 0..2 {
        for d in devices {
            engine.sync(&d.store, &Direct::new(relay, &d.name)).unwrap();
        }
    }
    for d in devices {
        let mut s = d.store.lock().unwrap();
        for c in s.live_cards().unwrap() {
            let id = DocId::parse(&c.id).unwrap();
            let vv = |b: &[u8]| loro::VersionVector::decode(b).unwrap();
            let mine = vv(&s.doc_version(&id, DocKind::Card).unwrap());
            for other in devices {
                let theirs = s.device_ack(&id, &other.name).unwrap().map(|b| vv(&b));
                assert_eq!(theirs.as_ref(), Some(&mine), "{}: {}'s report of {id}", d.name, other.name);
            }
        }
    }
}

/// The server's database in a file, so it can be copied and put back.
struct Server {
    dir: tempfile::TempDir,
    copies: usize,
}

impl Server {
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("relay.db")
    }

    fn open(&self) -> Relay {
        // Low thresholds, so short runs replace logs with snapshots too.
        Relay::open(&self.path()).unwrap().with_snapshot_thresholds(10, 64 * 1024)
    }

    fn copy(&mut self, relay: &Relay) {
        self.copies += 1;
        let to = self.dir.path().join(format!("copy-{}.db", self.copies));
        relay.copy_to(&to).unwrap();
    }

    /// The server restored from its latest copy: what came after is gone.
    fn roll_back(&self, relay: Relay) -> Relay {
        drop(relay);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path().display()));
        }
        std::fs::copy(self.dir.path().join(format!("copy-{}.db", self.copies)), self.path()).unwrap();
        self.open()
    }
}

fn run(seed: u64, devices: usize, steps: usize) -> usize {
    let mut rng = Rng(seed);
    let mut server = Server { dir: tempfile::tempdir().unwrap(), copies: 0 };
    let mut relay = server.open();
    let key = WorkspaceKey::generate();
    relay.create_workspace(WS, &folio_sync::crypto::wrap(&key, "test", (1024, 1, 1)).unwrap()).unwrap();
    // The convergence check on every sync, not every ten minutes.
    let engine = Engine::new(WS, Keys::derive(&key)).with_check_every(0);
    let mut devices: Vec<Device> = (0..devices).map(Device::new).collect();
    // The first device is away for the middle of the run (a laptop left in
    // a drawer), editing all the while; the others go on and compact.
    let away = steps / 4..steps / 2;
    for i in 1..=steps {
        if away.contains(&i) {
            devices[0].online = false;
        }
        // The server is backed up now and then, and once put back to its
        // latest copy.
        if i % 400 == 0 {
            server.copy(&relay);
        }
        if i == steps * 2 / 3 && server.copies > 0 {
            relay = server.roll_back(relay);
        }
        step(&mut devices, &relay, &engine, &mut rng, i as i64);
        if i % 10_000 == 0 {
            println!("{i} steps");
        }
    }
    settle(&mut devices, &relay, &engine);
    // A device that joins now starts from what is left on the server:
    // snapshots and the updates after them.
    let late = Device::new(devices.len());
    late.store.lock().unwrap().queue_everything(1).unwrap();
    devices.push(late);
    settle(&mut devices, &relay, &engine);
    let docs = assert_converged(&devices);
    assert_acks_agree(&devices, &relay, &engine);
    let (updates, snapshots) = relay.log_stats(WS).unwrap();
    assert!(snapshots > 0, "seed {seed}: no log was replaced ({updates} updates)");
    let rejoined: usize = devices.iter().map(|d| d.joins).sum();
    let restored: usize = devices.iter().map(|d| d.restores).sum();
    let resent: usize = devices.iter().map(|d| d.resent).sum();
    println!("seed {seed}: {docs} documents; server log {updates} updates + {snapshots} snapshots; {rejoined} rejoins after removal; {restored} restores from a backup; {resent} documents sent again by the convergence check");
    docs
}

#[test]
fn three_devices_converge() {
    for seed in [1, 2, 3, 0x5eed] {
        let docs = run(seed, 3, 1500);
        assert!(docs > 3, "seed {seed}: the run made documents");
    }
}

/// Many short runs on four devices, for hunting rare orders of events:
/// `FOLIO_SIM_SEEDS=200 cargo test --release -p folio-sync --test simulator many_seeds -- --ignored`.
#[test]
#[ignore]
fn many_seeds() {
    if let Some(seed) = std::env::var("FOLIO_SIM_SEED").ok().and_then(|v| v.parse().ok()) {
        run(seed, 4, 1500);
        return;
    }
    let n: u64 = std::env::var("FOLIO_SIM_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
    for seed in 1..=n {
        run(seed * 7919, 4, 1500);
    }
}

#[test]
#[ignore]
fn three_devices_converge_long() {
    let docs = run(0x00c0_ffee, 3, 100_000);
    println!("converged over {docs} documents after 100 000 steps");
}
