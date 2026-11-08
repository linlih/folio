//! Settings → Backup: a second copy of the backups and of every image and
//! attachment in another folder (design/ARCHITECTURE.md §5.4,
//! `folio_store::copy`), encrypted or not as the user chooses. The copy
//! runs after each backup and hourly, on its own: files are copied without
//! holding the store, which is only locked to read the settings and write
//! down how it went.
//!
//! An encrypted copy has a random key, sealed under the user's passphrase
//! in the copy's marker (for restoring on another computer) and kept on
//! this one in the system keychain (`secret.rs`), so copying needs no
//! passphrase. Contents are sealed in chunks like synced files
//! (`folio_sync::crypto`), and files go under a keyed hash of their hash.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use folio_store::copy::{self, Cipher, CopyError, CopySize, Owner};
use folio_store::BackupInfo;
use folio_sync::crypto::{self, Keys, WorkspaceKey, WrappedKey};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::{data_dir, library, lock, now_ms, secret, AppState, CmdResult, CommandError};

/// `local_settings` key of the copy's settings; `KEY.status` holds how the
/// last copy went. The page cannot touch either (`page_may_use`).
pub(crate) const KEY: &str = "backup.copy";
const STATUS: &str = "backup.copy.status";

/// One copy at a time (an hourly one and "back up now" can meet).
static RUNNING: AtomicBool = AtomicBool::new(false);

