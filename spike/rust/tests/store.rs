//! The SQLite store round-trips both engines and compaction keeps the state.

mod common;

use crdt_spike::{DocEngine, ImportBlock, loro_engine::LoroEngine, store::Store, yrs_engine::YrsEngine};

fn roundtrip<E: DocEngine>() {
    let dir = std::env::temp_dir().join(format!("crdt-spike-store-{}-{}.db", E::NAME, std::process::id()));
    let _ = std::fs::remove_file(&dir);
    let store = Store::open(dir.to_str().unwrap()).unwrap();
    let e = E::new(7);
    for i in 0..200 {
        let v = e.version();
        let bid = format!("b{i}");
        let text = format!("段落 {i}");
        e.card_append_blocks(&[ImportBlock { node: "paragraph", bid: &bid, text: &text }]);
        store.append_update("card-1", "card", &e.export_since(&v).unwrap(), "local").unwrap();
    }
    let (loaded, stats) = store.load::<E>("card-1", 8).unwrap();
    assert_eq!(loaded.card_canonical(), e.card_canonical());
    assert_eq!(stats.updates, 200);
    let compacted = store.compact::<E>("card-1").unwrap();
    let (again, stats2) = store.load::<E>("card-1", 9).unwrap();
    assert_eq!(again.card_canonical(), e.card_canonical());
    assert_eq!(stats2.updates, 0);
    println!(
        "{}: 200 updates {} B -> compacted {} B; load {:.2} ms -> {:.2} ms",
        E::NAME, stats.update_bytes, compacted, stats.ms, stats2.ms
    );
    // A replica that was offline during compaction can still send its updates.
    let late = E::load(&e.snapshot(), 10).unwrap();
    let v = late.version();
    late.card_append_blocks(&[ImportBlock { node: "paragraph", bid: "late", text: "离线写的" }]);
    again.apply_update(&late.export_since(&v).unwrap()).unwrap();
    assert_eq!(again.card_canonical(), late.card_canonical());
}

#[test]
fn store_roundtrip_loro() {
    roundtrip::<LoroEngine>();
}

#[test]
fn store_roundtrip_yrs() {
    roundtrip::<YrsEngine>();
}
