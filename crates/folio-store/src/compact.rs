//! Folding a document's update log into its snapshot (design/ARCHITECTURE.md
//! §5.3, compaction step 1): the rows of `doc_updates` become one full
//! snapshot in `docs.snapshot`. No history is dropped (a full snapshot keeps
//! it all); a document just loads from one row instead of thousands.
//!
//! Each document is folded in one transaction that is checked before it
//! commits: the document read back from the new rows must have the same
//! content and version as from the old ones, or nothing changes. A log with
//! an update still waiting for one it depends on is left alone, since a
//! snapshot would not carry that update.

use loro::{ExportMode, LoroDoc};
use folio_core::{DocId, DocKind};
use rusqlite::{params, Connection};

use crate::{loro_err, Result, Store, StoreError};

/// A document's log is folded once it has this many updates…
pub const COMPACT_MIN_UPDATES: i64 = 200;
/// …or this many bytes.
pub const COMPACT_MIN_BYTES: i64 = 256 * 1024;
/// `local_settings` key set once the library has been compacted (and so
/// backed up for it) the first time.
const COMPACTED: &str = "store.compacted";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compacted {
    /// The log is folded; this many rows were removed.
    Folded(usize),
    /// An update in the log waits for another: left as it is.
    Pending,
    /// Nothing to fold.
    Nothing,
}

/// The document as the rows have it, and whether an update is pending.
fn read_doc(conn: &Connection, id: &DocId) -> Result<(LoroDoc, bool)> {
    let doc = LoroDoc::new();
    let snapshot: Option<Vec<u8>> = conn.query_row("SELECT snapshot FROM docs WHERE doc_id = ?1", [id.as_str()], |r| r.get(0))?;
    let mut pending = false;
    if let Some(s) = snapshot {
        pending |= doc.import(&s).map_err(loro_err)?.pending.is_some();
    }
    let mut stmt = conn.prepare_cached("SELECT bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY id")?;
    for u in stmt.query_map([id.as_str()], |r| r.get::<_, Vec<u8>>(0))? {
        pending |= doc.import(&u?).map_err(loro_err)?.pending.is_some();
    }
    Ok((doc, pending))
}

fn same(a: &LoroDoc, b: &LoroDoc) -> bool {
    a.oplog_vv() == b.oplog_vv() && a.get_deep_value() == b.get_deep_value()
}

impl Store {
    /// Documents whose log is long enough to fold, longest first.
    pub fn docs_to_compact(&self) -> Result<Vec<DocId>> {
        let mut stmt = self.conn.prepare(
            "SELECT doc_id FROM doc_updates GROUP BY doc_id
             HAVING count(*) >= ?1 OR sum(length(bytes)) >= ?2 ORDER BY sum(length(bytes)) DESC",
        )?;
        let ids = stmt.query_map(params![COMPACT_MIN_UPDATES, COMPACT_MIN_BYTES], |r| r.get::<_, String>(0))?;
        ids.map(|id| DocId::parse(&id?).map_err(StoreError::from)).collect()
    }

    /// Before the first compaction of this library: a safety backup of it
    /// as it is. Returns whether one was made.
    pub fn backup_before_first_compaction(&self, dir: &std::path::Path, now_ms: i64) -> Result<bool> {
        if self.local_setting(COMPACTED)?.is_some() {
            return Ok(false);
        }
        self.backup_before_upgrade(dir, now_ms)?;
        self.set_local_setting(COMPACTED, &serde_json::json!(now_ms))?;
        Ok(true)
    }

    /// Every document, for matching the server's opaque tags.
    pub fn all_docs(&self) -> Result<Vec<(DocId, DocKind)>> {
        let mut stmt = self.conn.prepare("SELECT doc_id, kind FROM docs ORDER BY doc_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, kind) = row?;
            let Some(kind) = DocKind::parse(&kind) else { continue };
            out.push((DocId::parse(&id)?, kind));
        }
        Ok(out)
    }

    /// The document's full snapshot as stored, for the server to replace
    /// its log with (§5.3); `None` while an update waits for another (the
    /// snapshot would lack it). Checked to read back the same.
    pub fn settled_snapshot(&mut self, id: &DocId) -> Result<Option<Vec<u8>>> {
        let (doc, pending) = read_doc(&self.conn, id)?;
        if pending {
            return Ok(None);
        }
        let snapshot = doc.export(ExportMode::Snapshot).map_err(loro_err)?;
        let check = LoroDoc::new();
        check.import(&snapshot).map_err(loro_err)?;
        if !same(&doc, &check) {
            return Err(StoreError::Loro(format!("the snapshot of {id} does not read back the same")));
        }
        Ok(Some(snapshot))
    }

