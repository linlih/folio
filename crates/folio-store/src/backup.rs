//! Local backups (design/ARCHITECTURE.md §5.4): copies of `store.db` made
//! with `VACUUM INTO`, the newest few kept. `index.db` is not backed up; it
//! is rebuilt from `store.db`.
//!
//! Restoring never just swaps databases while the app runs:
//! - one card goes back to a backup's version as a new edit (the frontend
//!   reverts the live document to the backup's version; see
//!   web/src/docs/restore.ts), so it syncs and can be undone;
//! - the whole library (disaster recovery) is replaced at the next start,
//!   after a safety backup of what is there now (`apply_pending_restore`).

use std::path::{Path, PathBuf};

use loro::{ExportMode, LoroDoc};
use folio_core::card::{self, CardSummary};
use folio_core::DocId;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::{loro_err, Result, Store, StoreError};

/// Backups kept; older ones are deleted when a new one is made.
pub const BACKUPS_KEPT: usize = 14;
/// A backup is made automatically when the newest is older than this.
pub const AUTO_BACKUP_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
const PREFIX: &str = "store-";
const SAFETY_SUFFIX: &str = "-before-restore";
/// Made before the store migrates the library to a new layout.
const UPGRADE_SUFFIX: &str = "-before-upgrade";
/// Names the backup to restore at the next start.
const PENDING: &str = "restore-pending";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// File name, also the backup's id.
    pub name: String,
    pub created_at: i64,
    pub size: u64,
    /// Made automatically before something replaced or rewrote the library,
    /// of what was there: never pruned.
    pub safety: bool,
    /// Why a safety backup was made: "restore" or "upgrade".
    pub reason: Option<String>,
}

/// A card as one backup has it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardVersion {
    pub backup: String,
    pub created_at: i64,
    pub title: String,
    pub preview: String,
    /// The backup's text is the same as the card's text now.
    pub same_as_now: bool,
}

pub fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn parse_name(name: &str) -> Option<(i64, Option<&'static str>)> {
    let stem = name.strip_prefix(PREFIX)?.strip_suffix(".db")?;
    let (ms, reason) = if let Some(ms) = stem.strip_suffix(SAFETY_SUFFIX) {
        (ms, Some("restore"))
    } else if let Some(ms) = stem.strip_suffix(UPGRADE_SUFFIX) {
        (ms, Some("upgrade"))
    } else {
        (stem, None)
    };
    Some((ms.parse().ok()?, reason))
}

/// Backups in `dir`, newest first.
pub fn list_backups(dir: &Path) -> Result<Vec<BackupInfo>> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some((created_at, reason)) = parse_name(&name) {
            out.push(BackupInfo { name, created_at, size: entry.metadata()?.len(), safety: reason.is_some(), reason: reason.map(str::to_owned) });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// A backup's path, refusing names that are not backups (no `..`).
fn backup_path(dir: &Path, name: &str) -> Result<PathBuf> {
    if parse_name(name).is_none() || name.contains(['/', '\\']) {
        return Err(StoreError::NotFound(name.to_owned()));
    }
    let path = dir.join(name);
    if !path.exists() {
        return Err(StoreError::NotFound(name.to_owned()));
    }
    Ok(path)
}

fn open_read_only(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?)
}

