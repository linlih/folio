//! Criterion 5, Rust half. Reads what the JS editor wrote (fixtures/<engine>/),
//! checks Rust sees the same document, then writes Rust edits back for JS.
//! Order: `INTEROP=export vitest` → `cargo test --test interop` → `INTEROP=verify vitest`.

mod common;

use std::fs;

use common::fixtures_dir;
use crdt_spike::{DocEngine, ImportBlock, loro_engine::LoroEngine, yrs_engine::YrsEngine};
use serde_json::Value;

fn unpack(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut off = 0;
    while off < bytes.len() {
        let len = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        out.push(bytes[off + 4..off + 4 + len].to_vec());
        off += 4 + len;
    }
    out
}

/// JSON numbers from JS (10) and Rust (10.0) compare equal after this.
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        other => other,
    }
}

fn read_json(path: &std::path::Path) -> Value {
    norm(serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap())
}

fn interop<E: DocEngine>() {
    let dir = fixtures_dir().join(E::NAME);
    let expected = read_json(&dir.join("card.canonical.json"));
    let updates = unpack(&fs::read(dir.join("card.updates")).unwrap());

    // Same document from the update log in order, in reverse, and from the snapshot.
    let in_order = E::new(101);
    for u in &updates {
        in_order.apply_update(u).unwrap();
    }
    let reversed = E::new(102);
    for u in updates.iter().rev() {
        reversed.apply_update(u).unwrap();
    }
    let snap = E::load(&fs::read(dir.join("card.snapshot")).unwrap(), 103).unwrap();
    assert_eq!(norm(in_order.card_canonical()), expected, "{}: update log differs from JS", E::NAME);
    assert_eq!(norm(reversed.card_canonical()), expected, "{}: reversed log differs", E::NAME);
    assert_eq!(norm(snap.card_canonical()), expected, "{}: snapshot differs", E::NAME);

    // The JS version vector decodes in Rust and nothing is missing.
    let js_version = fs::read(dir.join("card.version")).unwrap();
    let missing = snap.export_since(&js_version).unwrap();
    let probe = E::load(&fs::read(dir.join("card.snapshot")).unwrap(), 104).unwrap();
    probe.apply_update(&missing).unwrap();
    assert_eq!(probe.card_canonical(), snap.card_canonical());

    // Rust-side import appends blocks; JS must render them (verify phase).
    snap.card_append_blocks(&[
        ImportBlock { node: "paragraph", bid: "rust-p1", text: "Rust 导入的段落" },
        ImportBlock { node: "heading", bid: "rust-h1", text: "Rust 导入的标题" },
    ]);
    fs::write(dir.join("rust-card.update"), snap.export_since(&js_version).unwrap()).unwrap();
    fs::write(dir.join("rust-card.version"), snap.version()).unwrap();
    fs::write(dir.join("rust-card.canonical.json"), serde_json::to_string_pretty(&snap.card_canonical()).unwrap()).unwrap();

    // Board written by JS, edited in Rust.
    let board = E::load(&fs::read(dir.join("board.snapshot")).unwrap(), 105).unwrap();
    assert_eq!(norm(board.board_canonical()), read_json(&dir.join("board.canonical.json")), "{}: board differs", E::NAME);
    board.board_move_item("i1", 99.0, 77.0);
    board.board_put_item("i3", "c3", 800.0, 40.0, 240.0, 160.0);
    board.board_remove_edge("e1");
    board.board_put_edge("e2", "i2", "i3");
    fs::write(dir.join("rust-board.snapshot"), board.snapshot()).unwrap();
    fs::write(dir.join("rust-board.canonical.json"), serde_json::to_string_pretty(&board.board_canonical()).unwrap()).unwrap();
    println!("{}: {} JS updates, card + board match; Rust edits written", E::NAME, updates.len());
}

/// Third leg: the JS editor kept editing on top of Rust's write.
fn roundtrip_back<E: DocEngine>() {
    let dir = fixtures_dir().join(E::NAME);
    let Ok(update) = fs::read(dir.join("js-after-rust.update")) else {
        println!("{}: no js-after-rust.update yet (run INTEROP=verify first)", E::NAME);
        return;
    };
    let e = E::load(&fs::read(dir.join("card.snapshot")).unwrap(), 106).unwrap();
    e.apply_update(&fs::read(dir.join("rust-card.update")).unwrap()).unwrap();
    e.apply_update(&update).unwrap();
    assert_eq!(norm(e.card_canonical()), read_json(&dir.join("js-after-rust.canonical.json")));
    println!("{}: JS edits after Rust write round-trip back to Rust", E::NAME);
}

#[test]
fn interop_loro() {
    interop::<LoroEngine>();
    roundtrip_back::<LoroEngine>();
}

#[test]
fn interop_yrs() {
    interop::<YrsEngine>();
    roundtrip_back::<YrsEngine>();
}
