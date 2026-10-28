//! Files in cards: images and attachments (design/attachments.md §3).
//!
//! - A file is named by the SHA-256 of its content and never changes; it
//!   lives under `assets/` in the library, two levels of hash prefix deep.
//! - It arrives through an [`Incoming`] file in `assets/.incoming/`, hashed
//!   while written, and is renamed into place only when complete. A crash
//!   leaves at most an unreferenced file, never a half-written one that a
//!   card points at.
//! - Documents hold the hash; `assets` in `store.db` holds this device's
//!   state of each file, `idx.asset_refs` which cards use it.
//! - A file no card uses (the trash counts) is deleted after
//!   [`ORPHAN_GRACE_MS`], longer than backups are kept, so undo, restoring
//!   a card or a backup still finds it.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{Result, Store, StoreError};

/// The largest file a card can hold (design/attachments.md §9).
pub const MAX_ASSET_BYTES: u64 = 100 * 1024 * 1024;

/// How long a file no card uses is kept: longer than the daily backups
/// (`backup::BACKUPS_KEPT`) reach back.
pub const ORPHAN_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Unfinished incoming files older than this are left from a crash.
const STALE_INCOMING_MS: i64 = 24 * 60 * 60 * 1000;

const INCOMING: &str = ".incoming";

/// A file added to the library, as a card's node describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub sha256: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

/// What a sweep did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// Files no card uses any more, from now on.
    pub orphaned: usize,
    /// Files deleted after the grace period.
    pub deleted: usize,
}

pub fn assets_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("assets")
}

/// True for 64 lower-case hex digits: anything else is not a file name here.
pub fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn path_of(dir: &Path, sha256: &str) -> PathBuf {
    dir.join(&sha256[..2]).join(&sha256[2..4]).join(sha256)
}

