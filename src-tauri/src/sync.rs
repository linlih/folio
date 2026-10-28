//! Sync in the app (design/ARCHITECTURE.md §5.3): the settings (this device
//! only), and a background thread that pushes local edits and pulls other
//! devices' through `folio_sync`. Remote changes reach open editors as a
//! `sync-applied` event with the changed document ids.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use folio_sync::client::{Engine, Transport};
use folio_sync::crypto::{self, Keys, WorkspaceKey};
use folio_sync::http::Http;
use folio_sync::protocol::SyncCode;
use folio_sync::SyncError;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{lock, now_ms, AppState, CmdResult, CommandError};

const SETTING: &str = "sync";
/// This device's own name for itself, kept when sync stops so that joining
/// again keeps it.
const NAME_SETTING: &str = "sync.name";
/// Pull this often even when the live channel is quiet (or down).
const POLL: Duration = Duration::from_secs(30);
/// Local edits are pushed this long after the last one.
const PUSH_DELAY: Duration = Duration::from_millis(800);
/// Wait after a failed sync, doubling up to `MAX_BACKOFF`.
const BACKOFF: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How often the server is asked which logs to replace with snapshots.
const SNAPSHOT_EVERY: Duration = Duration::from_secs(60 * 60);

/// Kept in `local_settings`. The workspace key is stored here for now; the
/// OS keychain comes later (§5.3).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    pub server: String,
    pub token: String,
    pub workspace: String,
    pub device: String,
    /// The workspace key, base64.
    pub key: String,
    /// This device's name in the device list; the computer's when empty.
    #[serde(default)]
    pub name: String,
}

/// A device of the workspace, for Settings → Sync.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevice {
    pub id: String,
    pub name: Option<String>,
    pub this_device: bool,
    pub first_seen: i64,
    /// Its last request to the server.
    pub last_seen: i64,
}

/// Longest device name, in characters.
const MAX_NAME: usize = 64;

/// What the system calls this computer; the platform where there is no such
/// name to read (phones), until the user names it.
fn system_device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if out.status.success() && !name.is_empty() {
            return name;
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(name) = std::env::var("COMPUTERNAME").ok().filter(|n| !n.trim().is_empty()) {
        return name;
    }
    #[cfg(target_os = "linux")]
    if let Some(name) = std::fs::read_to_string("/etc/hostname").ok().map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()) {
        return name;
    }
    match std::env::consts::OS {
        "macos" => "Mac",
        "ios" => "iPhone / iPad",
        "android" => "Android",
        "windows" => "Windows",
        _ => "Linux",
    }
    .into()
}

fn device_name(s: &SyncSettings) -> String {
    if s.name.trim().is_empty() { system_device_name() } else { s.name.clone() }
}

fn keys_of(s: &SyncSettings) -> Option<Keys> {
    let key = crypto::unb64(&s.key).ok().and_then(|k| <[u8; 32]>::try_from(k).ok())?;
    Some(Keys::derive(&WorkspaceKey(key)))
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub server: String,
    pub device: String,
    /// For another device to join; with the passphrase.
    pub code: String,
    pub syncing: bool,
    /// The live channel is connected.
    pub live: bool,
    pub last_sync: Option<i64>,
    pub pending: i64,
    pub error: Option<String>,
    /// What went wrong, for the interface to word it in its language:
    /// "network", "unauthorized", "removed" or "other".
    pub error_kind: Option<&'static str>,
}

