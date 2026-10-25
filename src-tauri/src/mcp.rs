//! The MCP server's place in the app (design/ARCHITECTURE.md §0.3): its
//! settings (this device only), starting and stopping it, and asking the
//! user to approve a new client.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use folio_mcp::server::{new_token, random_hex, Server};
use folio_store::Store;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{lock, AppState, CmdResult, CommandError};

const SETTING: &str = "mcp";
pub const DEFAULT_PORT: u16 = 39741;
/// How long a new client waits for the user to answer.
const APPROVAL_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    /// Clients the user approved, by the name they announce.
    pub clients: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    enabled: bool,
    running: bool,
    url: String,
    token: String,
    clients: Vec<String>,
    error: Option<String>,
}

#[derive(Default)]
pub struct McpState {
    server: Mutex<Option<Server>>,
    error: Mutex<Option<String>>,
    /// Approval requests waiting for the user: request id → (client, answer).
    /// Clients retry while waiting, so one answer goes to all of a client's.
    pending: Mutex<HashMap<String, (String, mpsc::Sender<bool>)>>,
}

fn load(store: &Store) -> McpSettings {
    store.local_setting(SETTING).ok().flatten().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save(store: &Store, settings: &McpSettings) -> CmdResult<()> {
    store.set_local_setting(SETTING, &serde_json::to_value(settings).map_err(|e| CommandError::Other(e.to_string()))?)?;
    Ok(())
}

struct Host(tauri::AppHandle);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    id: String,
    client: String,
}

impl folio_mcp::Host for Host {
    fn with_store(&self, f: &mut dyn FnMut(&mut Store)) {
        let state = self.0.state::<AppState>();
        if let Ok(mut store) = lock(&state) {
            f(&mut store);
        }
    }

    fn approve(&self, client: &str) -> bool {
        let state = self.0.state::<AppState>();
        if lock(&state).map(|s| load(&s).clients.iter().any(|c| c == client)).unwrap_or(false) {
            return true;
        }
        // Ask in the app and wait for the answer.
        let id = random_hex(8);
        let (tx, rx) = mpsc::channel();
        self.0.state::<McpState>().pending.lock().unwrap().insert(id.clone(), (client.to_owned(), tx));
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = self.0.emit("mcp-approval", ApprovalRequest { id: id.clone(), client: client.to_owned() });
        let allowed = rx.recv_timeout(APPROVAL_WAIT).unwrap_or(false);
        self.0.state::<McpState>().pending.lock().unwrap().remove(&id);
        tracing::info!(allowed, client, "MCP client approval");
        if allowed {
            if let Ok(store) = lock(&state) {
                let mut s = load(&store);
                if !s.clients.iter().any(|c| c == client) {
                    s.clients.push(client.to_owned());
                    let _ = save(&store, &s);
                }
            }
        }
        allowed
    }
}

/// Starts or stops the server to match the settings.
fn apply(app: &tauri::AppHandle, settings: &McpSettings) {
    let mcp = app.state::<McpState>();
    let mut server = mcp.server.lock().unwrap();
    if let Some(running) = server.take() {
        running.stop();
    }
    *mcp.error.lock().unwrap() = None;
    if !settings.enabled {
        return;
    }
    let (Some(token), port) = (settings.token.clone(), settings.port.unwrap_or(DEFAULT_PORT)) else { return };
    match Server::start(port, token, Arc::new(Host(app.clone()))) {
        Ok(s) => *server = Some(s),
        Err(e) => {
            tracing::error!(error = %e, port, "MCP server failed to start");
            *mcp.error.lock().unwrap() = Some(e.to_string());
        }
    }
}

/// At start: run the server if the user turned it on.
pub fn start_if_enabled(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let settings = match lock(&state) {
        Ok(store) => load(&store),
        Err(_) => return,
    };
    if settings.enabled {
        apply(app, &settings);
    }
}

fn status(app: &tauri::AppHandle, settings: &McpSettings) -> McpStatus {
    let mcp = app.state::<McpState>();
    let server = mcp.server.lock().unwrap();
    let port = server.as_ref().map(|s| s.port()).or(settings.port).unwrap_or(DEFAULT_PORT);
    McpStatus {
        enabled: settings.enabled,
        running: server.is_some(),
        url: format!("http://127.0.0.1:{port}/mcp"),
        token: settings.token.clone().unwrap_or_default(),
        clients: settings.clients.clone(),
        error: mcp.error.lock().unwrap().clone(),
    }
}

fn update(app: &tauri::AppHandle, change: impl FnOnce(&mut McpSettings)) -> CmdResult<McpStatus> {
    let settings = {
        let state = app.state::<AppState>();
        let store = lock(&state)?;
        let mut s = load(&store);
        change(&mut s);
        if s.token.is_none() {
            s.token = Some(new_token());
        }
        save(&store, &s)?;
        s
    };
    apply(app, &settings);
    Ok(status(app, &settings))
}

#[tauri::command]
pub fn mcp_status(app: tauri::AppHandle) -> CmdResult<McpStatus> {
    let state = app.state::<AppState>();
    let settings = load(&*lock(&state)?);
    Ok(status(&app, &settings))
}

#[tauri::command]
pub fn set_mcp_enabled(app: tauri::AppHandle, enabled: bool) -> CmdResult<McpStatus> {
    tracing::info!(enabled, "MCP server setting");
    update(&app, |s| s.enabled = enabled)
}

/// A new token: clients configured with the old one stop working.
#[tauri::command]
pub fn regenerate_mcp_token(app: tauri::AppHandle) -> CmdResult<McpStatus> {
    update(&app, |s| s.token = Some(new_token()))
}

#[tauri::command]
pub fn revoke_mcp_client(app: tauri::AppHandle, client: String) -> CmdResult<McpStatus> {
    if let Some(server) = app.state::<McpState>().server.lock().unwrap().as_ref() {
        server.drop_client(&client);
    }
    let settings = {
        let state = app.state::<AppState>();
        let store = lock(&state)?;
        let mut s = load(&store);
        s.clients.retain(|c| c != &client);
        save(&store, &s)?;
        s
    };
    Ok(status(&app, &settings))
}

#[tauri::command]
pub fn answer_mcp_approval(app: tauri::AppHandle, id: String, allow: bool) -> CmdResult<()> {
    let mcp = app.state::<McpState>();
    let mut pending = mcp.pending.lock().unwrap();
    let Some(client) = pending.get(&id).map(|(c, _)| c.clone()) else { return Ok(()) };
    let ids: Vec<String> = pending.iter().filter(|(_, (c, _))| *c == client).map(|(k, _)| k.clone()).collect();
    for k in ids {
        if let Some((_, tx)) = pending.remove(&k) {
            let _ = tx.send(allow);
        }
    }
    Ok(())
}
