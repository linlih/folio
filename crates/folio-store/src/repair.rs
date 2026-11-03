//! Repairing a document whose stored log cannot be read in order because
//! one peer wrote two different histories under the same op ids.
//!
//! Before 0.1.16 an editor reopened from an older copy while its last save
//! was under way went on with the same peer id (web/src/docs/hub.ts): its
//! edits reused ids the closed editor had already written. Loro skips ids it
//! knows, so the first updates of that second history were stored as if
//! they changed nothing, and a later one, built on text this copy never had,
//! is refused ("text diff deletes 2 at 5 but state only has 6"). From then
//! on the document cannot be loaded, synced or reported.
//!
//! The repair reads the log again and sorts each update into the main
//! history or a fork: an update that overlaps ids already read, with a
//! different timestamp, starts a fork at its dependencies. Each fork's edits
//! are then made again under a new peer id, on the version the fork started
//! from, as if another device had made them at the same time, and merged
//! into the main history:
//! nothing typed in either is lost. The repaired document replaces the log
//! (one snapshot) after a safety backup, and the re-issued edits are queued
//! to sync. Updates that fit nowhere are kept aside (`held_updates`).

use loro::{ExportMode, LoroDoc, PeerID, VersionVector};
use folio_core::{DocId, DocKind};
use rusqlite::params;

use crate::{loro_err, Result, Store, StoreError};

/// A second history of one peer, from where it left the main one.
struct Fork {
    doc: LoroDoc,
    peer: PeerID,
    /// The peer's counter where the fork starts (its first reused id).
    from: i32,
    /// The version it starts from.
    base: VersionVector,
}

/// The peer a fork's edits are made again under, from all the fork has:
/// devices that repair the same fork make the same edits under the same ids,
/// which merge as one. A device with only part of the fork gets another
/// peer (its edits show twice, rather than two edits under one id).
fn fork_peer(f: &Fork) -> PeerID {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"folio.fork");
    h.update(f.peer.to_le_bytes());
    h.update(f.from.to_le_bytes());
    h.update(f.doc.oplog_vv().encode());
    let d = h.finalize();
    // Loro keeps u64::MAX for itself.
    u64::from_le_bytes(d[..8].try_into().expect("8 bytes")).min(u64::MAX - 1)
}

/// What a repair did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Repaired {
    /// Histories issued again under a new peer id.
    pub forks: usize,
    /// Updates that fit nowhere, kept aside.
    pub held: usize,
}

/// Rebuilds a document from its stored snapshot and updates (see the
/// module). Returns the document, how many forks were merged and the row
/// ids of updates that fit nowhere.
pub(crate) fn rebuild(snapshot: Option<&[u8]>, rows: &[(i64, Vec<u8>)]) -> Result<(LoroDoc, usize, Vec<i64>)> {
    let main = LoroDoc::new();
    if let Some(s) = snapshot {
        main.import(s).map_err(loro_err)?;
    }
    let mut forks: Vec<Fork> = Vec::new();
    let mut misfits = Vec::new();
    for (n, bytes) in rows {
        let Ok(meta) = LoroDoc::decode_import_blob_meta(bytes, false) else {
            misfits.push(*n);
            continue;
        };
        let start = &meta.partial_start_vv;
        // Once a peer has forked, its later writes go on the fork.
        let onto_fork = forks.iter().rev().find(|f| start.get(&f.peer).is_some_and(|c| *c >= f.from) && covers(&f.doc, &meta));
        if onto_fork.is_some_and(|f| imports_cleanly(&f.doc, bytes)) {
            continue;
        }
        let known = main.oplog_vv();
        let reused = start.iter().find(|(p, c)| known.get(p).is_some_and(|k| k > *c)).map(|(p, c)| (*p, *c));
        if let Some((peer, from)) = reused {
            // The update as it was written: on the version it was made on.
            let Ok(doc) = main.fork_at(&meta.start_frontiers) else {
                misfits.push(*n);
                continue;
            };
            let base = doc.oplog_vv();
            if !imports_cleanly(&doc, bytes) {
                misfits.push(*n);
            } else if same_as_main(&main, &doc) {
                // Sent twice: main has it already.
            } else {
                tracing::warn!(peer, from, "a peer wrote a second history over ids it had used; it will be issued again");
                forks.push(Fork { doc, peer, from, base });
            }
            continue;
        }
        if covers(&main, &meta) && imports_cleanly(&main, bytes) {
            continue;
        }
        // Made on a fork's text (another device saw it first).
        if !forks.iter().rev().any(|f| covers(&f.doc, &meta) && imports_cleanly(&f.doc, bytes)) {
            misfits.push(*n);
        }
    }
    let merged = forks.len();
    for f in forks {
        reissue(&main, &f, fork_peer(&f))?;
    }
    Ok((main, merged, misfits))
}

