//! A second copy of the backups somewhere else (design/ARCHITECTURE.md
//! §5.4): another disk, a USB drive, a NAS or a cloud drive folder, so one
//! failing disk does not take the library and its backups together.
//!
//! The copy is a folder `Folio Backup` inside the folder the user chose:
//! - `store-<ms>.db`: the daily backups (not the safety ones), the newest
//!   [`BACKUPS_KEPT`](crate::backup::BACKUPS_KEPT) kept, as in the library;
//! - `assets/`: every image and attachment the library has, laid out as in
//!   the library. Files never change (they are named by their hash), so
//!   only new ones are copied; none is ever deleted from the copy here,
//!   since a library that lost its files must not make the copy lose them;
//! - `folio-backup.json`: which library the copy belongs to, so two
//!   libraries never mix their backups in one folder, and, for an
//!   encrypted copy, its key wrapped under the user's passphrase.
//!
//! **Encrypted or not** is the user's choice, made once per copy folder:
//! a cloud drive should not read the notes, a drive in a drawer may not
//! need a passphrase that can be forgotten. An encrypted copy seals every
//! backup and file with a [`Cipher`] (the sync crate's crypto, given by the
//! app: this crate cannot depend on it) and names files by a keyed hash,
//! so the folder shows neither content nor which files it holds. A folder
//! never mixes the two kinds.
//!
//! Everything is written next to its place first and renamed in only once
//! read back and checked against the original's hash (through the cipher
//! for an encrypted copy), so a drive pulled out mid-copy leaves at most a
//! `.partial` file.
//!
//! The chosen folder is never created: when it is not there (the drive is
//! not plugged in), nothing is written, or a missing `/Volumes/Drive`
//! would quietly become a folder on the computer's own disk.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::assets::{is_hash, path_of};
use crate::backup::{list_backups, BACKUPS_KEPT};

/// The folder made inside the chosen one.
pub const COPY_FOLDER: &str = "Folio Backup";
const MARKER: &str = "folio-backup.json";
const PARTIAL: &str = ".partial";

