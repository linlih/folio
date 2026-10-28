//! Tauri shell. Commands are thin wrappers over `folio-store`; all rules live in
//! the crates (design/ARCHITECTURE.md §3.1, tine ADR 0003).

mod assets;
mod diagnostics;
mod library;
mod mcp;
mod sync;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use folio_core::{CardKind, DocId, DocKind};
use folio_store::{BackupInfo, Backlink, BlockText, CardRow, JournalDay, Origin, SearchHit, Store, TagInfo};
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::{InvokeBody, Request, Response};

pub(crate) struct AppState {
    store: Mutex<Store>,
    /// The library folder; it changes when the library is moved or another
    /// one opened (§5.7).
    data_dir: Mutex<PathBuf>,
    /// The app folder, which holds the default library and the pointer to a
    /// chosen one; `None` while FOLIO_DATA_DIR fixes the library.
    app_dir: Option<PathBuf>,
    /// A chosen library that was not there at start (an unplugged disk).
    missing: Option<PathBuf>,
    log_dir: PathBuf,
    _log_guard: tracing_appender::non_blocking::WorkerGuard,
}

/// Errors cross IPC as their message; the frontend shows or logs it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CommandError {
    #[error(transparent)]
    Store(#[from] folio_store::StoreError),
    #[error(transparent)]
    Id(#[from] folio_core::IdError),
    #[error("{0}")]
    Other(String),
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub(crate) type CmdResult<T> = Result<T, CommandError>;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn data_dir(state: &AppState) -> PathBuf {
    state.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub(crate) fn lock(state: &AppState) -> CmdResult<std::sync::MutexGuard<'_, Store>> {
    state.store.lock().map_err(|_| CommandError::Other("store lock poisoned".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    /// The peer id the frontend's Loro replicas must use (§4.5 rule 3).
    frontend_peer: String,
    /// The peer id of the frontend's API replica.
    api_peer: String,
    /// "macos", "windows", "linux", "android" or "ios": how updates arrive.
    platform: &'static str,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<AppInfo> {
    let store = lock(&state)?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: data_dir(&state).display().to_string(),
        // As strings: a u64 does not fit a JavaScript number.
        frontend_peer: store.frontend_peer()?.to_string(),
        api_peer: store.api_peer()?.to_string(),
        platform: std::env::consts::OS,
    })
}

/// Where releases are published; the desktop updater reads the same file
/// (tauri.conf.json `plugins.updater`).
const RELEASES: &str = "https://github.com/linlih/folio/releases/latest/download";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LatestRelease {
    version: String,
    notes: String,
    date: Option<String>,
    /// The Android package of that release.
    apk: String,
}

/// The newest release, for phones (the updater plugin is desktop only):
/// what latest.json says, read here because the page cannot fetch across
/// origins.
#[tauri::command]
async fn latest_release() -> CmdResult<LatestRelease> {
    let json: serde_json::Value = ureq::get(&format!("{RELEASES}/latest.json"))
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| CommandError::Other(e.to_string()))?
        .into_json()
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let text = |k: &str| json.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    Ok(LatestRelease {
        version: text("version").unwrap_or_default().trim_start_matches('v').to_owned(),
        notes: text("notes").unwrap_or_default(),
        date: text("pub_date"),
        apk: format!("{RELEASES}/folio-android-arm64.apk"),
    })
}

/// Opens a download from this project's releases in the system (the APK on
/// Android installs from there). Only release links are opened.
#[tauri::command]
fn open_release_download(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://github.com/linlih/folio/releases/") {
        return Err(CommandError::Other("not a release link".into()));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
fn list_cards(state: tauri::State<AppState>, limit: Option<u32>) -> CmdResult<Vec<CardRow>> {
    Ok(lock(&state)?.list_cards(limit.unwrap_or(200))?)
}

#[tauri::command]
fn create_card(app: tauri::AppHandle, state: tauri::State<AppState>, title: String) -> CmdResult<String> {
    let id = lock(&state)?.create_card(CardKind::Note, &title, now_ms())?;
    sync::poke(&app);
    tracing::info!(card = %id, "created card");
    Ok(id.to_string())
}

/// The document as a Loro snapshot, sent as raw bytes (no JSON array). An
/// empty body means the document does not exist yet (an unwritten journal
/// day); a Loro snapshot is never empty.
#[tauri::command]
fn doc_snapshot(state: tauri::State<AppState>, id: String) -> CmdResult<Response> {
    let bytes = lock(&state)?.doc_snapshot_if_exists(&DocId::parse(&id)?)?;
    Ok(Response::new(bytes.unwrap_or_default()))
}

#[tauri::command]
fn trash_card(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> CmdResult<()> {
    let id = DocId::parse(&id)?;
    lock(&state)?.trash_card(&id, now_ms())?;
    sync::poke(&app);
    tracing::info!(card = %id, "moved card to trash");
    Ok(())
}

#[tauri::command]
fn restore_card(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> CmdResult<()> {
    let id = DocId::parse(&id)?;
    lock(&state)?.restore_card(&id, now_ms())?;
    sync::poke(&app);
    tracing::info!(card = %id, "restored card");
    Ok(())
}

#[tauri::command]
fn topic_cards(state: tauri::State<AppState>, topic: String) -> CmdResult<Vec<CardRow>> {
    Ok(lock(&state)?.topic_cards(&topic)?)
}

#[tauri::command]
fn card_texts(state: tauri::State<AppState>, ids: Vec<String>) -> CmdResult<Vec<folio_store::CardText>> {
    Ok(lock(&state)?.card_texts(&ids)?)
}

#[tauri::command]
fn card_topic_pairs(state: tauri::State<AppState>) -> CmdResult<Vec<(String, String)>> {
    Ok(lock(&state)?.card_topic_pairs()?)
}

#[tauri::command]
fn topic_counts(state: tauri::State<AppState>) -> CmdResult<Vec<folio_store::TopicCount>> {
    Ok(lock(&state)?.topic_counts()?)
}

#[tauri::command]
fn pin_card(app: tauri::AppHandle, state: tauri::State<AppState>, id: String, pinned: bool) -> CmdResult<()> {
    lock(&state)?.pin_card(&DocId::parse(&id)?, pinned, now_ms())?;
    sync::poke(&app);
    Ok(())
}

#[tauri::command]
fn pinned_cards(state: tauri::State<AppState>) -> CmdResult<Vec<CardRow>> {
    Ok(lock(&state)?.pinned_cards()?)
}

#[tauri::command]
fn list_trash(state: tauri::State<AppState>, limit: Option<u32>) -> CmdResult<Vec<CardRow>> {
    Ok(lock(&state)?.list_trash(limit.unwrap_or(200))?)
}

#[tauri::command]
fn journal_days(state: tauri::State<AppState>, from: String, to: String) -> CmdResult<Vec<JournalDay>> {
    Ok(lock(&state)?.journal_days(&from, &to)?)
}

/// Local edits from the frontend replica: the body is the raw Loro update,
/// the document id and kind travel as headers.
/// Binary data sent to a command. The desktop's IPC carries it as a raw body;
/// Android's webview has no custom-protocol IPC, so Tauri sends the request
/// as JSON and the bytes arrive as an array (what the frontend sends there),
/// or as the object JSON makes of a Uint8Array.
fn body_bytes(body: &InvokeBody) -> Option<std::borrow::Cow<'_, [u8]>> {
    let byte = |v: &serde_json::Value| v.as_u64().filter(|n| *n < 256).map(|n| n as u8);
    match body {
        InvokeBody::Raw(bytes) => Some(std::borrow::Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(items)) => items.iter().map(byte).collect::<Option<Vec<u8>>>().map(Into::into),
        InvokeBody::Json(serde_json::Value::Object(map)) => {
            let mut out = vec![0u8; map.len()];
            for (k, v) in map {
                *out.get_mut(k.parse::<usize>().ok()?)? = byte(v)?;
            }
            Some(out.into())
        }
        _ => None,
    }
}

#[tauri::command]
fn apply_update(app: tauri::AppHandle, state: tauri::State<AppState>, request: Request<'_>) -> CmdResult<()> {
    let bytes = body_bytes(request.body()).ok_or_else(|| CommandError::Other("apply_update expects the update's bytes".into()))?;
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let id = DocId::parse(&header("x-doc-id").ok_or_else(|| CommandError::Other("missing x-doc-id".into()))?)?;
    let kind = header("x-doc-kind").and_then(|k| DocKind::parse(&k)).unwrap_or(DocKind::Card);
    lock(&state)?.apply_update(&id, kind, &bytes, Origin::Local, now_ms())?;
    sync::poke(&app);
    Ok(())
}

#[tauri::command]
fn backlinks(state: tauri::State<AppState>, id: String) -> CmdResult<Vec<Backlink>> {
    Ok(lock(&state)?.backlinks(&DocId::parse(&id)?)?)
}

#[tauri::command]
fn unlinked_references(state: tauri::State<AppState>, id: String, limit: Option<u32>) -> CmdResult<Vec<Backlink>> {
    Ok(lock(&state)?.unlinked_references(&DocId::parse(&id)?, limit.unwrap_or(50))?)
}

#[tauri::command]
fn search(state: tauri::State<AppState>, query: String, limit: Option<u32>) -> CmdResult<Vec<SearchHit>> {
    Ok(lock(&state)?.search(&query, limit.unwrap_or(30))?)
}

#[tauri::command]
fn block_texts(state: tauri::State<AppState>, bids: Vec<String>) -> CmdResult<Vec<BlockText>> {
    Ok(lock(&state)?.block_texts(&bids)?)
}

#[tauri::command]
fn titles(state: tauri::State<AppState>, ids: Vec<String>) -> CmdResult<Vec<(String, String)>> {
    Ok(lock(&state)?.titles(&ids)?)
}

#[tauri::command]
fn get_local_setting(state: tauri::State<AppState>, key: String) -> CmdResult<Option<serde_json::Value>> {
    Ok(lock(&state)?.local_setting(&key)?)
}

#[tauri::command]
fn set_local_setting(state: tauri::State<AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    Ok(lock(&state)?.set_local_setting(&key, &value)?)
}

/// Writes a diagnostics file (no note content) and returns its path.
#[tauri::command]
fn export_diagnostics(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<String> {
    let cards = lock(&state)?.list_cards(u32::MAX)?.len();
    let version = app.package_info().version.to_string();
    let dir = data_dir(&state);
    let facts = diagnostics::Facts { version: &version, data_dir: &dir, cards };
    let path = diagnostics::export(&state.log_dir, &facts, now_ms()).map_err(|e| CommandError::Other(e.to_string()))?;
    tracing::info!(path = %path.display(), "exported diagnostics");
    Ok(path.display().to_string())
}

#[tauri::command]
fn tags(state: tauri::State<AppState>, limit: Option<u32>) -> CmdResult<Vec<TagInfo>> {
    Ok(lock(&state)?.tags(limit.unwrap_or(200))?)
}

#[tauri::command]
fn tagged(state: tauri::State<AppState>, tag: String, limit: Option<u32>) -> CmdResult<Vec<Backlink>> {
    Ok(lock(&state)?.tagged(&tag, limit.unwrap_or(500))?)
}

/// One card (or journal day) as Markdown, with links resolved to what cards
/// and blocks say now; `with_title` puts the title first as a heading.
/// A card as Markdown; `file` gives the link for each image or attachment.
fn render_card(store: &mut Store, id: &DocId, with_title: bool, file: &dyn Fn(&str, &str) -> Option<String>) -> CmdResult<String> {
    let doc = store.doc_copy(id)?;
    let title = folio_core::card::summarize(&doc).title;
    let store = &*store;
    let card_title = |cid: &str| store.titles(&[cid.to_owned()]).ok().and_then(|t| t.into_iter().next()).map(|(_, t)| t);
    let block_text = |bid: &str| store.block_texts(&[bid.to_owned()]).ok().and_then(|b| b.into_iter().next()).map(|b| b.text);
    let body = folio_io::body_markdown(&doc, &folio_io::Links { card_title: &card_title, block_text: &block_text, file });
    let heading = if !title.is_empty() { title } else { id.as_str().strip_prefix("journal:").unwrap_or_default().to_owned() };
    Ok(if with_title && !heading.is_empty() { format!("# {heading}\n\n{body}") } else { body })
}

/// For "Copy as Markdown": the card with its title as a heading.
#[tauri::command]
fn card_markdown(state: tauri::State<AppState>, id: String) -> CmdResult<String> {
    render_card(&mut *lock(&state)?, &DocId::parse(&id)?, true, &|_, _| None)
}

/// Saves one card as a Markdown file, asking where (`file_name` suggested);
/// the file is as the whole-library export writes it, its images and
/// attachments in `assets/` beside it. None when cancelled.
#[tauri::command]
async fn export_card(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, file_name: String) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let id = DocId::parse(&id)?;
    let name = format!("{}.md", folio_io::file_stem(&file_name));
    let Some(picked) = app.dialog().file().set_file_name(&name).add_filter("Markdown", &["md"]).blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| CommandError::Other(e.to_string()))?;
    let body = {
        let mut store = lock(&state)?;
        let files = store.assets_dir();
        let source = |sha256: &str| folio_store::assets::stored_file(&files, sha256);
        let assets = path.parent().map(|p| p.join("assets")).unwrap_or_else(|| PathBuf::from("assets"));
        let copies = folio_io::FileCopies::new(assets, "assets/", &source);
        let body = render_card(&mut store, &id, false, &|sha256, name| copies.link(sha256, name))?;
        copies.finish().map_err(|e| CommandError::Other(e.to_string()))?;
        body
    };
    std::fs::write(&path, body).map_err(|e| CommandError::Other(e.to_string()))?;
    tracing::info!(card = %id, "exported one card");
    Ok(Some(path.display().to_string()))
}

/// Saves a whiteboard as JSON Canvas (§4.3) where the user picks.
#[tauri::command]
async fn save_canvas(app: tauri::AppHandle, file_name: String, content: String) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let name = format!("{}.canvas", folio_io::file_stem(file_name.trim_end_matches(".canvas")));
    let Some(picked) = app.dialog().file().set_file_name(&name).add_filter("JSON Canvas", &["canvas"]).blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| CommandError::Other(e.to_string()))?;
    std::fs::write(&path, content).map_err(|e| CommandError::Other(e.to_string()))?;
    tracing::info!("exported a whiteboard");
    Ok(Some(path.display().to_string()))
}