/// A passphrase shorter than this is refused.
const MIN_PASSPHRASE: usize = 8;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    path: Option<String>,
    encrypted: bool,
    /// Where the key is kept (`secret::KEYCHAIN`, …) and, on Android, its
    /// sealed copy; empty when not encrypted.
    key_in: String,
    key_sealed: String,
    /// The key under the passphrase, for the marker of a copy not made yet.
    wrapped: Option<WrappedKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Status {
    last_ok: Option<i64>,
    /// Why the last copy failed: "unavailable", "foreign", "locked", "mode"
    /// or a message.
    last_error: Option<String>,
    last_error_at: Option<i64>,
    skipped_files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyStatus {
    path: Option<String>,
    copy_path: Option<String>,
    available: bool,
    /// "none", "ours" or "other": whose backups the folder holds.
    owner: &'static str,
    encrypted: bool,
    /// Encrypted, and this computer does not have the key: the passphrase
    /// is needed (to copy, or to restore).
    locked: bool,
    same_disk: bool,
    running: bool,
    last_ok: Option<i64>,
    last_error: Option<String>,
    last_error_at: Option<i64>,
    skipped_files: usize,
    size: Option<CopySize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedCopyFolder {
    path: String,
    owner: &'static str,
    /// The folder already holds a copy: Some(whether it is encrypted). The
    /// choice is then made; else it is the user's.
    encrypted: Option<bool>,
    same_disk: bool,
    cloud_synced: bool,
}

/// A place worth suggesting for the copy.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Suggestion {
    path: String,
    /// "icloud", "onedrive", "googleDrive", "dropbox", "cloud" (another
    /// cloud drive) or "drive" (a disk or USB drive).
    kind: &'static str,
    /// The drive's or service's own name, as the system shows it.
    label: String,
    cloud: bool,
}

// ---- the cipher ----

/// Seals with the sync crate's file sealing: chunks of up to a megabyte,
/// each `u32` length then the sealed chunk; its number and whether it is
/// the last are bound to it, so a copy cut or reordered does not open.
struct Sealer {
    keys: Keys,
}

const SCOPE: &str = "folio backup copy";

impl Sealer {
    fn new(key: &WorkspaceKey) -> Self {
        Sealer { keys: Keys::derive(key) }
    }
}

/// Reads until `buf` is full or the end; how much was read.
fn read_full(from: &mut dyn Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match from.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

impl Cipher for Sealer {
    fn file_name(&self, sha256: &str) -> String {
        self.keys.blob_id(sha256)
    }

    fn seal(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()> {
        let (mut cur, mut next) = (vec![0u8; crypto::CHUNK], vec![0u8; crypto::CHUNK]);
        let mut len = read_full(from, &mut cur)?;
        let mut n = 0u32;
        loop {
            let next_len = if len == crypto::CHUNK { read_full(from, &mut next)? } else { 0 };
            let last = next_len == 0;
            let sealed = self.keys.seal_chunk(SCOPE, id, n, last, &cur[..len]);
            to.write_all(&(sealed.len() as u32).to_le_bytes())?;
            to.write_all(&sealed)?;
            if last {
                return Ok(());
            }
            std::mem::swap(&mut cur, &mut next);
            len = next_len;
            n += 1;
        }
    }

    fn open(&self, id: &str, from: &mut dyn Read, to: &mut dyn Write) -> io::Result<()> {
        let damaged = || io::Error::new(io::ErrorKind::InvalidData, "wrong key or damaged data");
        let read_record = |from: &mut dyn Read| -> io::Result<Option<Vec<u8>>> {
            let mut len = [0u8; 4];
            match read_full(from, &mut len)? {
                0 => return Ok(None),
                4 => {}
                _ => return Err(damaged()),
            }
            let len = u32::from_le_bytes(len) as usize;
            if len > crypto::MAX_SEALED_CHUNK {
                return Err(damaged());
            }
            let mut sealed = vec![0u8; len];
            if read_full(from, &mut sealed)? != len {
                return Err(damaged());
            }
            Ok(Some(sealed))
        };
        let mut cur = read_record(from)?.ok_or_else(damaged)?;
        let mut n = 0u32;
        loop {
            let next = read_record(from)?;
            let plain = self.keys.open_chunk(SCOPE, id, n, next.is_none(), &cur).map_err(|_| damaged())?;
            to.write_all(&plain)?;
            match next {
                None => return Ok(()),
                Some(s) => cur = s,
            }
            n += 1;
        }
    }
}

// ---- settings and keys ----

fn settings(state: &AppState) -> CmdResult<Settings> {
    Ok(lock(state)?.local_setting(KEY)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

fn save_settings(state: &AppState, s: &Settings) -> CmdResult<()> {
    let value = if s.path.is_some() { serde_json::to_value(s).map_err(|e| CommandError::Other(e.to_string()))? } else { serde_json::Value::Null };
    Ok(lock(state)?.set_local_setting(KEY, &value)?)
}

fn status(state: &AppState) -> CmdResult<Status> {
    Ok(lock(state)?.local_setting(STATUS)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

fn account(library: &str) -> String {
    format!("backup copy key {library}")
}

/// This computer's key for the encrypted copy, if it has it.
fn local_key(app: &tauri::AppHandle, s: &Settings, library: &str) -> Option<WorkspaceKey> {
    if !s.encrypted || s.key_in.is_empty() {
        return None;
    }
    let b64 = secret::get(app, &s.key_in, &account(library), &s.key_sealed).ok()?;
    let bytes: [u8; 32] = crypto::unb64(&b64).ok()?.try_into().ok()?;
    Some(WorkspaceKey(bytes))
}

fn keep_key(app: &tauri::AppHandle, s: &mut Settings, library: &str, key: &WorkspaceKey) -> CmdResult<()> {
    let (place, sealed) = secret::put(app, &account(library), &crypto::b64(&key.0)).map_err(CommandError::Other)?;
    s.key_in = place.into();
    s.key_sealed = sealed;
    Ok(())
}

fn forget_key(s: &Settings, library: &str) {
    if !s.key_in.is_empty() {
        secret::delete(&s.key_in, &account(library));
    }
}

fn owner_name(o: &Owner) -> &'static str {
    match o {
        Owner::None => "none",
        Owner::Ours => "ours",
        Owner::Other(_) => "other",
    }
}

fn wrapped_in(path: &Path) -> CmdResult<Option<WrappedKey>> {
    match copy::wrapped_key(path) {
        Ok(Some(v)) => serde_json::from_value(v).map(Some).map_err(|e| CommandError::Other(format!("the backup copy's key cannot be read: {e}"))),
        Ok(None) => Ok(None),
        Err(e) => Err(CommandError::Other(e.to_string())),
    }
}

fn unwrap_with(wrapped: &WrappedKey, passphrase: &str) -> CmdResult<WorkspaceKey> {
    crypto::unwrap(wrapped, passphrase).map_err(|e| match e {
        folio_sync::SyncError::WrongPassphrase => CommandError::Other("wrong-passphrase".into()),
        other => CommandError::Other(other.to_string()),
    })
}

/// Both paths are on one disk (volume). Unknown counts as not.
/// A disk nothing can be written to: on macOS every opened installer
/// (a .dmg) is mounted read-only in /Volumes, like a real drive.
fn read_only(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return true };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: c is a valid C string and st a writable statvfs.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return true;
        }
        st.f_flag & libc::ST_RDONLY != 0
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        false
    }
}

fn same_disk(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev(),
            _ => false,
        }
    }
    #[cfg(windows)]
    {
        let drive = |p: &Path| p.components().next().map(|c| c.as_os_str().to_string_lossy().to_lowercase());
        drive(a).is_some() && drive(a) == drive(b)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (a, b);
        false
    }
}

// ---- commands ----

#[tauri::command]
pub(crate) fn backup_copy_status(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<CopyStatus> {
    let s = settings(&state)?;
    let st = status(&state)?;
    let library = lock(&state)?.library_id()?;
    let path = s.path.as_deref().map(PathBuf::from);
    let (available, owner) = match path.as_deref().map(|p| copy::owner(p, &library)) {
        Some(Ok(o)) => (true, owner_name(&o)),
        _ => (false, "none"),
    };
    // What the folder says wins over the setting (a copy made elsewhere).
    let encrypted = match path.as_deref().filter(|_| available && owner != "none") {
        Some(p) => wrapped_in(p).map(|w| w.is_some()).unwrap_or(s.encrypted),
        None => s.encrypted,
    };
    let copy_path = path.as_deref().map(copy::copy_dir);
    Ok(CopyStatus {
        locked: encrypted && local_key(&app, &s, &library).is_none(),
        same_disk: available && path.as_deref().is_some_and(|p| same_disk(p, &data_dir(&state))),
        size: copy_path.as_deref().filter(|_| available && owner != "none").map(copy::size),
        copy_path: copy_path.map(|p| p.display().to_string()),
        path: s.path,
        available,
        owner,
        encrypted,
        running: RUNNING.load(Ordering::SeqCst),
        last_ok: st.last_ok,
        last_error: st.last_error,
        last_error_at: st.last_error_at,
        skipped_files: st.skipped_files,
    })
}

fn describe(path: PathBuf, library: &str, data: &Path) -> CmdResult<PickedCopyFolder> {
    let owner = copy::owner(&path, library).map_err(|e| CommandError::Other(e.to_string()))?;
    let encrypted = match owner {
        Owner::None => None,
        _ => Some(wrapped_in(&path)?.is_some()),
    };
    Ok(PickedCopyFolder {
        owner: owner_name(&owner),
        encrypted,
        same_disk: same_disk(&path, data),
        cloud_synced: library::is_cloud_synced(&path),
        path: path.display().to_string(),
    })
}

/// Asks for a folder and says what is there; nothing is saved yet.
#[tauri::command]
pub(crate) async fn pick_backup_copy_folder(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> CmdResult<Option<PickedCopyFolder>> {
    let Some(path) = crate::pick_folder(&app)? else { return Ok(None) };
    let library = lock(&state)?.library_id()?;
    describe(path, &library, &data_dir(&state)).map(Some)
}

/// Says what is in a suggested folder, like picking it would.
#[tauri::command]
pub(crate) fn inspect_backup_copy_folder(state: tauri::State<AppState>, path: String) -> CmdResult<PickedCopyFolder> {
    let library = lock(&state)?.library_id()?;
    describe(PathBuf::from(path), &library, &data_dir(&state))
}

/// Places worth suggesting for the copy: the cloud drives this computer
/// has, and disks other than the library's (USB drives, a second disk).
#[tauri::command]
pub(crate) fn backup_copy_suggestions(state: tauri::State<AppState>) -> Vec<Suggestion> {
    suggestions(&data_dir(&state))
}

fn suggestions(data: &Path) -> Vec<Suggestion> {
    let mut out = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let cloud = |out: &mut Vec<Suggestion>, path: PathBuf, kind: &'static str, label: String| {
        if path.is_dir() && !out.iter().any(|s: &Suggestion| Path::new(&s.path) == path) {
            out.push(Suggestion { path: path.display().to_string(), kind, label, cloud: true });
        }
    };
    if let Some(home) = &home {
        cloud(&mut out, home.join("Library/Mobile Documents/com~apple~CloudDocs"), "icloud", "iCloud Drive".into());
        // macOS: the File Provider drives, "OneDrive-Personal", "GoogleDrive-a@b.c", "Dropbox".
        if let Ok(entries) = std::fs::read_dir(home.join("Library/CloudStorage")) {
            let mut found: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            found.sort();
            for p in found {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let (kind, label) = cloud_kind(&name);
                cloud(&mut out, p, kind, label);
            }
        }
        for (dir, kind) in [("Dropbox", "dropbox"), ("Google Drive", "googleDrive"), ("OneDrive", "onedrive")] {
            cloud(&mut out, home.join(dir), kind, dir.into());
        }
    }
    // Windows names the OneDrive folder in the environment.
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(p) = std::env::var_os(var) {
            cloud(&mut out, PathBuf::from(p), "onedrive", "OneDrive".into());
        }
    }
    // Disks other than the library's.
    let mut drives: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        // The start-up disk is listed too, as a link to "/".
        drives.extend(entries.flatten().map(|e| e.path()).filter(|p| !p.is_symlink()));
    }
    #[cfg(target_os = "linux")]
    if let Some(user) = std::env::var_os("USER") {
        for base in [PathBuf::from("/media").join(&user), PathBuf::from("/run/media").join(&user)] {
            if let Ok(entries) = std::fs::read_dir(base) {
                drives.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        if root.is_dir() {
            drives.push(root);
        }
    }
    drives.sort();
    for d in drives {
        if d.is_dir() && !same_disk(&d, data) && !read_only(&d) {
            let label = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| d.display().to_string());
            out.push(Suggestion { path: d.display().to_string(), kind: "drive", label, cloud: false });
        }
    }
    out
}

fn cloud_kind(name: &str) -> (&'static str, String) {
    let lower = name.to_lowercase();
    if lower.starts_with("onedrive") {
        ("onedrive", "OneDrive".into())
    } else if lower.starts_with("googledrive") {
        ("googleDrive", "Google Drive".into())
    } else if lower.starts_with("dropbox") {
        ("dropbox", "Dropbox".into())
    } else {
        ("cloud", name.split('-').next().unwrap_or(name).to_owned())
    }
}

/// Makes the copy into `path` from now on and starts a copy. A folder that
/// already holds a copy keeps its kind (an encrypted one needs its
/// passphrase); a new one is encrypted when `encrypt`, under `passphrase`.
/// Argon2 takes a moment: off the main thread.
#[tauri::command]
pub(crate) async fn set_backup_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    encrypt: bool,
    passphrase: Option<String>,
) -> CmdResult<()> {
    let library = lock(&state)?.library_id()?;
    let chosen = PathBuf::from(&path);
    let old = settings(&state)?;
    let existing = copy::owner(&chosen, &library).map_err(|e| CommandError::Other(e.to_string()))?;
    let mut s = Settings { path: Some(path), ..Settings::default() };
    let wrapped_there = if existing == Owner::None { None } else { wrapped_in(&chosen)? };
    match (wrapped_there, &existing) {
        (Some(w), _) => {
            // An encrypted copy already there: its passphrase opens its key.
            let key = unwrap_with(&w, passphrase.as_deref().unwrap_or(""))?;
            s.encrypted = true;
            keep_key(&app, &mut s, &library, &key)?;
        }
        (None, Owner::None) if encrypt => {
            let passphrase = passphrase.unwrap_or_default();
            if passphrase.chars().count() < MIN_PASSPHRASE {
                return Err(CommandError::Other("passphrase-short".into()));
            }
            let key = WorkspaceKey::generate();
            s.wrapped = Some(crypto::wrap(&key, &passphrase, crypto::DEFAULT_COST).map_err(|e| CommandError::Other(e.to_string()))?);
            s.encrypted = true;
            keep_key(&app, &mut s, &library, &key)?;
        }
        _ => {}
    }
    // The old key is not needed any more (a key just kept under the same
    // name replaced it already).
    if old.encrypted && !s.encrypted {
        forget_key(&old, &library);
    }
    save_settings(&state, &s)?;
    lock(&state)?.set_local_setting(STATUS, &serde_json::Value::Null)?;
    tracing::info!(encrypted = s.encrypted, "backup copy location set");
    spawn(app);
    Ok(())
}