/// A document as a backup has it, or None when the backup predates it.
fn backup_doc(conn: &Connection, id: &DocId) -> Result<Option<LoroDoc>> {
    let snapshot: Option<Option<Vec<u8>>> =
        conn.query_row("SELECT snapshot FROM docs WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
    let Some(snapshot) = snapshot else { return Ok(None) };
    let doc = LoroDoc::new();
    if let Some(s) = snapshot {
        doc.import(&s).map_err(loro_err)?;
    }
    let mut stmt = conn.prepare("SELECT bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY id")?;
    for u in stmt.query_map([id.as_str()], |r| r.get::<_, Vec<u8>>(0))? {
        doc.import(&u?).map_err(loro_err)?;
    }
    Ok(Some(doc))
}

impl Store {
    /// Copies `store.db` into `dir` now and drops the oldest backups beyond
    /// `BACKUPS_KEPT` (safety backups are kept until the user deletes them).
    pub fn backup(&self, dir: &Path, now_ms: i64) -> Result<BackupInfo> {
        self.backup_named(dir, &format!("{PREFIX}{now_ms}.db"))?;
        let all = list_backups(dir)?;
        for old in all.iter().filter(|b| !b.safety).skip(BACKUPS_KEPT) {
            let _ = std::fs::remove_file(dir.join(&old.name));
        }
        all.into_iter()
            .find(|b| b.created_at == now_ms && !b.safety)
            .ok_or_else(|| StoreError::NotFound("new backup".into()))
    }

    /// A safety backup before the store migrates the library's layout.
    pub(crate) fn backup_before_upgrade(&self, dir: &Path, now_ms: i64) -> Result<()> {
        self.backup_named(dir, &format!("{PREFIX}{now_ms}{UPGRADE_SUFFIX}.db"))
    }

    fn backup_named(&self, dir: &Path, name: &str) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(name);
        // VACUUM INTO refuses an existing file.
        let _ = std::fs::remove_file(&path);
        self.conn.execute("VACUUM main INTO ?1", [path.to_string_lossy()])?;
        Ok(())
    }

    /// Makes a backup when the newest is older than a day; returns it if made.
    pub fn backup_if_due(&self, dir: &Path, now_ms: i64) -> Result<Option<BackupInfo>> {
        let newest = list_backups(dir)?.into_iter().filter(|b| !b.safety).map(|b| b.created_at).max();
        if newest.is_some_and(|t| now_ms - t < AUTO_BACKUP_AFTER_MS) {
            return Ok(None);
        }
        self.backup(dir, now_ms).map(Some)
    }

    /// The card in every backup that has it, newest first.
    pub fn card_versions(&mut self, dir: &Path, id: &DocId) -> Result<Vec<CardVersion>> {
        let now = self.card_summary(id)?;
        let mut out = Vec::new();
        for b in list_backups(dir)? {
            let conn = match open_read_only(&dir.join(&b.name)) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let Some(doc) = backup_doc(&conn, id)? else { continue };
            let CardSummary { title, preview, text, .. } = card::summarize(&doc);
            out.push(CardVersion { backup: b.name, created_at: b.created_at, title, preview, same_as_now: text == now.text && now.title == card::summarize(&doc).title });
        }
        Ok(out)
    }

    /// A document as a backup has it (snapshot form), for restoring one card.
    pub fn backup_doc_snapshot(dir: &Path, backup: &str, id: &DocId) -> Result<Option<Vec<u8>>> {
        let conn = open_read_only(&backup_path(dir, backup)?)?;
        match backup_doc(&conn, id)? {
            Some(doc) => Ok(Some(doc.export(ExportMode::Snapshot).map_err(loro_err)?)),
            None => Ok(None),
        }
    }
}

/// Asks for the whole library to be restored from `backup` at the next start
/// (for when the store cannot be opened; the app restores in place
/// otherwise, `replace_library`).
pub fn schedule_restore(data_dir: &Path, backup: &str) -> Result<()> {
    backup_path(&backups_dir(data_dir), backup)?;
    std::fs::write(data_dir.join(PENDING), backup)?;
    Ok(())
}

/// At start, before the store opens: a restore scheduled earlier.
pub fn apply_pending_restore(data_dir: &Path, now_ms: i64) -> Result<Option<String>> {
    let marker = data_dir.join(PENDING);
    let Ok(name) = std::fs::read_to_string(&marker) else { return Ok(None) };
    let name = name.trim().to_owned();
    // The marker goes first: a restore that fails must not repeat forever.
    std::fs::remove_file(&marker)?;
    replace_library(data_dir, &name, now_ms)?;
    Ok(Some(name))
}