// ---- backups (§5.4) ----

fn backups_dir(state: &AppState) -> PathBuf {
    folio_store::backup::backups_dir(&data_dir(state))
}

#[tauri::command]
fn list_backups(state: tauri::State<AppState>) -> CmdResult<Vec<BackupInfo>> {
    Ok(folio_store::backup::list_backups(&backups_dir(&state))?)
}

#[tauri::command]
fn backup_now(state: tauri::State<AppState>) -> CmdResult<BackupInfo> {
    let info = lock(&state)?.backup(&backups_dir(&state), now_ms())?;
    tracing::info!(backup = %info.name, "backed up");
    Ok(info)
}

/// Replaces the whole library with a backup, in place: the store is closed,
/// the file swapped (after a "before restore" backup of the current one) and
/// the store opened again; the frontend then reloads. No process restart:
/// under `tauri dev` that ended the dev session and left a blank window.
#[tauri::command]
fn restore_library(state: tauri::State<AppState>, backup: String) -> CmdResult<()> {
    let mut store = lock(&state)?;
    tracing::warn!(backup = %backup, "restoring the library");
    // A store on an empty folder holds the slot while the library is closed.
    let placeholder = std::env::temp_dir().join(format!("folio-restore-{}", now_ms()));
    drop(std::mem::replace(&mut *store, Store::open(&placeholder)?));
    let dir = data_dir(&state);
    let replaced = folio_store::backup::replace_library(&dir, &backup, now_ms());
    // Open the library again whatever happened: the old one if the swap failed.
    let reopened = Store::open(&dir);
    let _ = std::fs::remove_dir_all(&placeholder);
    *store = reopened?;
    replaced?;
    tracing::warn!(backup = %backup, "restored the library");
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryLocation {
    path: String,
    is_default: bool,
    /// FOLIO_DATA_DIR chose it: it cannot be moved from the app.
    fixed: bool,
    cloud_synced: bool,
    /// The chosen library that was not found at start.
    missing: Option<String>,
    /// Where the library lives unless another place is chosen.
    default_path: Option<String>,
}

fn default_library(app_dir: &std::path::Path) -> PathBuf {
    app_dir.join("data")
}

#[tauri::command]
fn library_location(state: tauri::State<AppState>) -> LibraryLocation {
    let dir = data_dir(&state);
    LibraryLocation {
        is_default: state.app_dir.as_deref().is_some_and(|a| default_library(a) == dir),
        fixed: state.app_dir.is_none(),
        cloud_synced: library::is_cloud_synced(&dir),
        missing: state.missing.as_ref().map(|p| p.display().to_string()),
        default_path: state.app_dir.as_deref().map(|a| default_library(a).display().to_string()),
        path: dir.display().to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFolder {
    path: String,
    kind: library::FolderKind,
    cloud_synced: bool,
    /// For a move: where the library would go, or why it cannot.
    target: Option<String>,
    /// Why not: "same", "intoItself", "occupied" or "notEmpty".
    problem: Option<&'static str>,
}

/// Asks the user for a folder. Phones have no folder picker in the dialog
/// plugin yet (M4 decides what exporting means there).
fn pick_folder(app: &tauri::AppHandle) -> CmdResult<Option<PathBuf>> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let Some(picked) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
        picked.into_path().map(Some).map_err(|e| CommandError::Other(e.to_string()))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err(CommandError::Other("choosing a folder is not available on this device yet".into()))
    }
}

/// Asks for a folder to move the library to (`purpose` "move") or to open a
/// library from ("open"); says what is there, nothing changes yet.
#[tauri::command]
async fn pick_library_folder(app: tauri::AppHandle, state: tauri::State<'_, AppState>, purpose: String) -> CmdResult<Option<PickedFolder>> {
    let Some(path) = pick_folder(&app)? else { return Ok(None) };
    let (target, problem) = match purpose.as_str() {
        "move" => match library::move_target(&data_dir(&state), &path) {
            Ok(t) => (Some(t.display().to_string()), None),
            Err(e) => (
                None,
                Some(match e {
                    library::MoveError::Same => "same",
                    library::MoveError::IntoItself => "intoItself",
                    library::MoveError::Occupied(_) => "occupied",
                    _ => "notEmpty",
                }),
            ),
        },
        _ => (None, None),
    };
    Ok(Some(PickedFolder {
        kind: library::inspect(&path),
        cloud_synced: library::is_cloud_synced(target.as_deref().map(std::path::Path::new).unwrap_or(&path)),
        path: path.display().to_string(),
        target,
        problem,
    }))
}

type Change = Box<dyn FnOnce(&std::path::Path) -> Result<PathBuf, String> + Send>;

/// Closes the library, lets `change` act on the closed one (from where it
/// is) and say which library to open, opens that one and remembers it. The
/// store is swapped in place, like a restore; the frontend reloads.
fn switch_library(app: &tauri::AppHandle, state: &AppState, change: Change) -> CmdResult<PathBuf> {
    let Some(app_dir) = state.app_dir.clone() else {
        return Err(CommandError::Other("FOLIO_DATA_DIR fixes the library".into()));
    };
    // Sync works on the open library; it starts again on the new one.
    sync::stop(app);
    let result = lock(state).and_then(|mut store| swap_library(&mut store, &state.data_dir, &app_dir, change));
    sync::start_if_enabled(app);
    result
}

/// The swap itself, on the locked store (testable without the app).
fn swap_library(store: &mut Store, data_dir: &Mutex<PathBuf>, app_dir: &std::path::Path, change: Change) -> CmdResult<PathBuf> {
    let from = data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let placeholder = std::env::temp_dir().join(format!("folio-switch-{}", now_ms()));
    drop(std::mem::replace(store, Store::open(&placeholder)?));
    let changed = change(&from);
    let target = changed.as_ref().cloned().unwrap_or_else(|_| from.clone());
    let opened = match Store::open(&target) {
        Ok(s) => Ok((s, target)),
        // Back to the old library, only while it is still there (a moved
        // one is not: opening its folder would start an empty library).
        Err(e) if target != from && library::inspect(&from) == library::FolderKind::Library => {
            tracing::error!(error = %e, to = %target.display(), "could not open the library; staying on the old one");
            Store::open(&from).map(|s| (s, from.clone())).map_err(CommandError::from)
        }
        Err(e) => {
            tracing::error!(error = %e, to = %target.display(), "could not open the library");
            Err(e.into())
        }
    };
    let (opened, at) = opened?;
    let _ = std::fs::remove_dir_all(&placeholder);
    *store = opened;
    *data_dir.lock().unwrap_or_else(|e| e.into_inner()) = at.clone();
    changed.map_err(CommandError::Other)?;
    let remembered = (at != default_library(app_dir)).then_some(at.as_path());
    library::write_pointer(app_dir, remembered).map_err(|e| CommandError::Other(e.to_string()))?;
    Ok(at)
}

/// Moving into the folder `chosen`: a verified copy, the original kept
/// aside, the new place remembered before anything else (if that fails the
/// original goes back, so a start never finds an empty default).
fn move_into(app_dir: PathBuf, chosen: PathBuf) -> Change {
    Box::new(move |from| {
        let target = library::move_target(from, &chosen).map_err(|e| e.to_string())?;
        tracing::warn!(from = %from.display(), to = %target.display(), "moving the library");
        let aside = library::move_library(from, &target, now_ms()).map_err(|e| e.to_string())?;
        let remembered = (target != default_library(&app_dir)).then_some(target.as_path());
        if let Err(e) = library::write_pointer(&app_dir, remembered) {
            let _ = std::fs::rename(&aside, from);
            return Err(format!("could not remember the new location: {e}"));
        }
        tracing::warn!(original = %aside.display(), "moved the library; the original is kept");
        Ok(target)
    })
}

/// Opening the library in `dir`, or a new one when it is empty.
fn open_at(dir: PathBuf) -> Change {
    Box::new(move |_| match library::inspect(&dir) {
        library::FolderKind::Other => Err(format!("{} is not a Folio library or an empty folder", dir.display())),
        _ => {
            tracing::warn!(path = %dir.display(), "opening a library");
            Ok(dir)
        }
    })
}

/// Moves the library into `to` (a folder from `pick_library_folder`), §5.7.
#[tauri::command]
async fn move_library(app: tauri::AppHandle, state: tauri::State<'_, AppState>, to: String) -> CmdResult<String> {
    let Some(app_dir) = state.app_dir.clone() else {
        return Err(CommandError::Other("FOLIO_DATA_DIR fixes the library".into()));
    };
    Ok(switch_library(&app, &state, move_into(app_dir, PathBuf::from(to)))?.display().to_string())
}

/// Opens the library in `path`, or starts a new one there when it is empty.
#[tauri::command]
async fn open_library(app: tauri::AppHandle, state: tauri::State<'_, AppState>, path: String) -> CmdResult<String> {
    Ok(switch_library(&app, &state, open_at(PathBuf::from(path)))?.display().to_string())
}

#[tauri::command]
fn reveal_library(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(data_dir(&state)).map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
fn reveal_backups(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = backups_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Other(e.to_string()))?;
    app.opener().reveal_item_in_dir(&dir).map_err(|e| CommandError::Other(e.to_string()))
}

/// Makes the daily backup when one is due, then folds long update logs into
/// snapshots, and sweeps unused files; checked at start and hourly.
fn auto_backup(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        let dir = backups_dir(&state);
        let backed_up = match lock(&state).map(|s| s.backup_if_due(&dir, now_ms())) {
            Ok(Ok(Some(info))) => {
                tracing::info!(backup = %info.name, "automatic backup");
                true
            }
            Ok(Ok(None)) => true,
            Ok(Err(e)) => {
                tracing::error!(error = %e, "automatic backup failed");
                false
            }
            Err(e) => {
                tracing::error!(error = %e, "automatic backup failed");
                false
            }
        };
        // Never compact without a recent backup to go back to.
        if backed_up {
            compact_logs(&state, &dir);
        }
        assets::sweep(&state);
        std::thread::sleep(std::time::Duration::from_secs(60 * 60));
    });
}