/// The file for a hash in `assets_dir`, when it is there. For readers that
/// cannot hold the store (it is borrowed for something else).
pub fn stored_file(assets_dir: &Path, sha256: &str) -> Option<PathBuf> {
    is_hash(sha256).then(|| path_of(assets_dir, sha256)).filter(|p| p.is_file())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A file being written into the library.
pub struct Incoming {
    path: PathBuf,
    file: File,
    hasher: Sha256,
    size: u64,
}

impl Incoming {
    /// Starts a new file in `assets_dir`'s incoming folder.
    pub fn create(assets_dir: &Path) -> Result<Incoming> {
        let dir = assets_dir.join(INCOMING);
        fs::create_dir_all(&dir)?;
        let name = format!("{}-{:016x}", crate::now_ms(), loro::LoroDoc::new().peer_id());
        let path = dir.join(name);
        let file = File::create_new(&path)?;
        Ok(Incoming { path, file, hasher: Sha256::new(), size: 0 })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if self.size + bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(StoreError::TooLarge(MAX_ASSET_BYTES));
        }
        self.file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.size += bytes.len() as u64;
        Ok(())
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// The hash of the bytes written so far.
    pub fn sha256(&self) -> String {
        hex(&self.hasher.clone().finalize())
    }

    /// Where the bytes are so far, to read them back (HEIC conversion).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Gives up on the file.
    pub fn discard(self) {
        drop(self.file);
        let _ = fs::remove_file(&self.path);
    }
}

impl Store {
    pub fn assets_dir(&self) -> PathBuf {
        assets_dir(&self.dir)
    }

    /// Moves a finished incoming file into place and records it. The same
    /// content added twice is stored once.
    pub fn add_asset(&mut self, incoming: Incoming, name: &str, mime: &str, now_ms: i64) -> Result<AssetInfo> {
        let Incoming { path, file, hasher, size } = incoming;
        file.sync_all()?;
        drop(file);
        let sha256 = hex(&hasher.finalize());
        let target = path_of(&self.assets_dir(), &sha256);
        if target.exists() {
            fs::remove_file(&path)?;
        } else {
            fs::create_dir_all(target.parent().expect("hash folders"))?;
            fs::rename(&path, &target)?;
        }
        // A file added again is wanted again, even if it was orphaned.
        self.conn.execute(
            "INSERT INTO assets(sha256, mime, size, original_name, created_at, local, orphan_since)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, NULL)
             ON CONFLICT(sha256) DO UPDATE SET local = 1, orphan_since = NULL",
            params![sha256, mime, size as i64, name, now_ms],
        )?;
        Ok(AssetInfo { sha256, name: name.to_owned(), mime: mime.to_owned(), size })
    }

    /// The file and its type, when this device has it.
    pub fn asset_file(&self, sha256: &str) -> Result<Option<(PathBuf, String)>> {
        if !is_hash(sha256) {
            return Ok(None);
        }
        let mime: Option<Option<String>> =
            self.conn.query_row("SELECT mime FROM assets WHERE sha256 = ?1 AND local = 1", [sha256], |r| r.get(0)).optional()?;
        let path = path_of(&self.assets_dir(), sha256);
        Ok(match mime {
            Some(m) if path.is_file() => Some((path, m.unwrap_or_else(|| "application/octet-stream".into()))),
            _ => None,
        })
    }

    /// Files this device has that the server may not (design/attachments.md
    /// §5.3): hash and size, smallest first. Files no card uses wait.
    pub fn assets_to_upload(&self) -> Result<Vec<(String, u64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT sha256, size FROM assets WHERE local = 1 AND uploaded = 0 AND orphan_since IS NULL ORDER BY size, sha256",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?.into_iter().filter(|(sha, _)| is_hash(sha)).collect())
    }

    /// The server has the file.
    pub fn set_asset_uploaded(&self, sha256: &str) -> Result<()> {
        self.conn.execute("UPDATE assets SET uploaded = 1 WHERE sha256 = ?1", [sha256])?;
        Ok(())
    }

    /// The server lost the file (or deleted it as unused while a card here
    /// still used it): it goes up again.
    pub fn set_asset_not_uploaded(&self, sha256: &str) -> Result<()> {
        self.conn.execute("UPDATE assets SET uploaded = 0 WHERE sha256 = ?1 AND local = 1", [sha256])?;
        Ok(())
    }

    /// The files this device still uses, for the server to keep: those its
    /// cards use, whether here or not, and those added here and not yet
    /// let go. In hash order.
    pub fn used_assets(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT sha256 FROM idx.asset_refs UNION SELECT sha256 FROM assets WHERE local = 1 AND orphan_since IS NULL ORDER BY 1",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?.into_iter().filter(|sha| is_hash(sha)).collect())
    }

    /// Every file goes up again (this device joined another sync space).
    pub fn forget_uploads(&self) -> Result<()> {
        self.conn.execute("UPDATE assets SET uploaded = 0", [])?;
        Ok(())
    }

    /// Files cards use that this device does not have: hash and the type
    /// the cards record, in hash order.
    pub fn missing_assets(&self) -> Result<Vec<(String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT r.sha256, MAX(r.mime) FROM idx.asset_refs r
             WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.sha256 = r.sha256 AND a.local = 1)
             GROUP BY r.sha256 ORDER BY r.sha256",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?.into_iter().filter(|(sha, _)| is_hash(sha)).collect())
    }

    /// Stores a file downloaded from the server, if its content is what
    /// the hash says; otherwise discards it.
    pub fn add_downloaded_asset(&mut self, incoming: Incoming, sha256: &str, mime: &str, now_ms: i64) -> Result<AssetInfo> {
        if incoming.sha256() != sha256 {
            incoming.discard();
            return Err(StoreError::Damaged(format!("file {sha256}: the content does not match its hash")));
        }
        let info = self.add_asset(incoming, "", mime, now_ms)?;
        self.set_asset_uploaded(sha256)?;
        Ok(info)
    }

    /// Marks files no card uses, clears the mark on files used again, and
    /// deletes files unused for longer than the grace period. Also clears
    /// incoming files a crash left behind and records files on disk that
    /// were never recorded (a crash between moving and recording).
    pub fn sweep_assets(&mut self, now_ms: i64) -> Result<Swept> {
        let dir = self.assets_dir();
        if !dir.exists() {
            return Ok(Swept::default());
        }
        self.clear_stale_incoming(&dir, now_ms)?;
        self.record_unknown_files(&dir, now_ms)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE assets SET orphan_since = NULL WHERE orphan_since IS NOT NULL AND sha256 IN (SELECT sha256 FROM idx.asset_refs)", [])?;
        let orphaned = tx.execute(
            "UPDATE assets SET orphan_since = ?1 WHERE orphan_since IS NULL AND local = 1 AND sha256 NOT IN (SELECT sha256 FROM idx.asset_refs)",
            [now_ms],
        )?;
        let expired: Vec<String> = {
            let mut stmt = tx.prepare("SELECT sha256 FROM assets WHERE local = 1 AND orphan_since IS NOT NULL AND orphan_since <= ?1")?;
            stmt.query_map([now_ms - ORPHAN_GRACE_MS], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?
        };
        let mut deleted = 0;
        for sha256 in &expired {
            match fs::remove_file(path_of(&dir, sha256)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(asset = %sha256, error = %e, "could not delete an unused file");
                    continue;
                }
            }
            tx.execute("DELETE FROM assets WHERE sha256 = ?1", [sha256])?;
            deleted += 1;
        }
        tx.commit()?;
        if orphaned > 0 || deleted > 0 {
            tracing::info!(orphaned, deleted, "swept files");
        }
        Ok(Swept { orphaned, deleted })
    }

    fn clear_stale_incoming(&self, dir: &Path, now_ms: i64) -> Result<()> {
        let Ok(entries) = fs::read_dir(dir.join(INCOMING)) else { return Ok(()) };
        for e in entries.flatten() {
            let started = e.file_name().to_string_lossy().split('-').next().and_then(|s| s.parse::<i64>().ok());
            if started.is_none_or(|t| t < now_ms - STALE_INCOMING_MS) {
                let _ = fs::remove_file(e.path());
            }
        }
        Ok(())
    }

    fn record_unknown_files(&self, dir: &Path, now_ms: i64) -> Result<()> {
        for a in fs::read_dir(dir)?.flatten() {
            if a.file_name() == INCOMING || !a.path().is_dir() {
                continue;
            }
            for b in fs::read_dir(a.path())?.flatten() {
                for f in fs::read_dir(b.path())?.flatten() {
                    let name = f.file_name().to_string_lossy().into_owned();
                    if !is_hash(&name) {
                        continue;
                    }
                    let size = f.metadata().map(|m| m.len() as i64).unwrap_or(0);
                    self.conn.execute(
                        "INSERT OR IGNORE INTO assets(sha256, size, created_at, local) VALUES (?1, ?2, ?3, 1)",
                        params![name, size, now_ms],
                    )?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use folio_core::card::CardKind;
    use loro::LoroValue;

    fn add(s: &mut Store, bytes: &[u8], name: &str, now: i64) -> AssetInfo {
        let mut inc = Incoming::create(&s.assets_dir()).unwrap();
        inc.write(bytes).unwrap();
        s.add_asset(inc, name, "image/png", now).unwrap()
    }

    fn use_in_card(s: &mut Store, sha256: &str) -> folio_core::DocId {
        let id = s.create_card(CardKind::Note, "有图", 1).unwrap();
        let sha = sha256.to_owned();
        s.edit(&id, folio_core::DocKind::Card, 2, move |doc| {
            folio_core::body::add_block(doc, None, "image", &[("asset", LoroValue::from(sha.as_str())), ("bid", LoroValue::from("b1"))])?;
            doc.commit();
            Ok(())
        })
        .unwrap();
        id
    }

    #[test]
    fn same_content_is_stored_once_under_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let a = add(&mut s, b"png bytes", "a.png", 1);
        let b = add(&mut s, b"png bytes", "b.png", 2);
        assert_eq!(a.sha256, b.sha256);
        assert_eq!(a.sha256, hex(&Sha256::digest(b"png bytes")));
        assert_eq!((a.size, a.name.as_str()), (9, "a.png"));
        let (path, mime) = s.asset_file(&a.sha256).unwrap().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"png bytes");
        assert_eq!(mime, "image/png");
        assert!(path.starts_with(dir.path().join("assets").join(&a.sha256[..2]).join(&a.sha256[2..4])));
        assert_eq!(fs::read_dir(dir.path().join("assets/.incoming")).unwrap().count(), 0, "nothing left incoming");
        assert!(s.asset_file("../store.db").unwrap().is_none());
        assert!(s.asset_file(&"0".repeat(64)).unwrap().is_none());
    }

    #[test]
    fn too_large_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        let mut inc = Incoming::create(&s.assets_dir()).unwrap();
        inc.write(&vec![0u8; 1024]).unwrap();
        inc.size = MAX_ASSET_BYTES - 10;
        assert!(matches!(inc.write(&[0u8; 11]), Err(StoreError::TooLarge(_))));
        inc.discard();
        assert_eq!(fs::read_dir(dir.path().join("assets/.incoming")).unwrap().count(), 0);
    }

    #[test]
    fn unused_files_are_deleted_only_after_the_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let used = add(&mut s, b"used", "used.png", 1);
        let unused = add(&mut s, b"unused", "unused.png", 1);
        let card = use_in_card(&mut s, &used.sha256);

        let t0 = 1_000;
        assert_eq!(s.sweep_assets(t0).unwrap(), Swept { orphaned: 1, deleted: 0 });
        assert_eq!(s.sweep_assets(t0 + ORPHAN_GRACE_MS - 1).unwrap(), Swept::default());
        assert_eq!(s.sweep_assets(t0 + ORPHAN_GRACE_MS).unwrap(), Swept { orphaned: 0, deleted: 1 });
        assert!(s.asset_file(&unused.sha256).unwrap().is_none());
        assert!(s.asset_file(&used.sha256).unwrap().is_some());

        // A card in the trash still uses its files.
        s.trash_card(&card, 5).unwrap();
        assert_eq!(s.sweep_assets(t0 + 2 * ORPHAN_GRACE_MS).unwrap(), Swept::default());
        assert!(s.asset_file(&used.sha256).unwrap().is_some());
    }

    #[test]
    fn a_file_used_again_is_no_longer_counted_unused() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let a = add(&mut s, b"later", "later.png", 1);
        assert_eq!(s.sweep_assets(10).unwrap().orphaned, 1);
        use_in_card(&mut s, &a.sha256);
        s.sweep_assets(20).unwrap();
        assert_eq!(s.sweep_assets(10 + ORPHAN_GRACE_MS).unwrap().deleted, 0);
        assert!(s.asset_file(&a.sha256).unwrap().is_some());
    }

    #[test]
    fn a_crash_leaves_nothing_half_written_and_strays_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        // Crash while writing: the half file stays in .incoming until stale.
        let mut inc = Incoming::create(&s.assets_dir()).unwrap();
        inc.write(b"half").unwrap();
        let half = inc.path().to_path_buf();
        std::mem::forget(inc);
        // Crash after moving into place, before recording.
        let stray = "ab".repeat(32);
        let stray_path = path_of(&s.assets_dir(), &stray);
        fs::create_dir_all(stray_path.parent().unwrap()).unwrap();
        fs::write(&stray_path, b"stray").unwrap();

        let now = crate::now_ms();
        s.sweep_assets(now).unwrap();
        assert!(half.exists(), "a fresh incoming file may still be in use");
        assert!(s.asset_file(&stray).unwrap().is_some(), "recorded, and counted unused from now");
        s.sweep_assets(now + ORPHAN_GRACE_MS).unwrap();
        assert!(!half.exists());
        assert!(!stray_path.exists());
    }

    #[test]
    fn the_index_knows_which_cards_use_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let a = add(&mut s, b"x", "x.png", 1);
        let card = use_in_card(&mut s, &a.sha256);
        let refs = |s: &Store| -> Vec<String> {
            let mut stmt = s.conn.prepare("SELECT doc_id FROM idx.asset_refs WHERE sha256 = ?1").unwrap();
            stmt.query_map([&a.sha256], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(refs(&s), vec![card.to_string()]);
        s.rebuild_index().unwrap();
        assert_eq!(refs(&s), vec![card.to_string()]);
    }
}