/// Replaces `store.db` with a backup while no store has it open: the
/// current one is backed up first (a "before restore" backup), the backup
/// is copied next to it and renamed into place, so a failed copy never
/// leaves the library missing. The index is deleted and rebuilt on open.
pub fn replace_library(data_dir: &Path, backup: &str, now_ms: i64) -> Result<()> {
    let dir = backups_dir(data_dir);
    let source = backup_path(&dir, backup)?;
    let store_path = data_dir.join("store.db");
    if store_path.exists() {
        let current = Connection::open(&store_path)?;
        let safety = dir.join(format!("{PREFIX}{now_ms}{SAFETY_SUFFIX}.db"));
        let _ = std::fs::remove_file(&safety);
        current.execute("VACUUM main INTO ?1", [safety.to_string_lossy()])?;
    }
    let incoming = data_dir.join("store.db.incoming");
    std::fs::copy(&source, &incoming)?;
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("store.db{suffix}")));
    }
    std::fs::rename(&incoming, &store_path)?;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("index.db{suffix}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::LoroDoc;
    use folio_core::card::{append_paragraph, CardKind};
    use folio_core::DocKind;

    use crate::Origin;

    /// Adds a paragraph to a card through the store's write path.
    fn write(s: &mut Store, id: &DocId, text: &str, now: i64) {
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        append_paragraph(&doc, text).unwrap();
        let bytes = doc.export(ExportMode::updates(&v)).unwrap();
        s.apply_update(id, DocKind::Card, &bytes, Origin::Local, now).unwrap();
    }

    #[test]
    fn backs_up_keeps_the_newest_and_waits_a_day_between_automatic_ones() {
        let data = tempfile::tempdir().unwrap();
        let dir = backups_dir(data.path());
        let s = Store::open(data.path()).unwrap();
        assert!(s.backup_if_due(&dir, 1_000).unwrap().is_some());
        assert!(s.backup_if_due(&dir, 1_000 + AUTO_BACKUP_AFTER_MS - 1).unwrap().is_none());
        assert!(s.backup_if_due(&dir, 1_000 + AUTO_BACKUP_AFTER_MS).unwrap().is_some());
        for i in 0..20 {
            s.backup(&dir, 10_000_000_000 + i).unwrap();
        }
        let all = list_backups(&dir).unwrap();
        assert_eq!(all.len(), BACKUPS_KEPT);
        assert_eq!(all[0].created_at, 10_000_000_019);
        assert!(all[0].size > 0);
    }

    #[test]
    fn a_card_as_each_backup_has_it() {
        let data = tempfile::tempdir().unwrap();
        let dir = backups_dir(data.path());
        let mut s = Store::open(data.path()).unwrap();
        let id = s.create_card(CardKind::Note, "笔记", 1).unwrap();
        write(&mut s, &id, "第一版", 2);
        let first = s.backup(&dir, 100).unwrap();
        write(&mut s, &id, "第二版", 3);
        s.backup(&dir, 200).unwrap();
        let other = s.create_card(CardKind::Note, "later", 4).unwrap();

        let versions = s.card_versions(&dir, &id).unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions[0].same_as_now, "the newest backup matches now");
        assert!(!versions[1].same_as_now);
        assert_eq!(versions[1].preview, "第一版");
        // A card made after every backup is in none of them.
        assert!(s.card_versions(&dir, &other).unwrap().is_empty());

        let bytes = Store::backup_doc_snapshot(&dir, &first.name, &id).unwrap().unwrap();
        let doc = LoroDoc::new();
        doc.import(&bytes).unwrap();
        assert_eq!(card::summarize(&doc).text, "第一版");
        assert!(Store::backup_doc_snapshot(&dir, "../store.db", &id).is_err());
    }

    #[test]
    fn restores_the_whole_library_at_the_next_start_keeping_a_safety_copy() {
        let data = tempfile::tempdir().unwrap();
        let dir = backups_dir(data.path());
        let (kept, backup) = {
            let mut s = Store::open(data.path()).unwrap();
            let kept = s.create_card(CardKind::Note, "备份前", 1).unwrap();
            let b = s.backup(&dir, 100).unwrap();
            s.create_card(CardKind::Note, "备份后", 2).unwrap();
            (kept, b)
        };
        schedule_restore(data.path(), &backup.name).unwrap();
        assert_eq!(apply_pending_restore(data.path(), 500).unwrap(), Some(backup.name.clone()));
        // Only once.
        assert_eq!(apply_pending_restore(data.path(), 600).unwrap(), None);
        let s = Store::open(data.path()).unwrap();
        let titles: Vec<_> = s.list_cards(10).unwrap().into_iter().map(|c| c.title).collect();
        assert_eq!(titles, vec!["备份前"]);
        assert!(s.live_cards().unwrap().iter().any(|c| c.id == kept.as_str()));
        let safety: Vec<_> = list_backups(&dir).unwrap().into_iter().filter(|b| b.safety).collect();
        assert_eq!(safety.len(), 1);
        assert_eq!(safety[0].created_at, 500);
    }
}
