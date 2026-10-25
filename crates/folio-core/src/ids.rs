//! Document and block identifiers (design/ARCHITECTURE.md §4.1).

use std::fmt;

use serde::{Deserialize, Serialize};

/// What a document holds. Each document is one Loro doc.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    Workspace,
    Card,
    Board,
}

impl DocKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocKind::Workspace => "workspace",
            DocKind::Card => "card",
            DocKind::Board => "board",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "workspace" => Some(DocKind::Workspace),
            "card" => Some(DocKind::Card),
            "board" => Some(DocKind::Board),
            _ => None,
        }
    }
}

/// A document id as stored and synced. Cards use UUIDv7; the workspace is
/// the fixed `ws`; a journal day is `journal:YYYY-MM-DD` and a topic's
/// whiteboard `board:<topic id>`, so two devices that start the same one
/// offline write into the same document.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocId(String);

impl DocId {
    pub const WORKSPACE: &'static str = "ws";

    pub fn workspace() -> Self {
        DocId(Self::WORKSPACE.to_string())
    }

    pub fn new_card() -> Self {
        DocId(uuid::Uuid::now_v7().to_string())
    }

    pub fn new_board() -> Self {
        DocId(uuid::Uuid::now_v7().to_string())
    }

    /// The journal document for a local calendar date (§5.2a: the device's
    /// current time zone decides which day "today" is).
    pub fn journal(year: i32, month: u32, day: u32) -> Result<Self, IdError> {
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(1..=9999).contains(&year) {
            return Err(IdError::InvalidDate { year, month, day });
        }
        Ok(DocId(format!("journal:{year:04}-{month:02}-{day:02}")))
    }

    pub fn is_journal(&self) -> bool {
        self.0.starts_with("journal:")
    }

    /// Accepts any id read back from storage or the network.
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let ok = s == Self::WORKSPACE
            || uuid::Uuid::parse_str(s).is_ok()
            || s.strip_prefix("journal:").is_some_and(|d| d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-')
            || s.strip_prefix("board:").is_some_and(|t| uuid::Uuid::parse_str(t).is_ok());
        if ok { Ok(DocId(s.to_string())) } else { Err(IdError::InvalidDocId(s.to_string())) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DocId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A block id (`attrs.bid` on every block node). Resolved globally (§4.2).
pub fn new_bid() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum IdError {
    #[error("invalid document id: {0:?}")]
    InvalidDocId(String),
    #[error("invalid journal date {year:04}-{month:02}-{day:02}")]
    InvalidDate { year: i32, month: u32, day: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_ids_are_deterministic_and_parse_back() {
        let a = DocId::journal(2026, 10, 23).unwrap();
        assert_eq!(a.as_str(), "journal:2026-10-23");
        assert_eq!(a, DocId::journal(2026, 10, 23).unwrap());
        assert!(a.is_journal());
        assert_eq!(DocId::parse(a.as_str()).unwrap(), a);
    }

    #[test]
    fn rejects_garbage() {
        assert!(DocId::parse("../etc/passwd").is_err());
        assert!(DocId::journal(2026, 13, 1).is_err());
        assert!(DocId::parse(DocId::new_card().as_str()).is_ok());
        assert!(DocId::parse("ws").is_ok());
        assert!(DocId::parse("board:0190f5a2-0000-7000-8000-000000000000").is_ok());
        assert!(DocId::parse("board:nope").is_err());
    }
}