/// Whether `doc` has everything the update builds on.
fn covers(doc: &LoroDoc, meta: &loro::ImportBlobMetadata) -> bool {
    let vv = doc.oplog_vv();
    meta.start_frontiers.iter().all(|id| vv.includes_id(id)) && meta.partial_start_vv.iter().all(|(p, c)| vv.get(p).copied().unwrap_or(0) >= *c)
}

/// Whether main has the same document at `doc`'s version: an update sent
/// twice, not a second history under the same ids.
fn same_as_main(main: &LoroDoc, doc: &LoroDoc) -> bool {
    let vv = doc.oplog_vv();
    if !main.oplog_vv().includes_vv(&vv) {
        return false;
    }
    main.fork_at(&main.vv_to_frontiers(&vv)).is_ok_and(|m| m.get_deep_value() == doc.get_deep_value())
}

/// Imports an update that applies in full (not refused, nothing left
/// waiting); a refused import leaves the document as it was.
fn imports_cleanly(doc: &LoroDoc, bytes: &[u8]) -> bool {
    doc.import(bytes).is_ok_and(|s| s.pending.is_none())
}

/// Makes the fork's edits again under `peer`, on the version the fork
/// started from, and merges them into main as edits made at the same time
/// as main's own. Loro works out the new edits (`diff`, `apply_diff`), so
/// every kind of container keeps its ids right.
fn reissue(main: &LoroDoc, f: &Fork, peer: PeerID) -> Result<()> {
    let base = f.doc.vv_to_frontiers(&f.base);
    let diff = f.doc.diff(&base, &f.doc.oplog_frontiers()).map_err(loro_err)?;
    let again = main.fork_at(&base).map_err(loro_err)?;
    again.set_peer_id(peer).map_err(loro_err)?;
    again.apply_diff(diff).map_err(loro_err)?;
    again.commit();
    main.import(&again.export(ExportMode::updates(&f.base)).map_err(loro_err)?).map_err(loro_err)?;
    Ok(())
}

