// Binary-size probe: links only the Loro engine (`cargo build --release --example size_loro`).
use crdt_spike::{DocEngine, ImportBlock, loro_engine::LoroEngine};

fn main() {
    let e = LoroEngine::new(1);
    e.card_append_blocks(&[ImportBlock { node: "paragraph", bid: "b", text: "x" }]);
    let bytes = e.snapshot();
    let f = LoroEngine::load(&bytes, 2).unwrap();
    println!("{}", f.card_canonical());
}