struct Running {
    stop: Arc<AtomicBool>,
    wake: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct SyncState {
    running: Mutex<Option<Running>>,
    status: Arc<Mutex<SyncStatus>>,
}

/// The name this device had when it last synced; empty for the system's.
fn remembered_name(state: &AppState) -> String {
    let Ok(store) = lock(state) else { return String::new() };
    store.local_setting(NAME_SETTING).ok().flatten().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn load(state: &AppState) -> Option<SyncSettings> {
    let store = lock(state).ok()?;
    store.local_setting(SETTING).ok().flatten().and_then(|v| serde_json::from_value(v).ok())
}

fn other(e: impl std::fmt::Display) -> CommandError {
    CommandError::Other(e.to_string())
}

fn message(e: &SyncError) -> String {
    match e {
        SyncError::Network(m) => format!("cannot reach the server ({m})"),
        SyncError::Unauthorized => "the server refused the token".into(),
        SyncError::Removed => "another device removed this one from the sync space; stop syncing here and join again to go on".into(),
        e => e.to_string(),
    }
}

/// What kind of failure this is, for the interface to word it in its
/// language (web/src/sync/status.ts knows these).
fn kind(e: &SyncError) -> &'static str {
    match e {
        SyncError::Network(_) => "network",
        SyncError::Unauthorized => "unauthorized",
        SyncError::Removed => "removed",
        SyncError::WrongPassphrase => "wrong-passphrase",
        _ => "other",
    }
}

/// A command's failure, tagged with its kind: "[network] cannot reach…".
/// The interface shows its own wording for the kinds it knows, the English
/// after the tag for the rest; logs stay readable either way.
fn tagged(kind: &str, message: impl std::fmt::Display) -> CommandError {
    CommandError::Other(format!("[{kind}] {message}"))
}

fn failed(e: &SyncError) -> CommandError {
    tagged(kind(e), message(e))
}

fn code_of(s: &SyncSettings) -> String {
    SyncCode { server: s.server.clone(), token: s.token.clone(), workspace: s.workspace.clone() }.encode()
}

fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut SyncStatus)) {
    let sync = app.state::<SyncState>();
    let snapshot = {
        let mut st = sync.status.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("sync-status", snapshot);
}

/// Starts the loop if this device is set up to sync.
pub fn start_if_enabled(app: &tauri::AppHandle) {
    if let Some(settings) = load(&app.state::<AppState>()) {
        start(app, settings);
    }
}

/// Asks the loop to push soon (after a local edit).
pub fn poke(app: &tauri::AppHandle) {
    if let Some(r) = app.state::<SyncState>().running.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = r.wake.send(());
    }
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(r) = app.state::<SyncState>().running.lock().unwrap_or_else(|e| e.into_inner()).take() {
        r.stop.store(true, Ordering::SeqCst);
        let _ = r.wake.send(());
    }
}

fn start(app: &tauri::AppHandle, settings: SyncSettings) {
    stop(app);
    let keys = match keys_of(&settings) {
        Some(k) => k,
        None => {
            tracing::error!("sync settings hold no usable key");
            return;
        }
    };
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (wake, woken) = mpsc::channel();
    let http = Http::new(&settings.server, &settings.token, &settings.workspace, &settings.device);
    update(app, |st| {
        *st = SyncStatus { enabled: true, server: settings.server.clone(), device: settings.device.clone(), code: code_of(&settings), ..Default::default() };
    });
    {
        let app = app.clone();
        let http = http.clone();
        let stop_flag = stop_flag.clone();
        let wake = wake.clone();
        std::thread::Builder::new().name("sync-live".into()).spawn(move || listen(app, http, stop_flag, wake)).ok();
    }
    {
        let app = app.clone();
        let stop_flag = stop_flag.clone();
        let engine = Engine::new(settings.workspace.clone(), keys);
        let name = device_name(&settings);
        std::thread::Builder::new().name("sync".into()).spawn(move || run(app, engine, http, name, stop_flag, woken)).ok();
    }
    *app.state::<SyncState>().running.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running { stop: stop_flag, wake });
}