    /// Folds one document's update log into its snapshot (see the module).
    pub fn compact_doc(&mut self, id: &DocId) -> Result<Compacted> {
        let rows: i64 = self.conn.query_row("SELECT count(*) FROM doc_updates WHERE doc_id = ?1", [id.as_str()], |r| r.get(0))?;
        if rows == 0 {
            return Ok(Compacted::Nothing);
        }
        let (before, pending) = read_doc(&self.conn, id)?;
        if pending {
            tracing::warn!(doc = %id, "not compacted: an update waits for another");
            return Ok(Compacted::Pending);
        }
        let snapshot = before.export(ExportMode::Snapshot).map_err(loro_err)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE docs SET snapshot = ?2, snapshot_vv = ?3 WHERE doc_id = ?1",
            params![id.as_str(), snapshot, before.oplog_vv().encode()],
        )?;
        let removed = tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", [id.as_str()])?;
        let (after, pending) = read_doc(&tx, id)?;
        if pending || !same(&before, &after) {
            // Dropping the transaction rolls it back.
            tracing::error!(doc = %id, "compaction check failed; nothing changed");
            return Err(StoreError::Loro(format!("compacting {id} would change it")));
        }
        tx.commit()?;
        tracing::info!(doc = %id, removed, bytes = snapshot.len(), "compacted");
        Ok(Compacted::Folded(removed))
    }
}

#[cfg(test)]
mod tests {
    use folio_core::card::{append_paragraph, CardKind};

    use super::*;
    use crate::Origin;

    /// Adds a paragraph to a card through the store's write path.
    fn write(s: &mut Store, id: &DocId, text: &str, now: i64) {
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        append_paragraph(&doc, text).unwrap();
        s.apply_update(id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, now).unwrap();
    }

    fn rows(s: &Store, id: &DocId) -> i64 {
        s.conn.query_row("SELECT count(*) FROM doc_updates WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).unwrap()
    }

    #[test]
    fn folding_keeps_content_history_and_later_edits() {
        let dir = tempfile::tempdir().unwrap();
        let (id, before_fold) = {
            let mut s = Store::open(dir.path()).unwrap();
            let id = s.create_card(CardKind::Note, "Long", 1).unwrap();
            let short = s.create_card(CardKind::Note, "Short", 1).unwrap();
            for i in 0..COMPACT_MIN_UPDATES {
                write(&mut s, &id, &format!("line {i}"), 2 + i);
            }
            assert_eq!(s.docs_to_compact().unwrap(), vec![id.clone()]);
            let before = s.doc_snapshot(&id).unwrap();
            assert_eq!(s.compact_doc(&id).unwrap(), Compacted::Folded(COMPACT_MIN_UPDATES as usize + 1));
            assert_eq!(rows(&s, &id), 0);
            assert_eq!(rows(&s, &short), 1, "other documents are untouched");
            assert!(s.docs_to_compact().unwrap().is_empty());
            assert_eq!(s.compact_doc(&id).unwrap(), Compacted::Nothing);
            // The cached replica goes on; a later edit lands in the log again.
            write(&mut s, &id, "after", 1000);
            assert_eq!(rows(&s, &id), 1);
            (id, before)
        };
        // From disk: the snapshot plus the later edit, with all history.
        let mut s = Store::open(dir.path()).unwrap();
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let old = LoroDoc::new();
        old.import(&before_fold).unwrap();
        assert!(doc.oplog_vv().includes_vv(&old.oplog_vv()));
        assert!(!doc.is_shallow());
        doc.checkout(&old.oplog_frontiers()).unwrap();
        assert_eq!(doc.get_deep_value(), old.get_deep_value(), "history before the fold is still there");
        assert!(s.card_summary(&id).unwrap().text.contains("after"));
        assert!(s.search("line 199", 10).unwrap().iter().any(|h| h.card_id == id.as_str()));
    }

    #[test]
    fn a_log_with_a_waiting_update_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let id = s.create_card(CardKind::Note, "Card", 1).unwrap();
        // An update that depends on one this device never got.
        let other = LoroDoc::new();
        other.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        append_paragraph(&other, "missing").unwrap();
        let v1 = other.oplog_vv();
        append_paragraph(&other, "waiting").unwrap();
        assert!(s.apply_remote(&id, DocKind::Card, &other.export(ExportMode::updates(&v1)).unwrap(), 2).unwrap());
        assert_eq!(s.compact_doc(&id).unwrap(), Compacted::Pending);
        assert_eq!(rows(&s, &id), 2);
        assert_eq!(s.settled_snapshot(&id).unwrap(), None, "no snapshot for the server either");
    }

    #[test]
    fn the_first_compaction_is_backed_up_once() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        let backups = dir.path().join("backups");
        assert!(s.backup_before_first_compaction(&backups, 5).unwrap());
        assert!(!s.backup_before_first_compaction(&backups, 6).unwrap());
        let all = crate::backup::list_backups(&backups).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].safety);
    }
}