/// Seals what goes into an encrypted copy and opens it again.
pub trait Cipher {
    /// The name a file goes under instead of its hash (hex, at least 4
    /// characters, the same every time for the same hash).
    fn file_name(&self, sha256: &str) -> String;
    /// Writes `from` sealed; `id` (a backup's or file's name) is bound to
    /// it, so one cannot pass for another.
    fn seal(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()>;
    /// Writes what `from` holds, or fails for a wrong key or damaged data.
    fn open(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()>;
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    /// The chosen folder is not there (a drive not plugged in).
    #[error("{0} is not available")]
    Unavailable(PathBuf),
    /// The folder holds another library's backups.
    #[error("{0} holds the backups of another library")]
    Foreign(PathBuf),
    /// The folder is encrypted and no key was given, or the other way round.
    #[error("{} is {}encrypted", .0.display(), if *.1 { "" } else { "not " })]
    Mode(PathBuf, bool),
    /// A copied file did not read back the same.
    #[error("the copy of {0} differs from the original")]
    Differs(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("{0}")]
    Marker(#[from] serde_json::Error),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: u32,
    library: String,
    /// An encrypted copy's key, wrapped under the passphrase (opaque here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<serde_json::Value>,
}

/// What a copy did this time.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub copied_backups: usize,
    pub copied_files: usize,
    /// Files the library has that could not be copied (unreadable, or not
    /// what their name says); they are tried again next time.
    pub skipped_files: usize,
}

/// Whose backups a folder holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "library")]
pub enum Owner {
    /// No copy there yet.
    None,
    /// This library's (the id given).
    Ours,
    /// Another library's: its id, to adopt when restoring from it.
    Other(String),
}

/// The copy folder for a chosen folder: the chosen one itself when it
/// already is a copy (picked again on a new computer), else `Folio Backup`
/// inside it.
pub fn copy_dir(chosen: &Path) -> PathBuf {
    if chosen.join(MARKER).is_file() { chosen.to_path_buf() } else { chosen.join(COPY_FOLDER) }
}

fn read_marker(dir: &Path) -> Result<Option<Marker>, CopyError> {
    match fs::read(dir.join(MARKER)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Whose backups the copy for `chosen` holds; Unavailable when the chosen
/// folder is not there.
pub fn owner(chosen: &Path, library: &str) -> Result<Owner, CopyError> {
    if !chosen.is_dir() {
        return Err(CopyError::Unavailable(chosen.to_path_buf()));
    }
    Ok(match read_marker(&copy_dir(chosen))? {
        None => Owner::None,
        Some(m) if m.library == library => Owner::Ours,
        Some(m) => Owner::Other(m.library),
    })
}

/// An existing copy's wrapped key: Some for an encrypted copy, None for a
/// plain one or none at all.
pub fn wrapped_key(chosen: &Path) -> Result<Option<serde_json::Value>, CopyError> {
    if !chosen.is_dir() {
        return Err(CopyError::Unavailable(chosen.to_path_buf()));
    }
    Ok(read_marker(&copy_dir(chosen))?.and_then(|m| m.key))
}

/// Copies the library's daily backups and every file it has into the copy
/// for `chosen`, and drops the copy's oldest backups beyond the kept
/// number. A new copy is made encrypted when `cipher` is given, with
/// `wrapped` (the key under the passphrase) written down for restoring.
/// Refuses a folder holding another library's backups, or of the other
/// kind (encrypted or not).
pub fn copy_backups(
    backups_dir: &Path,
    assets_dir: &Path,
    chosen: &Path,
    library: &str,
    cipher: Option<&dyn Cipher>,
    wrapped: Option<&serde_json::Value>,
) -> Result<CopyReport, CopyError> {
    let dir = copy_dir(chosen);
    match owner(chosen, library)? {
        Owner::Other(_) => return Err(CopyError::Foreign(dir)),
        Owner::Ours => {
            let encrypted = wrapped_key(chosen)?.is_some();
            if encrypted != cipher.is_some() {
                return Err(CopyError::Mode(dir, encrypted));
            }
        }
        Owner::None => {
            if cipher.is_some() != wrapped.is_some() {
                return Err(CopyError::Mode(dir, wrapped.is_some()));
            }
            fs::create_dir_all(&dir)?;
            let marker = serde_json::to_vec_pretty(&Marker { version: 1, library: library.to_owned(), key: wrapped.cloned() })?;
            write_checked(&dir.join(MARKER), |out| out.write_all(&marker), |p| Ok(fs::read(p)? == marker))?;
        }
    }
    let mut report = CopyReport::default();

    // Backups: oldest first, so a copy cut short still has the earlier ones.
    let mut ours: Vec<_> = list_backups(backups_dir).map_err(io_err)?.into_iter().filter(|b| !b.safety).collect();
    ours.reverse();
    for b in &ours {
        let target = dir.join(&b.name);
        if target.is_file() {
            continue;
        }
        let source = backups_dir.join(&b.name);
        let expected = hash_file(&source)?;
        put(&source, &target, &b.name, &expected, cipher)?;
        report.copied_backups += 1;
    }
    for old in list_backups(&dir).map_err(io_err)?.iter().filter(|b| !b.safety).skip(BACKUPS_KEPT) {
        let _ = fs::remove_file(dir.join(&old.name));
    }

    // Files.
    let into = dir.join("assets");
    for sha256 in hashes_in(assets_dir)? {
        let target = path_of(&into, &name_of(&sha256, cipher));
        if target.is_file() {
            continue;
        }
        let source = path_of(assets_dir, &sha256);
        match hash_file(&source) {
            Ok(h) if h == sha256 => {}
            Ok(_) => {
                tracing::warn!(asset = %sha256, "a file in the library does not match its name; not copied");
                report.skipped_files += 1;
                continue;
            }
            Err(e) => {
                tracing::warn!(asset = %sha256, error = %e, "could not read a file in the library; not copied");
                report.skipped_files += 1;
                continue;
            }
        }
        fs::create_dir_all(target.parent().expect("hash folders"))?;
        put(&source, &target, &sha256, &sha256, cipher)?;
        report.copied_files += 1;
    }
    clear_partials(&dir);
    Ok(report)
}

/// Writes a backup from the copy, opened, to `to` (for the library to be
/// replaced with it). Refuses names that are not backups.
pub fn take_backup(copy: &Path, name: &str, to: &Path, cipher: Option<&dyn Cipher>) -> Result<(), CopyError> {
    if !list_backups(copy).map_err(io_err)?.iter().any(|b| b.name == name) {
        return Err(CopyError::Io(io::Error::new(io::ErrorKind::NotFound, format!("no backup {name}"))));
    }
    let from = copy.join(name);
    let _ = fs::remove_file(to);
    let written = (|| -> io::Result<()> {
        let mut out = File::create(to)?;
        match cipher {
            Some(c) => c.open(name, &mut File::open(&from)?, &mut out)?,
            None => {
                io::copy(&mut File::open(&from)?, &mut out)?;
            }
        }
        out.sync_all()
    })();
    if written.is_err() {
        let _ = fs::remove_file(to);
    }
    Ok(written?)
}

/// Copies from a copy's `assets/` into the library's the files of `wanted`
/// that the library lacks (after restoring a backup from the copy), each
/// checked against its hash. Returns how many came back.
pub fn restore_files(copy: &Path, assets_dir: &Path, wanted: &[String], cipher: Option<&dyn Cipher>) -> Result<usize, CopyError> {
    let from = copy.join("assets");
    let mut n = 0;
    for sha256 in wanted.iter().filter(|s| is_hash(s)) {
        let target = path_of(assets_dir, sha256);
        let source = path_of(&from, &name_of(sha256, cipher));
        if target.is_file() || !source.is_file() {
            continue;
        }
        fs::create_dir_all(target.parent().expect("hash folders"))?;
        match get(&source, &target, sha256, cipher) {
            Ok(()) => n += 1,
            Err(CopyError::Differs(_)) => tracing::warn!(asset = %sha256, "a file in the backup copy is damaged; not restored"),
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// The size of a copy folder and how many files and backups it has.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySize {
    pub backups: usize,
    pub files: usize,
    pub bytes: u64,
}

pub fn size(copy: &Path) -> CopySize {
    let backups = list_backups(copy).unwrap_or_default();
    let mut out = CopySize { backups: backups.len(), files: 0, bytes: backups.iter().map(|b| b.size).sum() };
    let assets = copy.join("assets");
    for name in names_in(&assets).unwrap_or_default() {
        out.files += 1;
        out.bytes += fs::metadata(path_of(&assets, &name)).map(|m| m.len()).unwrap_or(0);
    }
    out
}

fn name_of(sha256: &str, cipher: Option<&dyn Cipher>) -> String {
    cipher.map_or_else(|| sha256.to_owned(), |c| c.file_name(sha256))
}

/// Writes `source` into the copy at `target` (sealed with `cipher`), and
/// checks it reads back as `expected` before it is renamed into place.
fn put(source: &Path, target: &Path, id: &str, expected: &str, cipher: Option<&dyn Cipher>) -> Result<(), CopyError> {
    write_checked(
        target,
        |out| match cipher {
            Some(c) => c.seal(id, &mut File::open(source)?, out),
            None => io::copy(&mut File::open(source)?, out).map(|_| ()),
        },
        |p| opened_hash(p, id, cipher).map(|h| h == expected),
    )
}

/// The other way: from the copy into the library, checked against `sha256`.
fn get(source: &Path, target: &Path, sha256: &str, cipher: Option<&dyn Cipher>) -> Result<(), CopyError> {
    if opened_hash(source, sha256, cipher).ok().as_deref() != Some(sha256) {
        return Err(CopyError::Differs(sha256.to_owned()));
    }
    write_checked(
        target,
        |out| match cipher {
            Some(c) => c.open(sha256, &mut File::open(source)?, out),
            None => io::copy(&mut File::open(source)?, out).map(|_| ()),
        },
        |p| hash_file(p).map(|h| h == sha256),
    )
}

/// The hash of what a file in the copy holds (opened, when encrypted).
fn opened_hash(path: &Path, id: &str, cipher: Option<&dyn Cipher>) -> io::Result<String> {
    match cipher {
        None => hash_file(path),
        Some(c) => {
            let mut h = HashWriter(Sha256::new());
            c.open(id, &mut File::open(path)?, &mut h)?;
            Ok(hex(&h.0.finalize()))
        }
    }
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The files under an assets folder (`aa/bb/<name>`), by name: hashes in
/// the library and in a plain copy, keyed names in an encrypted one.
fn names_in(dir: &Path) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    let Ok(level1) = fs::read_dir(dir) else { return Ok(out) };
    for a in level1.flatten() {
        if !a.path().is_dir() || a.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        for b in fs::read_dir(a.path())?.flatten() {
            if !b.path().is_dir() {
                continue;
            }
            for f in fs::read_dir(b.path())?.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.len() >= 4 && name.bytes().all(|c| c.is_ascii_hexdigit()) && f.path().is_file() {
                    out.push(name);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

fn hashes_in(dir: &Path) -> io::Result<Vec<String>> {
    Ok(names_in(dir)?.into_iter().filter(|n| is_hash(n)).collect())
}

/// Writes `<target>.partial` with `fill`, flushes it to the disk, checks
/// it with `check`, then renames it into place.
fn write_checked(
    target: &Path,
    fill: impl FnOnce(&mut dyn Write) -> io::Result<()>,
    check: impl Fn(&Path) -> io::Result<bool>,
) -> Result<(), CopyError> {
    let mut partial = target.as_os_str().to_owned();
    partial.push(PARTIAL);
    let partial = PathBuf::from(partial);
    let written = (|| {
        let mut out = File::create(&partial)?;
        fill(&mut out)?;
        out.flush()?;
        out.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&partial);
        return Err(e.into());
    }
    match check(&partial) {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_file(&partial);
            return Err(CopyError::Differs(target.display().to_string()));
        }
        Err(e) => {
            let _ = fs::remove_file(&partial);
            return Err(e.into());
        }
    }
    fs::rename(&partial, target)?;
    Ok(())
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Leftovers of a copy cut short (a drive pulled out).
fn clear_partials(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().ends_with(PARTIAL) {
            let _ = fs::remove_file(e.path());
        }
    }
}

fn io_err(e: crate::StoreError) -> io::Error {
    match e {
        crate::StoreError::Io(e) => e,
        other => io::Error::other(other.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::backup::backups_dir;
    use crate::{Incoming, Store};

    fn add_file(s: &mut Store, bytes: &[u8]) -> String {
        let mut inc = Incoming::create(&s.assets_dir()).unwrap();
        inc.write(bytes).unwrap();
        s.add_asset(inc, "a.png", "image/png", 1).unwrap().sha256
    }

    /// A toy cipher for the tests (the real one is the sync crate's):
    /// XOR with a key byte, the id written first and checked on opening.
    pub(crate) struct Xor(pub u8);

    impl Cipher for Xor {
        fn file_name(&self, sha256: &str) -> String {
            format!("{:x}", Sha256::digest(format!("{}{sha256}", self.0)))[..32].to_owned()
        }
        fn seal(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()> {
            let mut buf = Vec::new();
            from.read_to_end(&mut buf)?;
            to.write_all(&[self.0])?;
            to.write_all(&(id.len() as u32).to_le_bytes())?;
            to.write_all(id.as_bytes())?;
            to.write_all(&buf.iter().map(|b| b ^ self.0).collect::<Vec<_>>())
        }
        fn open(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()> {
            let mut buf = Vec::new();
            from.read_to_end(&mut buf)?;
            let bad = || io::Error::other("wrong key or damaged");
            if buf.first() != Some(&self.0) || buf.len() < 5 {
                return Err(bad());
            }
            let n = u32::from_le_bytes(buf[1..5].try_into().unwrap()) as usize;
            if buf.get(5..5 + n) != Some(id.as_bytes()) {
                return Err(bad());
            }
            to.write_all(&buf[5 + n..].iter().map(|b| b ^ self.0).collect::<Vec<_>>())
        }
    }

    #[test]
    fn copies_backups_and_files_once_and_keeps_the_newest_backups() {
        let lib = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let mut s = Store::open(lib.path()).unwrap();
        let bdir = backups_dir(lib.path());
        let sha = add_file(&mut s, b"picture");
        s.backup(&bdir, 100).unwrap();

        let r = copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib-a", None, None).unwrap();
        assert_eq!((r.copied_backups, r.copied_files, r.skipped_files), (1, 1, 0));
        let dir = chosen.path().join(COPY_FOLDER);
        assert_eq!(fs::read(path_of(&dir.join("assets"), &sha)).unwrap(), b"picture");
        assert_eq!(fs::read(bdir.join("store-100.db")).unwrap(), fs::read(dir.join("store-100.db")).unwrap());

        // Nothing new: nothing copied.
        let r = copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib-a", None, None).unwrap();
        assert_eq!((r.copied_backups, r.copied_files), (0, 0));

        for i in 0..20 {
            s.backup(&bdir, 1_000 + i).unwrap();
        }
        copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib-a", None, None).unwrap();
        let kept = list_backups(&dir).unwrap();
        assert_eq!(kept.len(), BACKUPS_KEPT);
        assert_eq!(kept[0].created_at, 1_019);
        assert_eq!(size(&dir), CopySize { backups: BACKUPS_KEPT, files: 1, bytes: kept.iter().map(|b| b.size).sum::<u64>() + 7 });
        // Picking the copy folder itself (on a new computer) finds it.
        assert_eq!(copy_dir(&dir), dir);
        assert_eq!(owner(&dir, "lib-a").unwrap(), Owner::Ours);
        assert_eq!(wrapped_key(&dir).unwrap(), None);
    }

    #[test]
    fn never_creates_a_missing_folder_or_mixes_two_libraries() {
        let lib = tempfile::tempdir().unwrap();
        let s = Store::open(lib.path()).unwrap();
        let bdir = backups_dir(lib.path());
        s.backup(&bdir, 100).unwrap();

        let gone = lib.path().join("unplugged-drive");
        assert!(matches!(copy_backups(&bdir, &s.assets_dir(), &gone, "lib-a", None, None), Err(CopyError::Unavailable(_))));
        assert!(!gone.exists());

        let chosen = tempfile::tempdir().unwrap();
        copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib-a", None, None).unwrap();
        assert_eq!(owner(chosen.path(), "lib-b").unwrap(), Owner::Other("lib-a".into()));
        assert!(matches!(copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib-b", None, None), Err(CopyError::Foreign(_))));
    }

    #[test]
    fn a_damaged_file_is_not_copied_and_files_are_never_deleted_from_the_copy() {
        let lib = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let mut s = Store::open(lib.path()).unwrap();
        let bdir = backups_dir(lib.path());
        let good = add_file(&mut s, b"good");
        let bad = add_file(&mut s, b"bad");
        fs::write(path_of(&s.assets_dir(), &bad), b"rotten").unwrap();

        let r = copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib", None, None).unwrap();
        assert_eq!((r.copied_files, r.skipped_files), (1, 1));
        let into = chosen.path().join(COPY_FOLDER).join("assets");
        assert!(path_of(&into, &good).is_file());
        assert!(!path_of(&into, &bad).exists());

        // The library loses its files: the copy keeps them.
        fs::remove_dir_all(s.assets_dir()).unwrap();
        copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib", None, None).unwrap();
        assert!(path_of(&into, &good).is_file());

        // And they come back.
        let wanted = vec![good.clone(), bad.clone()];
        assert_eq!(restore_files(&chosen.path().join(COPY_FOLDER), &s.assets_dir(), &wanted, None).unwrap(), 1);
        assert_eq!(fs::read(path_of(&s.assets_dir(), &good)).unwrap(), b"good");
    }

    #[test]
    fn an_encrypted_copy_hides_content_and_names_and_never_mixes_with_a_plain_one() {
        let lib = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let mut s = Store::open(lib.path()).unwrap();
        let bdir = backups_dir(lib.path());
        let sha = add_file(&mut s, b"secret picture");
        s.backup(&bdir, 100).unwrap();
        let key = serde_json::json!({ "wrapped": "under the passphrase" });
        let c = Xor(0x5a);

        let r = copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib", Some(&c), Some(&key)).unwrap();
        assert_eq!((r.copied_backups, r.copied_files), (1, 1));
        let dir = chosen.path().join(COPY_FOLDER);
        assert_eq!(wrapped_key(chosen.path()).unwrap(), Some(key.clone()));
        // Neither the file's hash nor its bytes show.
        assert!(!path_of(&dir.join("assets"), &sha).exists());
        let sealed = path_of(&dir.join("assets"), &c.file_name(&sha));
        assert!(!fs::read(&sealed).unwrap().windows(6).any(|w| w == b"secret"));
        assert_ne!(fs::read(dir.join("store-100.db")).unwrap(), fs::read(bdir.join("store-100.db")).unwrap());
        // Again: nothing new.
        assert_eq!(copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib", Some(&c), None).unwrap().copied_files, 0);

        // A plain copy into it, or an encrypted one into a plain folder: refused.
        assert!(matches!(copy_backups(&bdir, &s.assets_dir(), chosen.path(), "lib", None, None), Err(CopyError::Mode(_, true))));
        let plain = tempfile::tempdir().unwrap();
        copy_backups(&bdir, &s.assets_dir(), plain.path(), "lib", None, None).unwrap();
        assert!(matches!(copy_backups(&bdir, &s.assets_dir(), plain.path(), "lib", Some(&c), Some(&key)), Err(CopyError::Mode(_, false))));

        // Back out: the backup opens, the file comes back; a wrong key gets nothing.
        let out = lib.path().join("restored.db");
        take_backup(&dir, "store-100.db", &out, Some(&c)).unwrap();
        assert_eq!(fs::read(&out).unwrap(), fs::read(bdir.join("store-100.db")).unwrap());
        assert!(take_backup(&dir, "store-100.db", &out, Some(&Xor(1))).is_err());
        assert!(!out.exists(), "nothing half-written is left");
        assert!(take_backup(&dir, "../store.db", &out, Some(&c)).is_err());
        fs::remove_dir_all(s.assets_dir()).unwrap();
        assert_eq!(restore_files(&dir, &s.assets_dir(), &[sha.clone()], Some(&Xor(1))).unwrap(), 0);
        assert_eq!(restore_files(&dir, &s.assets_dir(), &[sha.clone()], Some(&c)).unwrap(), 1);
        assert_eq!(fs::read(path_of(&s.assets_dir(), &sha)).unwrap(), b"secret picture");
    }

    #[test]
    fn a_copy_cut_short_leaves_no_file_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("store-1.db");
        assert!(write_checked(&target, |_| Err(io::Error::other("drive removed")), |_| Ok(true)).is_err());
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none(), "no partial, no target");
        assert!(matches!(write_checked(&target, |o| o.write_all(b"x"), |_| Ok(false)), Err(CopyError::Differs(_))));
        assert!(!target.exists());
    }
}