/// Folds each long update log, one document per lock so editing goes on.
fn compact_logs(state: &AppState, dir: &std::path::Path) {
    let ids = match lock(state).map(|s| s.docs_to_compact()) {
        Ok(Ok(ids)) if !ids.is_empty() => ids,
        Ok(Ok(_)) => return,
        Ok(Err(e)) => return tracing::error!(error = %e, "listing documents to compact failed"),
        Err(e) => return tracing::error!(error = %e, "listing documents to compact failed"),
    };
    match lock(state).map(|s| s.backup_before_first_compaction(dir, now_ms())) {
        Ok(Ok(true)) => tracing::info!("backed up before the first compaction"),
        Ok(Ok(false)) => {}
        Ok(Err(e)) => return tracing::error!(error = %e, "backup before compaction failed"),
        Err(e) => return tracing::error!(error = %e, "backup before compaction failed"),
    }
    for id in ids {
        match lock(state).map(|mut s| s.compact_doc(&id)) {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => tracing::error!(doc = %id, error = %e, "compaction failed"),
            Err(e) => return tracing::error!(error = %e, "compaction failed"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    dir: String,
    cards: usize,
    journals: usize,
}

/// Asks for a folder and writes every card there as Markdown, in a new
/// subfolder `folder_name` (§5.5); shows it in Finder. None when cancelled.
#[tauri::command]
async fn export_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    folder_name: String,
    untitled: String,
) -> CmdResult<Option<ExportResult>> {
    use tauri_plugin_opener::OpenerExt;
    let Some(base) = pick_folder(&app)? else { return Ok(None) };
    let dir = base.join(folio_io::file_stem(&folder_name));
    let summary = {
        let mut store = lock(&state)?;
        let rows = store.live_cards()?;
        let mut cards = Vec::with_capacity(rows.len());
        for row in rows {
            let id = DocId::parse(&row.id)?;
            let journal_date = id.is_journal().then(|| row.id.trim_start_matches("journal:").to_owned());
            cards.push(folio_io::ExportCard { id: row.id.clone(), title: row.title, journal_date, doc: store.doc_copy(&id)? });
        }
        let blocks = store.all_block_texts()?;
        let store = &*store;
        let asset_file = |sha256: &str| store.asset_file(sha256).ok().flatten().map(|(path, _)| path);
        folio_io::export_markdown(&dir, &cards, &|bid| blocks.get(bid).cloned(), &asset_file, &untitled)
            .map_err(|e| CommandError::Other(e.to_string()))?
    };
    tracing::info!(cards = summary.cards, journals = summary.journals, files = summary.files, "exported markdown");
    let _ = app.opener().reveal_item_in_dir(&dir);
    Ok(Some(ExportResult { dir: dir.display().to_string(), cards: summary.cards, journals: summary.journals }))
}

/// Light, dark or the system's ("system"): the colors of the phone's system
/// bars and keyboard follow the app's theme, which may differ from the
/// system's. Nothing to do on desktop.
#[tauri::command]
fn set_appearance(window: tauri::WebviewWindow, theme: String) -> CmdResult<()> {
    #[cfg(target_os = "ios")]
    {
        // UIUserInterfaceStyle: unspecified (follow the system), light, dark.
        let style: isize = match theme.as_str() {
            "light" => 1,
            "dark" => 2,
            _ => 0,
        };
        window.with_webview(move |webview| ios_window_style(webview.inner(), style)).map_err(|e| CommandError::Other(e.to_string()))?;
    }
    #[cfg(not(target_os = "ios"))]
    let _ = (window, theme);
    Ok(())
}

/// Sets the interface style of the window holding the web view; the status
/// bar and the keyboard take it on.
#[cfg(target_os = "ios")]
fn ios_window_style(webview: *mut std::ffi::c_void, style: isize) {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    // SAFETY: objc_msgSend called through the signatures of -[UIView window]
    // and -[UIView setOverrideUserInterfaceStyle:]; runs on the main thread
    // (with_webview).
    unsafe {
        let get: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let set: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let window = get(webview, sel_registerName(c"window".as_ptr()));
        if window.is_null() {
            tracing::warn!("web view not in a window; the system bars keep the system's style");
            return;
        }
        set(window, sel_registerName(c"setOverrideUserInterfaceStyle:".as_ptr()), style);
    }
}

/// iOS puts a bar with previous, next and done above the keyboard of any
/// web page; the page has its own toolbar there (web/src/shell/PhoneBars.tsx).
/// The bar is the web view's input accessory view: its content view answers
/// none instead.
#[cfg(target_os = "ios")]
fn hide_keyboard_bar() {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_replaceMethod(cls: *mut c_void, sel: *mut c_void, imp: *const c_void, types: *const c_char) -> *const c_void;
    }
    extern "C" fn none(_this: *mut c_void, _cmd: *mut c_void) -> *mut c_void {
        std::ptr::null_mut()
    }
    // SAFETY: plain Objective-C runtime calls; the replacement has the
    // signature of -[UIResponder inputAccessoryView] ("@@:").
    unsafe {
        let class = objc_getClass(c"WKContentView".as_ptr());
        if class.is_null() {
            tracing::warn!("no WKContentView; the keyboard keeps its bar");
            return;
        }
        class_replaceMethod(class, sel_registerName(c"inputAccessoryView".as_ptr()), none as *const c_void, c"@@:".as_ptr());
    }
}

/// The macOS menu: Tauri's default without "Close Window", so ⌘W reaches
/// the page and closes a tab (web/src/shell/shortcuts.ts). The Edit items
/// stay: copy, paste and the rest go through them on macOS.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    let name = app.package_info().name.clone();
    let sep = || PredefinedMenuItem::separator(app);
    let app_items = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &sep()?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_items, &edit, &window])
}

