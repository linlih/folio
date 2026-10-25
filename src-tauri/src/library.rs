//! Where the library lives (design/ARCHITECTURE.md §5.7): the app's data
//! folder unless the user chose another; then a small pointer file in the
//! app folder names it. Moving copies the library, checks the copy byte for
//! byte, and only then switches; the original is renamed aside, never
//! deleted.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// In the app folder: `{ "path": "/where/the/library/is" }`.
pub const POINTER: &str = "library.json";

/// The library's own database; a folder holding it is a library.
const STORE: &str = "store.db";

/// The name of the folder a library is moved into when the chosen folder
/// has other things in it.
pub const FOLDER_NAME: &str = "Folio";

#[derive(Serialize, Deserialize)]
struct Pointer {
    path: PathBuf,
}

/// The chosen library folder, if one was chosen.
pub fn read_pointer(app_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(app_dir.join(POINTER)).ok()?;
    let p: Pointer = serde_json::from_str(&text).ok()?;
    p.path.is_absolute().then_some(p.path)
}

/// Remembers `path` as the library; `None` goes back to the default. Written
/// next to the old one and renamed over it, so it is never half written.
pub fn write_pointer(app_dir: &Path, path: Option<&Path>) -> io::Result<()> {
    let file = app_dir.join(POINTER);
    let Some(path) = path else {
        return match fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    };
    fs::create_dir_all(app_dir)?;
    let tmp = app_dir.join(format!("{POINTER}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(&Pointer { path: path.to_path_buf() })?)?;
    fs::rename(tmp, file)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderKind {
    /// A Folio library.
    Library,
    /// Missing or empty: a new library can start here.
    Empty,
    /// Something else is in it.
    Other,
}

/// Files the system leaves in folders, which do not make a folder "used".
fn is_noise(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".localized")
}

pub fn inspect(dir: &Path) -> FolderKind {
    if dir.join(STORE).is_file() {
        return FolderKind::Library;
    }
    match fs::read_dir(dir) {
        Err(_) => FolderKind::Empty,
        Ok(entries) => {
            let used = entries.flatten().any(|e| !is_noise(&e.file_name().to_string_lossy()));
            if used { FolderKind::Other } else { FolderKind::Empty }
        }
    }
}

/// Folders kept in sync by a cloud drive. A library there can be damaged:
/// the drive copies the database while it is being written, and two
/// computers would open the same library as the same device (§5.7).
pub fn is_cloud_synced(path: &Path) -> bool {
    let p = path.to_string_lossy();
    ["/Library/Mobile Documents/", "/Library/CloudStorage/", "/Dropbox", "/OneDrive", "/Google Drive", "/iCloudDrive", "\\Dropbox", "\\OneDrive", "\\iCloudDrive", "\\Google Drive"]
        .iter()
        .any(|m| p.contains(m))
}

#[derive(Debug, thiserror::Error)]
pub enum MoveError {
    #[error("the library is already there")]
    Same,
    #[error("a library cannot be moved into itself")]
    IntoItself,
    #[error("there is already a library in {0}")]
    Occupied(PathBuf),
    #[error("{0} is not empty")]
    NotEmpty(PathBuf),
    #[error("the copy differs from the library at {0}")]
    Differs(PathBuf),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Where a library moved to `chosen` goes: the folder itself when it is
/// empty, else a `Folio` folder in it.
pub fn move_target(from: &Path, chosen: &Path) -> Result<PathBuf, MoveError> {
    let target = match inspect(chosen) {
        FolderKind::Library => return Err(if same(chosen, from) { MoveError::Same } else { MoveError::Occupied(chosen.to_path_buf()) }),
        FolderKind::Empty => chosen.to_path_buf(),
        FolderKind::Other => {
            let inner = chosen.join(FOLDER_NAME);
            match inspect(&inner) {
                FolderKind::Empty => inner,
                FolderKind::Library => return Err(if same(&inner, from) { MoveError::Same } else { MoveError::Occupied(inner) }),
                FolderKind::Other => return Err(MoveError::NotEmpty(inner)),
            }
        }
    };
    if same(&target, from) {
        return Err(MoveError::Same);
    }
    if absolute(&target).starts_with(absolute(from)) {
        return Err(MoveError::IntoItself);
    }
    Ok(target)
}

fn absolute(p: &Path) -> PathBuf {
    // A folder that does not exist yet: its parent's real path.
    fs::canonicalize(p).unwrap_or_else(|_| match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => absolute(parent).join(name),
        _ => p.to_path_buf(),
    })
}

fn same(a: &Path, b: &Path) -> bool {
    absolute(a) == absolute(b)
}

/// Moves a closed library from `from` to `to` (from `move_target`):
/// copies it next to `to`, compares every file, renames the copy into
/// place, then renames the original aside to `<name>.moved-<now>`. Returns
/// where the original now is. On any failure the original is untouched and
/// the half-made copy removed.
pub fn move_library(from: &Path, to: &Path, now_ms: i64) -> Result<PathBuf, MoveError> {
    let parent = to.parent().ok_or_else(|| io::Error::other("no parent folder"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".folio-moving-{now_ms}"));
    let copied = copy_dir(from, &staging).and_then(|()| {
        if same_files(from, &staging)? { Ok(()) } else { Err(MoveError::Differs(staging.clone())) }
    });
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    // `to` may be the empty folder the user picked: only an empty one goes.
    let placed = (|| {
        if to.exists() {
            clear_noise(to)?;
            fs::remove_dir(to)?;
        }
        fs::rename(&staging, to)
    })();
    if let Err(e) = placed {
        let _ = fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "library".into());
    let aside = from.with_file_name(format!("{name}.moved-{now_ms}"));
    fs::rename(from, &aside)?;
    Ok(aside)
}

fn clear_noise(dir: &Path) -> io::Result<()> {
    for e in fs::read_dir(dir)?.flatten() {
        if is_noise(&e.file_name().to_string_lossy()) {
            fs::remove_file(e.path())?;
        }
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), MoveError> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let kind = e.file_type()?;
        let dest = to.join(e.file_name());
        if kind.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

/// Every file under `a` is under `b` with the same bytes, and nothing more.
fn same_files(a: &Path, b: &Path) -> io::Result<bool> {
    let (fa, fb) = (files(a)?, files(b)?);
    if fa != fb {
        return Ok(false);
    }
    for rel in &fa {
        if !same_bytes(&a.join(rel), &b.join(rel))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for e in fs::read_dir(root.join(&rel))? {
            let e = e?;
            let kind = e.file_type()?;
            if kind.is_dir() {
                stack.push(rel.join(e.file_name()));
            } else if kind.is_file() {
                out.push(rel.join(e.file_name()));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut ra, mut rb) = (fs::File::open(a)?, fs::File::open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = ra.read(&mut ba)?;
        if n == 0 {
            return Ok(true);
        }
        rb.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("folio-library-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn library(dir: &Path) {
        fs::create_dir_all(dir.join("backups")).unwrap();
        fs::write(dir.join(STORE), vec![7u8; 200_000]).unwrap();
        fs::write(dir.join("store.db-wal"), b"wal").unwrap();
        fs::write(dir.join("backups/folio-1.db"), b"backup").unwrap();
    }

    #[test]
    fn pointer_round_trip() {
        let app = temp("pointer");
        assert_eq!(read_pointer(&app), None);
        write_pointer(&app, Some(Path::new("/x/Folio"))).unwrap();
        assert_eq!(read_pointer(&app), Some(PathBuf::from("/x/Folio")));
        write_pointer(&app, None).unwrap();
        assert_eq!(read_pointer(&app), None);
        write_pointer(&app, None).unwrap();
        // A relative path is not trusted.
        fs::write(app.join(POINTER), r#"{"path":"rel"}"#).unwrap();
        assert_eq!(read_pointer(&app), None);
    }

    #[test]
    fn tells_folders_apart() {
        let root = temp("inspect");
        assert_eq!(inspect(&root.join("missing")), FolderKind::Empty);
        fs::write(root.join(".DS_Store"), b"").unwrap();
        assert_eq!(inspect(&root), FolderKind::Empty);
        fs::write(root.join("notes.txt"), b"x").unwrap();
        assert_eq!(inspect(&root), FolderKind::Other);
        library(&root.join("lib"));
        assert_eq!(inspect(&root.join("lib")), FolderKind::Library);
        assert!(is_cloud_synced(Path::new("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Folio")));
        assert!(!is_cloud_synced(Path::new("/Users/a/Documents/Folio")));
    }

    #[test]
    fn picks_where_a_move_goes() {
        let root = temp("target");
        let from = root.join("data");
        library(&from);
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(move_target(&from, &empty).unwrap(), empty);
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("a.txt"), b"x").unwrap();
        assert_eq!(move_target(&from, &docs).unwrap(), docs.join(FOLDER_NAME));
        assert!(matches!(move_target(&from, &from), Err(MoveError::Same)));
        assert!(matches!(move_target(&from, &from.join("backups")), Err(MoveError::IntoItself)));
        assert!(matches!(move_target(&from, &from.join("new")), Err(MoveError::IntoItself)));
        let other = root.join("other");
        library(&other);
        assert!(matches!(move_target(&from, &other), Err(MoveError::Occupied(_))));
    }

    #[test]
    fn moves_a_library_and_keeps_the_original() {
        let root = temp("move");
        let from = root.join("data");
        library(&from);
        let to = root.join("picked");
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join(".DS_Store"), b"").unwrap();
        let aside = move_library(&from, &to, 42).unwrap();
        assert_eq!(aside, root.join("data.moved-42"));
        assert!(!from.exists());
        assert_eq!(inspect(&to), FolderKind::Library);
        assert!(same_files(&aside, &to).unwrap());
        assert!(!root.join(".folio-moving-42").exists());
    }

    #[test]
    fn a_failed_move_leaves_the_original() {
        let root = temp("fail");
        let from = root.join("data");
        library(&from);
        // The target is a file: the copy cannot be put there.
        let to = root.join("blocked");
        fs::write(&to, b"file").unwrap();
        assert!(move_library(&from, &to, 7).is_err());
        assert_eq!(inspect(&from), FolderKind::Library);
        assert!(!root.join(".folio-moving-7").exists());
    }
}
