//! Domain model shared by every other crate: document ids, the card document
//! layout in Loro, and content extraction for the index. No IO and no clock:
//! callers pass timestamps in.

pub mod body;
pub mod card;
pub mod ids;
pub mod index;

pub use card::{CardKind, CardSummary, EditorMode};
pub use ids::{DocId, DocKind, IdError};