/// Cmd/Ctrl+Shift+Space from anywhere: bring the window forward and open
/// quick capture (the frontend listens for `quick-capture`).
#[cfg(desktop)]
fn quick_capture_shortcut(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
    let shortcut = "CommandOrControl+Shift+Space";
    let result = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit("quick-capture", ());
    });
    // Another app may own the shortcut; capture is still available in-app.
    if let Err(e) = result {
        tracing::warn!(error = %e, shortcut, "could not register the quick capture shortcut");
    }
    Ok(())
}

/// Bundle identifiers this app used before; the app data directory is named
/// after the identifier, so changing it would otherwise leave the library
/// behind. Add the old one here whenever `tauri.conf.json` changes it
/// (design/ARCHITECTURE.md §10 item 1).
const LEGACY_IDENTIFIERS: &[&str] = &[];

/// Moves the newest existing legacy app directory to `app_dir`, once. A
/// rename, so the library is never copied half-way. Returns where it came
/// from.
///
/// When `app_dir` exists already it is left alone, unless its library is
/// empty and the legacy one is not: the app was started under the new
/// identifier before this move existed and made a fresh library. That
/// empty one is renamed aside, never deleted, and the real library takes
/// its place.
fn adopt_legacy_app_dir(app_dir: &std::path::Path, legacy: &[&str]) -> Option<PathBuf> {
    let parent = app_dir.parent()?;
    let old = legacy.iter().rev().map(|id| parent.join(id)).find(|p| p.is_dir())?;
    if app_dir.exists() {
        // In doubt (unreadable), keep what is there.
        let here = folio_store::has_documents(&app_dir.join("data")).unwrap_or(true);
        let there = folio_store::has_documents(&old.join("data")).unwrap_or(false);
        if here || !there {
            return None;
        }
        let name = app_dir.file_name()?.to_string_lossy().into_owned();
        std::fs::rename(app_dir, app_dir.with_file_name(format!("{name}.empty-{}", now_ms()))).ok()?;
    }
    std::fs::rename(&old, app_dir).ok()?;
    Some(old)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("folio-asset", assets::protocol)
        .setup(|app| {
            // FOLIO_DATA_DIR runs a second copy on its own library, e.g. to try
            // sync between two copies on one computer (scripts/sync-dev.sh).
            let mut moved_from = None;
            let mut missing = None;
            let (data_dir, app_dir) = match std::env::var_os("FOLIO_DATA_DIR") {
                Some(dir) => (PathBuf::from(dir), None),
                None => {
                    let app_dir = app.path().app_data_dir()?;
                    moved_from = adopt_legacy_app_dir(&app_dir, LEGACY_IDENTIFIERS);
                    // A library the user chose (§5.7). If it is not there (a
                    // disk not plugged in) the default opens and the choice
                    // is kept, so the next start finds it again; never a new
                    // empty library in its place.
                    let dir = match library::read_pointer(&app_dir) {
                        Some(chosen) if library::inspect(&chosen) == library::FolderKind::Library => chosen,
                        Some(chosen) => {
                            missing = Some(chosen);
                            default_library(&app_dir)
                        }
                        None => default_library(&app_dir),
                    };
                    (dir, Some(app_dir))
                }
            };
            let log_dir = match std::env::var_os("FOLIO_DATA_DIR") {
                Some(_) => data_dir.with_extension("logs"),
                None => app.path().app_log_dir()?,
            };
            std::fs::create_dir_all(&log_dir)?;
            let guard = diagnostics::init_logging(&log_dir);
            tracing::info!(version = %app.package_info().version, "starting");
            if let Some(chosen) = &missing {
                tracing::error!(library = %chosen.display(), "the chosen library is not there; opened the default one");
            }
            if let Some(old) = moved_from {
                tracing::warn!(from = %old.display(), to = %data_dir.display(), "moved the library from an earlier bundle identifier");
            }
            // A whole-library restore asked for before the restart (§5.4).
            match folio_store::backup::apply_pending_restore(&data_dir, now_ms()) {
                Ok(Some(name)) => tracing::warn!(backup = %name, "restored the library from a backup"),
                Ok(None) => {}
                Err(e) => tracing::error!(error = %e, "restoring the library failed"),
            }
            let store = Store::open(&data_dir)?;
            app.manage(AppState { store: Mutex::new(store), data_dir: Mutex::new(data_dir), app_dir, missing, log_dir, _log_guard: guard });
            app.manage(mcp::McpState::default());
            app.manage(sync::SyncState::default());
            app.manage(assets::AssetState::default());
            auto_backup(app.handle().clone());
            mcp::start_if_enabled(app.handle());
            sync::start_if_enabled(app.handle());
            if let (Some(dir), Some(window)) = (std::env::var_os("FOLIO_DATA_DIR"), app.get_webview_window("main")) {
                let name = PathBuf::from(dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = window.set_title(&format!("Folio — {name}"));
            }
            #[cfg(desktop)]
            quick_capture_shortcut(app)?;
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            #[cfg(target_os = "ios")]
            hide_keyboard_bar();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            latest_release,
            open_release_download,
            set_appearance,
            list_cards,
            create_card,
            doc_snapshot,
            apply_update,
            trash_card,
            restore_card,
            list_trash,
            pin_card,
            topic_cards,
            topic_counts,
            card_topic_pairs,
            card_texts,
            pinned_cards,
            journal_days,
            backlinks,
            unlinked_references,
            search,
            block_texts,
            titles,
            get_local_setting,
            set_local_setting,
            export_diagnostics,
            export_markdown,
            card_markdown,
            export_card,
            save_canvas,
            tags,
            tagged,
            list_backups,
            backup_now,
            restore_library,
            reveal_backups,
            library_location,
            pick_library_folder,
            move_library,
            open_library,
            reveal_library,
            mcp::mcp_status,
            mcp::set_mcp_enabled,
            mcp::regenerate_mcp_token,
            mcp::revoke_mcp_client,
            mcp::answer_mcp_approval,
            sync::sync_status,
            sync::sync_create,
            sync::sync_join,
            sync::sync_now,
            sync::sync_disable,
            sync::sync_devices,
            sync::sync_rename_device,
            sync::sync_remove_device,
            assets::asset_begin,
            assets::asset_write,
            assets::asset_cancel,
            assets::asset_finish,
            assets::asset_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An identifier the app used before.
    const OLD: &str = "dev.old.app";

    #[test]
    fn legacy_app_dir_is_moved_once() {
        let root = std::env::temp_dir().join(format!("folio-legacy-{}", now_ms()));
        let old = root.join(OLD).join("data");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("library.db"), b"x").unwrap();
        let new = root.join("dev.folio.app");
        assert_eq!(adopt_legacy_app_dir(&new, &[OLD]), Some(root.join(OLD)));
        assert_eq!(std::fs::read(new.join("data/library.db")).unwrap(), b"x");
        // The new directory exists now: nothing more moves.
        std::fs::create_dir_all(&old).unwrap();
        assert_eq!(adopt_legacy_app_dir(&new, &[OLD]), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_empty_new_library_gives_way_to_the_legacy_one() {
        let root = std::env::temp_dir().join(format!("folio-legacy-empty-{}", now_ms()));
        let old = root.join(OLD);
        let new = root.join("dev.folio.app");
        let id = Store::open(&old.join("data")).unwrap().create_card(CardKind::Note, "真的卡片", 1).unwrap();
        drop(Store::open(&new.join("data")).unwrap());
        assert_eq!(adopt_legacy_app_dir(&new, &[OLD]), Some(old.clone()));
        let s = Store::open(&new.join("data")).unwrap();
        assert_eq!(s.list_cards(10).unwrap()[0].id, id.as_str());
        // The empty one is kept aside, not deleted.
        assert!(std::fs::read_dir(&root).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("dev.folio.app.empty-")));
        // A new library with documents is never replaced.
        drop(s);
        Store::open(&old.join("data")).unwrap().create_card(CardKind::Note, "另一张", 2).unwrap();
        assert_eq!(adopt_legacy_app_dir(&new, &[OLD]), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn update_bytes_arrive_raw_or_as_json() {
        let raw = InvokeBody::Raw(vec![1, 2, 255]);
        assert_eq!(body_bytes(&raw).as_deref(), Some(&[1u8, 2, 255][..]));
        // Android: an array, or the object JSON.stringify makes of a Uint8Array.
        let array = InvokeBody::Json(serde_json::json!([1, 2, 255]));
        assert_eq!(body_bytes(&array).as_deref(), Some(&[1u8, 2, 255][..]));
        let object = InvokeBody::Json(serde_json::json!({"2": 255, "0": 1, "1": 2}));
        assert_eq!(body_bytes(&object).as_deref(), Some(&[1u8, 2, 255][..]));
        // Not bytes: refused.
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([1, 256]))).is_none());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({"0": 1, "5": 2}))).is_none());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!("x"))).is_none());
    }

    /// A library as the app has it: open, at the default place.
    fn app_library(name: &str) -> (PathBuf, PathBuf, Store, Mutex<PathBuf>) {
        let root = std::env::temp_dir().join(format!("folio-switch-{name}-{}", now_ms()));
        let app_dir = root.join("app");
        let data = default_library(&app_dir);
        let store = Store::open(&data).unwrap();
        (root, app_dir, store, Mutex::new(data))
    }

    #[test]
    fn moves_the_open_library_and_remembers_it() {
        let (root, app_dir, mut store, dir) = app_library("move");
        let id = store.create_card(CardKind::Note, "搬家", 1).unwrap();
        let picked = root.join("Documents");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::write(picked.join("other.txt"), b"x").unwrap();
        let at = swap_library(&mut store, &dir, &app_dir, move_into(app_dir.clone(), picked.clone())).unwrap();
        assert_eq!(at, picked.join(library::FOLDER_NAME));
        assert_eq!(*dir.lock().unwrap(), at);
        assert_eq!(store.list_cards(10).unwrap()[0].id, id.as_str());
        assert_eq!(library::read_pointer(&app_dir), Some(at.clone()));
        // The original is kept aside; the default place is free.
        assert!(!default_library(&app_dir).exists());
        assert!(std::fs::read_dir(&app_dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("data.moved-")));
        // Edits go to the new place, and moving back forgets the pointer.
        store.create_card(CardKind::Note, "新地方", 2).unwrap();
        let back = swap_library(&mut store, &dir, &app_dir, move_into(app_dir.clone(), default_library(&app_dir))).unwrap();
        assert_eq!(back, default_library(&app_dir));
        assert_eq!(store.list_cards(10).unwrap().len(), 2);
        assert_eq!(library::read_pointer(&app_dir), None);
        drop(store);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn opens_another_library_or_a_new_one_and_refuses_other_folders() {
        let (root, app_dir, mut store, dir) = app_library("open");
        store.create_card(CardKind::Note, "这里", 1).unwrap();
        let other = root.join("other");
        Store::open(&other).unwrap().create_card(CardKind::Note, "那里", 1).unwrap();
        swap_library(&mut store, &dir, &app_dir, open_at(other.clone())).unwrap();
        assert_eq!(store.list_cards(10).unwrap()[0].title, "那里");
        // A folder with other things: refused, the open library stays.
        let busy = root.join("busy");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("a.txt"), b"x").unwrap();
        assert!(swap_library(&mut store, &dir, &app_dir, open_at(busy)).is_err());
        assert_eq!(store.list_cards(10).unwrap()[0].title, "那里");
        assert_eq!(library::read_pointer(&app_dir), Some(other));
        // An empty folder: a new library.
        swap_library(&mut store, &dir, &app_dir, open_at(root.join("fresh"))).unwrap();
        assert!(store.list_cards(10).unwrap().is_empty());
        // The first library is untouched.
        swap_library(&mut store, &dir, &app_dir, open_at(default_library(&app_dir))).unwrap();
        assert_eq!(store.list_cards(10).unwrap()[0].title, "这里");
        assert_eq!(library::read_pointer(&app_dir), None);
        drop(store);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_move_keeps_the_library_open_where_it_was() {
        let (root, app_dir, mut store, dir) = app_library("fail");
        store.create_card(CardKind::Note, "留下", 1).unwrap();
        let occupied = root.join("occupied");
        drop(Store::open(&occupied).unwrap());
        assert!(swap_library(&mut store, &dir, &app_dir, move_into(app_dir.clone(), occupied)).is_err());
        assert_eq!(*dir.lock().unwrap(), default_library(&app_dir));
        assert_eq!(store.list_cards(10).unwrap()[0].title, "留下");
        assert_eq!(library::read_pointer(&app_dir), None);
        drop(store);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
