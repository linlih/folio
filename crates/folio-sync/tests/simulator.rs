//! The sync simulator (design/ARCHITECTURE.md §8, M3 acceptance): devices
//! with their own stores edit at random, go offline and come back, and sync
//! through the relay. However the steps fall, every document must end the
//! same on every device.
//!
//! The quick run is part of the tests; the long one (100 000 steps) is
//! ignored by default:
//!
//!     cargo test --release -p folio-sync --test simulator -- --ignored --nocapture

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use loro::{Container, ExportMode, LoroDoc, LoroValue, TreeID, TreeParentId, ValueOrContainer};
use folio_core::body::{add_block, push_text, tree, TEXTBLOCKS};
use folio_core::card::{init_card, CardKind};
use folio_core::{DocId, DocKind};
use folio_store::{Origin, Store};
use folio_sync::client::{Engine, Transport};
use folio_sync::crypto::{Keys, WorkspaceKey};
use folio_sync::protocol::{PullResponse, PushItem};
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

struct Direct<'a> {
    relay: &'a Relay,
    device: String,
}

impl Transport for Direct<'_> {
    fn push(&self, items: &[PushItem]) -> folio_sync::Result<i64> {
        self.relay.push(WS, &self.device, items)
    }
    fn pull(&self, after: i64, limit: u32) -> folio_sync::Result<PullResponse> {
        self.relay.pull(WS, after, limit)
    }
}

struct Device {
    name: String,
    store: Mutex<Store>,
    peer: u64,
    online: bool,
    /// The editor's replicas, kept between edits like open cards.
    replicas: RefCell<HashMap<DocId, LoroDoc>>,
    _dir: tempfile::TempDir,
}

impl Device {
    fn new(i: usize, rng: &mut Rng) -> Device {
        let dir = tempfile::tempdir().unwrap();
        Device { name: format!("device-{i}"), store: Mutex::new(Store::open(dir.path()).unwrap()), peer: rng.next() >> 1, online: true, replicas: RefCell::default(), _dir: dir }
    }

    fn docs(&self) -> Vec<DocId> {
        let s = self.store.lock().unwrap();
        s.live_cards().unwrap().into_iter().map(|c| DocId::parse(&c.id).unwrap()).collect()
    }

    /// Runs an edit on this device's replica of the document, brought up to
    /// date with the store first, as an open editor would be; stores the
    /// update like a local edit.
    fn edit(&self, id: &DocId, f: impl FnOnce(&LoroDoc)) {
        let mut s = self.store.lock().unwrap();
        let mut replicas = self.replicas.borrow_mut();
        let doc = replicas.entry(id.clone()).or_insert_with(|| {
            let doc = LoroDoc::new();
            doc.set_peer_id(self.peer).unwrap();
            doc
        });
        if let Some(missing) = s.doc_updates_since(id, &doc.oplog_vv()).unwrap() {
            doc.import(&missing).unwrap();
        }
        let before = doc.oplog_vv();
        f(&doc);
        doc.commit();
        let bytes = doc.export(ExportMode::updates(&before)).unwrap();
        s.apply_update(id, DocKind::Card, &bytes, Origin::Local, 1).unwrap();
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
fn step(devices: &mut [Device], relay: &Relay, engine: &Engine, rng: &mut Rng) {
    let d = rng.below(devices.len());
    let roll = rng.below(100);
    let docs = devices[d].docs();
    match roll {
        // A new card.
        0..=4 => {
            let s = devices[d].store.lock().unwrap();
            drop(s);
            let id = devices[d].store.lock().unwrap().create_card(CardKind::Note, WORDS[rng.below(4)], 1).unwrap();
            devices[d].edit(&id, |doc| {
                let p = add_block(doc, None, "paragraph", &[]).unwrap();
                push_text(doc, p, "first").unwrap();
            });
        }
        // A journal day, started on whichever devices write it first.
        5..=9 => {
            let id = DocId::journal(2026, 10, 1 + rng.below(3) as u32).unwrap();
            let exists = docs.contains(&id);
            let word = WORDS[rng.below(WORDS.len())];
            devices[d].edit(&id, |doc| {
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
            devices[d].edit(&id, |doc| {
                let p = add_block(doc, None, "paragraph", &[]).unwrap();
                push_text(doc, p, word).unwrap();
            });
        }
        // Typing or deleting inside a text block.
        25..=54 if !docs.is_empty() => {
            let id = docs[rng.below(docs.len())].clone();
            let (pick, word, del) = (rng.next(), WORDS[rng.below(WORDS.len())], rng.chance(30));
            devices[d].edit(&id, |doc| {
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
            devices[d].edit(&id, |doc| {
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
            devices[d].edit(&id, |doc| {
                let t = tree(doc);
                let nodes = t.get_nodes(false);
                if nodes.len() > 1 {
                    let _ = t.delete(nodes[(a % nodes.len() as u64) as usize].id);
                }
            });
        }
        // Going offline or coming back.
        75..=79 => devices[d].online = !devices[d].online,
        // Syncing.
        _ if devices[d].online => {
            let t = Direct { relay, device: devices[d].name.clone() };
            engine.sync(&devices[d].store, &t).unwrap();
        }
        _ => {}
    }
}

/// Everyone online, syncing until nothing moves.
fn settle(devices: &mut [Device], relay: &Relay, engine: &Engine) {
    for d in devices.iter_mut() {
        d.online = true;
    }
    for _ in 0..10 {
        let mut quiet = true;
        for d in devices.iter() {
            let t = Direct { relay, device: d.name.clone() };
            let r = engine.sync(&d.store, &t).unwrap();
            quiet &= r.pushed == 0 && r.applied.is_empty();
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

fn run(seed: u64, devices: usize, steps: usize) -> usize {
    let mut rng = Rng(seed);
    let relay = Relay::open_in_memory().unwrap();
    let key = WorkspaceKey::generate();
    relay.create_workspace(WS, &folio_sync::crypto::wrap(&key, "test", (1024, 1, 1)).unwrap()).unwrap();
    let engine = Engine::new(WS, Keys::derive(&key));
    let mut devices: Vec<Device> = (0..devices).map(|i| Device::new(i, &mut rng)).collect();
    for i in 1..=steps {
        step(&mut devices, &relay, &engine, &mut rng);
        if i % 10_000 == 0 {
            println!("{i} steps");
        }
    }
    settle(&mut devices, &relay, &engine);
    assert_converged(&devices)
}

#[test]
fn three_devices_converge() {
    for seed in [1, 2, 3, 0x5eed] {
        let docs = run(seed, 3, 1500);
        assert!(docs > 3, "seed {seed}: the run made documents");
    }
}

#[test]
#[ignore]
fn three_devices_converge_long() {
    let docs = run(0x00c0_ffee, 3, 100_000);
    println!("converged over {docs} documents after 100 000 steps");
}