/// Keeps the live channel open; each notice wakes the loop.
fn listen(app: tauri::AppHandle, http: Http, stop: Arc<AtomicBool>, wake: mpsc::Sender<()>) {
    let mut backoff = BACKOFF;
    while !stop.load(Ordering::SeqCst) {
        let result = http.listen(|_head| {
            update(&app, |st| st.live = true);
            let _ = wake.send(());
        });
        update(&app, |st| st.live = false);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if let Err(e) = result {
            tracing::debug!(error = %e, "sync live channel dropped");
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

fn run(app: tauri::AppHandle, engine: Engine, http: Http, name: String, stop: Arc<AtomicBool>, woken: mpsc::Receiver<()>) {
    let mut wait = Duration::ZERO;
    let mut backoff = BACKOFF;
    // The name goes up once per start, at the first sync that can send it.
    let mut named = false;
    let mut snapshots_at: Option<std::time::Instant> = None;
    loop {
        match woken.recv_timeout(wait) {
            // Gather a burst of edits into one push.
            Ok(()) => {
                std::thread::sleep(PUSH_DELAY);
                while woken.try_recv().is_ok() {}
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        update(&app, |st| st.syncing = true);
        let state = app.state::<AppState>();
        if !named {
            named = engine.set_device_name(&http, &name).map_err(|e| tracing::debug!(error = %e, "sending the device name failed")).is_ok();
        }
        let result = engine.sync(&state.store, &http as &dyn Transport);
        let pending = lock(&state).ok().and_then(|s| s.outbox_len().ok()).unwrap_or(0);
        match result {
            Ok(report) => {
                if let Some(e) = &report.acks_error {
                    tracing::warn!(error = %e, "reporting versions failed");
                }
                if snapshots_at.is_none_or(|t| t.elapsed() >= SNAPSHOT_EVERY) {
                    snapshots_at = Some(std::time::Instant::now());
                    match engine.upload_snapshots(&state.store, &http as &dyn Transport) {
                        Ok(n) if n > 0 => tracing::info!(docs = n, "replaced server logs with snapshots"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e, "uploading snapshots failed"),
                    }
                }
                backoff = BACKOFF;
                wait = POLL;
                if !report.applied.is_empty() {
                    let mut ids: Vec<String> = report.applied.iter().map(|a| a.doc.to_string()).collect();
                    ids.sort();
                    ids.dedup();
                    tracing::info!(pushed = report.pushed, docs = ids.len(), "sync applied remote changes");
                    let _ = app.emit("sync-applied", ids);
                }
                update(&app, |st| {
                    st.syncing = false;
                    st.last_sync = Some(now_ms());
                    st.pending = pending;
                    st.error = None;
                    st.error_kind = None;
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "sync failed");
                // Removed for good: no use asking every few seconds.
                wait = if matches!(e, SyncError::Removed) { MAX_BACKOFF } else { backoff };
                backoff = (backoff * 2).min(MAX_BACKOFF);
                update(&app, |st| {
                    st.syncing = false;
                    st.pending = pending;
                    st.error = Some(message(&e));
                    st.error_kind = Some(kind(&e));
                });
            }
        }
    }
}

fn enable(app: &tauri::AppHandle, settings: SyncSettings) -> CmdResult<SyncStatus> {
    let state = app.state::<AppState>();
    {
        let mut store = lock(&state)?;
        store.set_local_setting(SETTING, &serde_json::to_value(&settings).map_err(other)?)?;
        // Everything written here so far goes up with the first push.
        let docs = store.queue_everything(now_ms())?;
        tracing::info!(docs, workspace = %settings.workspace, "sync enabled");
    }
    start(app, settings);
    Ok(current(app))
}

fn current(app: &tauri::AppHandle) -> SyncStatus {
    app.state::<SyncState>().status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn check_passphrase(p: &str) -> CmdResult<()> {
    if p.chars().count() < 8 {
        return Err(tagged("short-passphrase", "the passphrase needs at least 8 characters"));
    }
    Ok(())
}

#[tauri::command]
pub fn sync_status(app: tauri::AppHandle) -> SyncStatus {
    let mut st = current(&app);
    if st.enabled {
        st.pending = lock(&app.state::<AppState>()).ok().and_then(|s| s.outbox_len().ok()).unwrap_or(st.pending);
    }
    st
}

/// The first device: creates a workspace on the server, protected by the
/// passphrase.
#[tauri::command]
pub async fn sync_create(app: tauri::AppHandle, server: String, token: String, passphrase: String) -> CmdResult<SyncStatus> {
    check_passphrase(&passphrase)?;
    let workspace = crypto::random_bytes::<12>().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let device = crypto::random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let server = server.trim().trim_end_matches('/').to_owned();
    let token = token.trim().to_owned();
    let key = WorkspaceKey::generate();
    let http = Http::new(&server, &token, &workspace, &device);
    let key_b64 = crypto::b64(&key.0);
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let wrapped = crypto::wrap(&key, &passphrase, crypto::DEFAULT_COST).map_err(other)?;
        http.put_key(&wrapped).map_err(|e| failed(&e))
    })
    .await
    .map_err(other)??;
    let name = remembered_name(&app.state::<AppState>());
    enable(&app, SyncSettings { server, token, workspace, device, key: key_b64, name })
}

/// Another device: joins with the sync code and the passphrase.
#[tauri::command]
pub async fn sync_join(app: tauri::AppHandle, code: String, passphrase: String) -> CmdResult<SyncStatus> {
    let code = SyncCode::decode(&code).map_err(|_| tagged("bad-code", "this is not a sync code"))?;
    let device = crypto::random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let http = Http::new(&code.server, &code.token, &code.workspace, &device);
    let key = tauri::async_runtime::spawn_blocking(move || -> CmdResult<WorkspaceKey> {
        let wrapped = http.get_key().map_err(|e| failed(&e))?.ok_or_else(|| tagged("no-workspace", "the server has no such workspace"))?;
        crypto::unwrap(&wrapped, &passphrase).map_err(|e| failed(&e))
    })
    .await
    .map_err(other)??;
    let name = remembered_name(&app.state::<AppState>());
    enable(&app, SyncSettings { server: code.server, token: code.token, workspace: code.workspace, device, key: crypto::b64(&key.0), name })
}

#[tauri::command]
pub fn sync_now(app: tauri::AppHandle) {
    poke(&app);
}

/// Stops syncing on this device. Its notes stay; the server keeps the
/// workspace for the other devices.
#[tauri::command]
pub fn sync_disable(app: tauri::AppHandle) -> CmdResult<SyncStatus> {
    stop(&app);
    let state = app.state::<AppState>();
    let name = load(&state).map(|s| s.name);
    {
        let store = lock(&state)?;
        if let Some(name) = name {
            store.set_local_setting(NAME_SETTING, &serde_json::json!(name))?;
        }
        store.set_local_setting(SETTING, &serde_json::Value::Null)?;
        // The next start is a new device: cursors and reports start over.
        folio_sync::client::forget_workspace(&store).map_err(|e| failed(&e))?;
    }
    update(&app, |st| *st = SyncStatus::default());
    Ok(current(&app))
}

/// The workspace's devices (asks the server).
#[tauri::command]
pub async fn sync_devices(app: tauri::AppHandle) -> CmdResult<Vec<SyncDevice>> {
    let settings = load(&app.state::<AppState>()).ok_or_else(|| other("sync is not set up"))?;
    tauri::async_runtime::spawn_blocking(move || list_devices(&settings)).await.map_err(other)?
}

/// Names this device in the device list; empty goes back to the system's
/// name.
#[tauri::command]
pub async fn sync_rename_device(app: tauri::AppHandle, name: String) -> CmdResult<Vec<SyncDevice>> {
    let name = name.trim().to_owned();
    if name.chars().count() > MAX_NAME {
        return Err(other(format!("a device name has at most {MAX_NAME} characters")));
    }
    let mut settings = load(&app.state::<AppState>()).ok_or_else(|| other("sync is not set up"))?;
    settings.name = name;
    lock(&app.state::<AppState>())?.set_local_setting(SETTING, &serde_json::to_value(&settings).map_err(other)?)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (engine, http) = connect(&settings)?;
        engine.set_device_name(&http, &device_name(&settings)).map_err(|e| failed(&e))?;
        list_devices(&settings)
    })
    .await
    .map_err(other)?
}

/// Removes another device from the workspace; it can join again later as
/// a new device.
#[tauri::command]
pub async fn sync_remove_device(app: tauri::AppHandle, id: String) -> CmdResult<Vec<SyncDevice>> {
    let settings = load(&app.state::<AppState>()).ok_or_else(|| other("sync is not set up"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let (engine, http) = connect(&settings)?;
        engine.remove_device(&http, &id).map_err(|e| failed(&e))?;
        tracing::warn!(device = %id, "removed a device from the sync space");
        list_devices(&settings)
    })
    .await
    .map_err(other)?
}

fn connect(s: &SyncSettings) -> CmdResult<(Engine, Http)> {
    let keys = keys_of(s).ok_or_else(|| other("sync settings hold no usable key"))?;
    Ok((Engine::new(s.workspace.clone(), keys), Http::new(&s.server, &s.token, &s.workspace, &s.device)))
}

fn list_devices(s: &SyncSettings) -> CmdResult<Vec<SyncDevice>> {
    let (engine, http) = connect(s)?;
    let devices = engine.devices(&http).map_err(|e| failed(&e))?;
    Ok(devices
        .into_iter()
        .map(|d| {
            let this_device = d.id == s.device;
            // Until the loop has sent it, this device's name is only here.
            let name = if this_device { Some(device_name(s)) } else { d.name };
            SyncDevice { id: d.id, name, this_device, first_seen: d.first_seen, last_seen: d.last_seen }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_carry_the_kind_the_interface_words() {
        assert_eq!(failed(&SyncError::WrongPassphrase).to_string(), format!("[wrong-passphrase] {}", SyncError::WrongPassphrase));
        assert!(failed(&SyncError::Network("refused".into())).to_string().starts_with("[network] cannot reach the server"));
        assert!(failed(&SyncError::Unauthorized).to_string().starts_with("[unauthorized] "));
        assert_eq!(tagged("bad-code", "this is not a sync code").to_string(), "[bad-code] this is not a sync code");
    }
}
