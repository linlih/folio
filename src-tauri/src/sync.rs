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
/// Pull this often even when the live channel is quiet (or down).
const POLL: Duration = Duration::from_secs(30);
/// Local edits are pushed this long after the last one.
const PUSH_DELAY: Duration = Duration::from_millis(800);
/// Wait after a failed sync, doubling up to `MAX_BACKOFF`.
const BACKOFF: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

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
        e => e.to_string(),
    }
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
    let key = match crypto::unb64(&settings.key).ok().and_then(|k| <[u8; 32]>::try_from(k).ok()) {
        Some(k) => WorkspaceKey(k),
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
        let engine = Engine::new(settings.workspace.clone(), Keys::derive(&key));
        std::thread::Builder::new().name("sync".into()).spawn(move || run(app, engine, http, stop_flag, woken)).ok();
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

fn run(app: tauri::AppHandle, engine: Engine, http: Http, stop: Arc<AtomicBool>, woken: mpsc::Receiver<()>) {
    let mut wait = Duration::ZERO;
    let mut backoff = BACKOFF;
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
        let result = engine.sync(&state.store, &http as &dyn Transport);
        let pending = lock(&state).ok().and_then(|s| s.outbox_len().ok()).unwrap_or(0);
        match result {
            Ok(report) => {
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
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "sync failed");
                wait = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                update(&app, |st| {
                    st.syncing = false;
                    st.pending = pending;
                    st.error = Some(message(&e));
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
        return Err(other("the passphrase needs at least 8 characters"));
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
        http.put_key(&wrapped).map_err(|e| other(message(&e)))
    })
    .await
    .map_err(other)??;
    enable(&app, SyncSettings { server, token, workspace, device, key: key_b64 })
}

/// Another device: joins with the sync code and the passphrase.
#[tauri::command]
pub async fn sync_join(app: tauri::AppHandle, code: String, passphrase: String) -> CmdResult<SyncStatus> {
    let code = SyncCode::decode(&code).map_err(|e| other(message(&e)))?;
    let device = crypto::random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let http = Http::new(&code.server, &code.token, &code.workspace, &device);
    let key = tauri::async_runtime::spawn_blocking(move || -> CmdResult<WorkspaceKey> {
        let wrapped = http.get_key().map_err(|e| other(message(&e)))?.ok_or_else(|| other("the server has no such workspace"))?;
        crypto::unwrap(&wrapped, &passphrase).map_err(|e| other(message(&e)))
    })
    .await
    .map_err(other)??;
    enable(&app, SyncSettings { server: code.server, token: code.token, workspace: code.workspace, device, key: crypto::b64(&key.0) })
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
    {
        let store = lock(&state)?;
        store.set_local_setting(SETTING, &serde_json::Value::Null)?;
        store.set_sync_value(folio_sync::client::CURSOR, &[])?;
    }
    update(&app, |st| *st = SyncStatus::default());
    Ok(current(&app))
}
