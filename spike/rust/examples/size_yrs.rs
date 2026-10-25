// Binary-size probe: links only the yrs engine (`cargo build --release --example size_yrs`).
use crdt_spike::{DocEngine, ImportBlock, yrs_engine::YrsEngine};

fn main() {
    let e = YrsEngine::new(1);
    e.card_append_blocks(&[ImportBlock { node: "paragraph", bid: "b", text: "x" }]);
    let bytes = e.snapshot();
    let f = YrsEngine::load(&bytes, 2).unwrap();
    println!("{}", f.card_canonical());
}