/// Gives this computer the key of the encrypted copy (it was set up on
/// another computer, or the keychain lost it).
#[tauri::command]
pub(crate) async fn unlock_backup_copy(app: tauri::AppHandle, state: tauri::State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let library = lock(&state)?.library_id()?;
    let mut s = settings(&state)?;
    let path = s.path.clone().ok_or_else(|| CommandError::Other("no backup copy is set".into()))?;
    let wrapped = match wrapped_in(Path::new(&path))? {
        Some(w) => w,
        None => s.wrapped.clone().ok_or_else(|| CommandError::Other("the backup copy is not encrypted".into()))?,
    };
    let key = unwrap_with(&wrapped, &passphrase)?;
    s.encrypted = true;
    keep_key(&app, &mut s, &library, &key)?;
    save_settings(&state, &s)?;
    spawn(app);
    Ok(())
}

/// Stops making the copy; what is there stays.
#[tauri::command]
pub(crate) fn stop_backup_copy(state: tauri::State<AppState>) -> CmdResult<()> {
    let library = lock(&state)?.library_id()?;
    let s = settings(&state)?;
    forget_key(&s, &library);
    save_settings(&state, &Settings::default())?;
    lock(&state)?.set_local_setting(STATUS, &serde_json::Value::Null)?;
    tracing::info!("backup copy stopped");
    Ok(())
}

