//! M0 CRDT spike: the same `DocEngine` surface implemented on Loro and on
//! yrs, plus a SQLite store shaped like design/ARCHITECTURE.md §4.4.
//!
//! The trait is a prototype-only seam so both engines share tests; the plan
//! is to delete it once a library is chosen (ARCHITECTURE.md §8.1).

pub mod canonical;
pub mod loro_engine;
pub mod store;
pub mod yrs_engine;

use anyhow::Result;
use serde_json::Value;

/// One block written by a Rust-side importer (e.g. Markdown import).
#[derive(Clone, Debug)]
pub struct ImportBlock<'a> {
    pub node: &'a str,
    pub bid: &'a str,
    pub text: &'a str,
}

pub trait DocEngine: Sized {
    const NAME: &'static str;

    fn new(peer: u64) -> Self;
    /// Load from a snapshot, a compacted state or an update.
    fn load(bytes: &[u8], peer: u64) -> Result<Self>;
    fn apply_update(&self, update: &[u8]) -> Result<()>;
    /// Loro version vector / Yjs state vector, encoded.
    fn version(&self) -> Vec<u8>;
    fn export_since(&self, version: &[u8]) -> Result<Vec<u8>>;
    fn snapshot(&self) -> Vec<u8>;
    /// Smallest form that still accepts future updates.
    fn compact(&self) -> Vec<u8>;

    /// The card as engine-independent JSON (see `canonical`).
    fn card_canonical(&self) -> Value;
    /// The board as engine-independent JSON.
    fn board_canonical(&self) -> Value;

    // Board document: `items` and `edges` root maps (ARCHITECTURE.md §4.3).
    fn board_put_item(&self, id: &str, card: &str, x: f64, y: f64, w: f64, h: f64);
    fn board_move_item(&self, id: &str, x: f64, y: f64);
    fn board_remove_item(&self, id: &str);
    fn board_put_edge(&self, id: &str, from: &str, to: &str);
    fn board_remove_edge(&self, id: &str);

    /// Append blocks to a card in the layout the front-end binding reads.
    fn card_append_blocks(&self, blocks: &[ImportBlock]);
}