impl Store {
    /// Repairs a document whose log cannot be read (see the module), after a
    /// safety backup; the repaired document replaces the log. Fails, and
    /// changes nothing, when the repair does not read back the same.
    pub(crate) fn repair_doc(&mut self, id: &DocId, kind: DocKind) -> Result<(LoroDoc, Repaired)> {
        let snapshot: Option<Vec<u8>> = self.conn.query_row("SELECT snapshot FROM docs WHERE doc_id = ?1", [id.as_str()], |r| r.get(0))?;
        let rows: Vec<(i64, Vec<u8>)> = {
            let mut stmt = self.conn.prepare("SELECT id, bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY id")?;
            let rows = stmt.query_map([id.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let (doc, forks, misfits) = rebuild(snapshot.as_deref(), &rows)?;
        let repaired = doc.export(ExportMode::Snapshot).map_err(loro_err)?;
        let check = LoroDoc::new();
        check.import(&repaired).map_err(loro_err)?;
        if check.oplog_vv() != doc.oplog_vv() || check.get_deep_value() != doc.get_deep_value() {
            return Err(StoreError::Loro(format!("the repair of {id} does not read back the same")));
        }
        let now = crate::now_ms();
        self.backup_before_repair(&crate::backup::backups_dir(&self.dir), now)?;
        let tx = self.conn.unchecked_transaction()?;
        for (_, bytes) in rows.iter().filter(|(n, _)| misfits.contains(n)) {
            tx.execute(
                "INSERT INTO held_updates(doc_id, kind, bytes, error, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id.as_str(), kind.as_str(), bytes, "did not fit the repaired document", now],
            )?;
        }
        // A new change number: sync reports it, and open editors reload it.
        tx.execute(
            "UPDATE docs SET snapshot = ?2, snapshot_vv = ?3, updated_at = ?4,
               changed = (SELECT COALESCE(MAX(changed), 0) + 1 FROM docs) WHERE doc_id = ?1",
            params![id.as_str(), repaired, doc.oplog_vv().encode(), now],
        )?;
        tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", [id.as_str()])?;
        // Other devices get the re-issued edits, and everything they lack.
        if forks > 0 {
            tx.execute("INSERT INTO outbox(doc_id, bytes, at) VALUES (?1, ?2, ?3)", params![id.as_str(), doc.export(ExportMode::all_updates()).map_err(loro_err)?, now])?;
        }
        tx.commit()?;
        let report = Repaired { forks, held: misfits.len() };
        tracing::warn!(doc = %id, forks, held = report.held, rows = rows.len(), "repaired a document that could not be read");
        Ok((doc, report))
    }
}

#[cfg(test)]
mod tests {
    use folio_core::card::{append_paragraph, CardKind};

    use super::*;
    use crate::backup::{backups_dir, list_backups};

    const EDITOR: PeerID = 7;

    /// Stores an update as the log had it, without the checks of the write
    /// path (how the second history got there before 0.1.16).
    fn store_row(s: &Store, id: &DocId, bytes: &[u8]) {
        s.conn.execute("INSERT INTO doc_updates(doc_id, bytes, origin, at) VALUES (?1, ?2, 'local', 1)", params![id.as_str(), bytes]).unwrap();
    }

    fn edit(doc: &LoroDoc, f: impl FnOnce(&LoroDoc)) -> Vec<u8> {
        let v = doc.oplog_vv();
        f(doc);
        doc.commit();
        doc.export(ExportMode::updates(&v)).unwrap()
    }

    fn outbox(s: &Store) -> i64 {
        s.conn.query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_second_history_under_the_same_ids_is_merged_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let (id, editor_end) = {
            let mut s = Store::open(dir.path()).unwrap();
            let id = s.create_card(CardKind::Note, "Day", 1).unwrap();
            let a = LoroDoc::new();
            a.import(&s.doc_snapshot(&id).unwrap()).unwrap();
            a.set_peer_id(EDITOR).unwrap();
            store_row(&s, &id, &edit(&a, |d| drop(append_paragraph(d, "kept from before").unwrap())));
            // The editor reopened from this copy, with the same peer id…
            let b = LoroDoc::new();
            b.import(&a.export(ExportMode::Snapshot).unwrap()).unwrap();
            b.set_peer_id(EDITOR).unwrap();
            // …while the closed one had written on.
            let long = edit(&a, |d| drop(append_paragraph(d, &"first history ".repeat(8)).unwrap()));
            store_row(&s, &id, &long);
            store_row(&s, &id, &long); // sent twice
            let phone = LoroDoc::new();
            phone.import(&a.export(ExportMode::Snapshot).unwrap()).unwrap();
            phone.set_peer_id(99).unwrap();
            store_row(&s, &id, &edit(&phone, |d| drop(append_paragraph(d, "from the phone").unwrap())));
            // The second history: its first edit only reuses known ids, a
            // later one deletes text this log never had.
            store_row(&s, &id, &edit(&b, |d| d.get_text("t").insert(0, "abcdefgh").unwrap()));
            store_row(&s, &id, &edit(&b, |d| {
                let t = d.get_text("t");
                t.delete(5, 2).unwrap();
                t.insert(5, &"second history ".repeat(12)).unwrap();
            }));
            store_row(&s, &id, &edit(&b, |d| drop(append_paragraph(d, "written after reopening").unwrap())));
            let broken = s.load_doc(&id, LoroDoc::new());
            assert!(matches!(broken, Err(StoreError::Loro(_))), "the log cannot be read as it is");
            (id, phone.oplog_vv().get(&EDITOR).copied())
        };
        let mut s = Store::open(dir.path()).unwrap();
        let sent_before = outbox(&s);
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let text = s.card_summary(&id).unwrap().text;
        for kept in ["kept from before", "first history", "from the phone", "written after reopening"] {
            assert!(text.contains(kept), "{kept} is kept: {text}");
        }
        assert_eq!(text.matches("first history").count(), 8, "a resend is not a fork");
        let t = doc.get_text("t").to_string();
        assert!(t.starts_with("abcde") && t.ends_with("h") && t.contains("second history"), "{t}");
        let backups = list_backups(&backups_dir(dir.path())).unwrap();
        assert_eq!(backups.iter().filter(|b| b.reason.as_deref() == Some("repair")).count(), 1);
        assert_eq!(outbox(&s), sent_before + 1, "the merged document is sent");
        let log: i64 = s.conn.query_row("SELECT count(*) FROM doc_updates WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).unwrap();
        assert_eq!(log, 0, "the log is replaced by the repaired snapshot");
        // The editor's peer goes on from where the main history ends.
        assert_eq!(doc.oplog_vv().get(&EDITOR).copied(), editor_end);
        drop(s);
        // Once repaired it loads as it is.
        let mut s = Store::open(dir.path()).unwrap();
        assert_eq!(s.card_summary(&id).unwrap().text, text);
        assert_eq!(list_backups(&backups_dir(dir.path())).unwrap().len(), backups.len());
    }

    #[test]
    fn two_devices_repairing_the_same_fork_agree() {
        let base = LoroDoc::new();
        base.set_peer_id(EDITOR).unwrap();
        let mut rows = vec![(1, edit(&base, |d| d.get_text("t").insert(0, "base ").unwrap()))];
        let b = LoroDoc::new();
        b.import(&base.export(ExportMode::Snapshot).unwrap()).unwrap();
        b.set_peer_id(EDITOR).unwrap();
        rows.push((2, edit(&base, |d| d.get_text("t").insert(5, &"one ".repeat(10)).unwrap())));
        rows.push((3, edit(&b, |d| d.get_text("t").insert(5, "two").unwrap())));
        rows.push((4, edit(&b, |d| d.get_text("t").insert(8, &"more ".repeat(20)).unwrap())));
        let (one, forks, misfits) = rebuild(None, &rows).unwrap();
        assert_eq!((forks, misfits.len()), (1, 0));
        // The same log on another device: the same edits.
        let (same, _, _) = rebuild(None, &rows).unwrap();
        same.import(&one.export(ExportMode::all_updates()).unwrap()).unwrap();
        assert_eq!(same.get_deep_value(), one.get_deep_value());
        assert_eq!(same.oplog_vv(), one.oplog_vv());
        // A device with only part of the fork: shown twice, never broken.
        let (part, _, _) = rebuild(None, &rows[..3]).unwrap();
        part.import(&one.export(ExportMode::all_updates()).unwrap()).unwrap();
        one.import(&part.export(ExportMode::all_updates()).unwrap()).unwrap();
        assert_eq!(one.get_deep_value(), part.get_deep_value());
        assert_eq!(one.get_text("t").to_string().matches("two").count(), 2);
    }
}