#[tauri::command]
pub(crate) fn copy_backups_now(app: tauri::AppHandle) {
    spawn(app);
}

#[tauri::command]
pub(crate) fn list_copy_backups(state: tauri::State<AppState>) -> CmdResult<Vec<BackupInfo>> {
    let Some(path) = settings(&state)?.path.map(PathBuf::from) else { return Ok(Vec::new()) };
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    Ok(folio_store::backup::list_backups(&copy::copy_dir(&path))?.into_iter().filter(|b| !b.safety).collect())
}

#[tauri::command]
pub(crate) fn reveal_backup_copy(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let Some(path) = settings(&state)?.path.map(PathBuf::from) else { return Ok(()) };
    let dir = copy::copy_dir(&path);
    let target = if dir.is_dir() { dir } else { path };
    app.opener().reveal_item_in_dir(target).map_err(|e| CommandError::Other(e.to_string()))
}

/// Replaces the whole library with a backup from the copy and puts back
/// the copy's files the library lacks; like `restore_library` otherwise.
/// The library takes the copy's id, so copying goes on into the same
/// folder (a new computer restoring a lost library's backups). An
/// encrypted copy needs this computer to have its key (`unlock`).
#[tauri::command]
pub(crate) fn restore_library_from_copy(app: tauri::AppHandle, state: tauri::State<AppState>, backup: String) -> CmdResult<()> {
    let s = settings(&state)?;
    let path = PathBuf::from(s.path.clone().ok_or_else(|| CommandError::Other("no backup copy is set".into()))?);
    let dir = copy::copy_dir(&path);
    let mut store = lock(&state)?;
    let current = store.library_id()?;
    let encrypted = wrapped_in(&path)?.is_some();
    let sealer = if encrypted {
        Some(Sealer::new(&local_key(&app, &s, &current).ok_or_else(|| CommandError::Other("locked".into()))?))
    } else {
        None
    };
    let cipher = sealer.as_ref().map(|c| c as &dyn Cipher);
    let library = match copy::owner(&path, &current).map_err(|e| CommandError::Other(e.to_string()))? {
        Owner::Other(id) => id,
        _ => current.clone(),
    };
    tracing::warn!(backup = %backup, "restoring the library from the backup copy");
    let placeholder = std::env::temp_dir().join(format!("folio-restore-{}", now_ms()));
    drop(std::mem::replace(&mut *store, folio_store::Store::open(&placeholder)?));
    let data = data_dir(&state);
    let replaced = folio_store::backup::replace_library_from_copy(&data, &dir, &backup, cipher, now_ms());
    let reopened = folio_store::Store::open(&data);
    let _ = std::fs::remove_dir_all(&placeholder);
    *store = reopened?;
    replaced?;
    store.set_library_id(&library)?;
    // The backup has the settings of when it was made: copying goes on here,
    // and the key, kept under the old id's name, moves to the new one's.
    let mut kept = s.clone();
    if encrypted && library != current {
        if let Some(key) = local_key(&app, &s, &current) {
            keep_key(&app, &mut kept, &library, &key)?;
            forget_key(&s, &current);
        }
    }
    store.set_local_setting(KEY, &serde_json::to_value(&kept).map_err(|e| CommandError::Other(e.to_string()))?)?;
    store.set_local_setting(STATUS, &serde_json::Value::Null)?;
    let wanted = store.known_assets()?;
    let assets = store.assets_dir();
    drop(store);
    match copy::restore_files(&dir, &assets, &wanted, cipher) {
        Ok(n) => tracing::warn!(backup = %backup, files = n, "restored the library from the backup copy"),
        // The cards are back; files can be put back by restoring again.
        Err(e) => return Err(CommandError::Other(format!("the cards are restored, but not every file: {e}"))),
    }
    Ok(())
}

fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || run(&app));
}

/// Copies into the chosen folder, when one is chosen, and writes down how
/// it went. Called after backups (hourly and "back up now").
pub(crate) fn run(app: &tauri::AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let outcome = (|| -> CmdResult<Option<Result<copy::CopyReport, CopyError>>> {
        let s = settings(&state)?;
        let Some(path) = s.path.as_deref().map(PathBuf::from) else { return Ok(None) };
        let library = lock(&state)?.library_id()?;
        let sealer = match (s.encrypted, local_key(app, &s, &library)) {
            (false, _) => None,
            (true, Some(key)) => Some(Sealer::new(&key)),
            (true, None) => return Err(CommandError::Other("locked".into())),
        };
        let wrapped = s.wrapped.as_ref().and_then(|w| serde_json::to_value(w).ok());
        let data = data_dir(&state);
        let (backups, assets) = (folio_store::backup::backups_dir(&data), folio_store::assets::assets_dir(&data));
        Ok(Some(copy::copy_backups(&backups, &assets, &path, &library, sealer.as_ref().map(|c| c as &dyn Cipher), wrapped.as_ref())))
    })();
    let record = |change: &dyn Fn(&mut Status)| {
        let Ok(mut s) = status(&state) else { return };
        change(&mut s);
        if let Ok(store) = lock(&state) {
            let _ = store.set_local_setting(STATUS, &serde_json::to_value(&s).unwrap_or_default());
        }
    };
    let now = now_ms();
    let failed = |reason: String| {
        record(&|s| {
            s.last_error = Some(reason.clone());
            s.last_error_at = Some(now);
        })
    };
    match outcome {
        Ok(None) => {}
        Ok(Some(Ok(report))) => {
            if report.copied_backups + report.copied_files > 0 {
                tracing::info!(backups = report.copied_backups, files = report.copied_files, skipped = report.skipped_files, "copied backups");
            }
            record(&|s| {
                s.last_ok = Some(now);
                s.last_error = None;
                s.last_error_at = None;
                s.skipped_files = report.skipped_files;
            });
        }
        Ok(Some(Err(e))) => {
            let reason = match &e {
                CopyError::Unavailable(_) => "unavailable".to_owned(),
                CopyError::Foreign(_) => "foreign".to_owned(),
                CopyError::Mode(..) => "mode".to_owned(),
                other => other.to_string(),
            };
            // A drive not plugged in is normal; only real failures are errors.
            if matches!(e, CopyError::Unavailable(_)) {
                tracing::info!("the backup copy folder is not available");
            } else {
                tracing::error!(error = %e, "copying backups failed");
            }
            failed(reason);
        }
        Err(CommandError::Other(m)) if m == "locked" => failed(m),
        Err(e) => tracing::error!(error = %e, "copying backups failed"),
    }
    RUNNING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(len: usize) {
        let c = Sealer::new(&WorkspaceKey::generate());
        let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        let mut sealed = Vec::new();
        c.seal("store-1.db", &mut &data[..], &mut sealed).unwrap();
        let mut back = Vec::new();
        c.open("store-1.db", &mut &sealed[..], &mut back).unwrap();
        assert_eq!(back, data, "{len} bytes");
        // Another name, another key, a cut copy or a missing chunk: refused.
        assert!(c.open("store-2.db", &mut &sealed[..], &mut Vec::new()).is_err());
        assert!(Sealer::new(&WorkspaceKey::generate()).open("store-1.db", &mut &sealed[..], &mut Vec::new()).is_err());
        let first = 4 + u32::from_le_bytes(sealed[..4].try_into().unwrap()) as usize;
        if first < sealed.len() {
            assert!(c.open("store-1.db", &mut &sealed[..first], &mut Vec::new()).is_err(), "cut after the first chunk");
            assert!(c.open("store-1.db", &mut &sealed[first..], &mut Vec::new()).is_err(), "first chunk missing");
        }
    }

    #[test]
    fn seals_and_opens_files_of_any_size_and_nothing_else() {
        for len in [0, 1, 1000, crypto::CHUNK - 1, crypto::CHUNK, crypto::CHUNK + 1, 2 * crypto::CHUNK + 5] {
            roundtrip(len);
        }
    }

    #[test]
    fn names_files_by_a_keyed_hash() {
        let c = Sealer::new(&WorkspaceKey::generate());
        let sha = "ab".repeat(32);
        assert_eq!(c.file_name(&sha), c.file_name(&sha));
        assert_ne!(c.file_name(&sha), Sealer::new(&WorkspaceKey::generate()).file_name(&sha));
        assert!(c.file_name(&sha).len() >= 4 && !c.file_name(&sha).contains(&sha));
    }

    #[test]
    fn tells_read_only_disks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!read_only(dir.path()));
        assert!(read_only(&dir.path().join("not-there")));
        #[cfg(target_os = "macos")]
        assert!(read_only(Path::new("/System")), "the sealed system volume is read-only");
    }

    #[test]
    fn suggests_disks_other_than_the_librarys() {
        let lib = tempfile::tempdir().unwrap();
        // The library's own disk is never suggested as a drive.
        assert!(suggestions(lib.path()).iter().filter(|s| s.kind == "drive").all(|s| !same_disk(Path::new(&s.path), lib.path())));
        // Nor a disk that cannot be written to, like an opened installer.
        assert!(suggestions(lib.path()).iter().filter(|s| s.kind == "drive").all(|s| !read_only(Path::new(&s.path))));
        assert_eq!(cloud_kind("OneDrive-Personal").0, "onedrive");
        assert_eq!(cloud_kind("GoogleDrive-me@example.com"), ("googleDrive", "Google Drive".into()));
        assert_eq!(cloud_kind("Box-Box"), ("cloud", "Box".into()));
    }
}
