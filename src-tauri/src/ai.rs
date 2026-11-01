//! The in-app assistant's host side (design/ai.md): the providers' API keys,
//! kept out of the page and out of the library where the device allows
//! (secret.rs); a turn sent to the provider with folio-ai, streamed to the
//! page; the read-only tools, the same as the MCP server's.
//!
//! The providers themselves (name, protocol, address, model) are the page's
//! setting `ai.providers` (synced through the workspace document, mirrored
//! there); only the keys are kept here, in `ai.keys`, which the page cannot
//! read. A key also goes to the workspace's other devices sealed with the
//! sync workspace key, so the page and the server only see it encrypted.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use folio_ai::{Event, Message, Protocol, Provider, Reply, Tool};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::{lock, secret, AppState, CmdResult, CommandError};

const PROVIDERS: &str = "ai.providers";
pub(crate) const KEYS: &str = "ai.keys";
/// Where a key is when this device has no keychain.
const IN_LIBRARY: &str = "library";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSetting {
    id: String,
    protocol: Protocol,
    base_url: String,
    model: String,
    #[serde(default)]
    effort: Option<String>,
}

#[derive(Default, Deserialize)]
struct ProvidersSetting {
    #[serde(default)]
    providers: Vec<ProviderSetting>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct KeptKey {
    #[serde(rename = "in")]
    place: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    sealed: String,
    /// The key itself, only where the device has no keychain.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    key: String,
    /// The key sealed for the workspace's devices, as synced: the copy this
    /// key was sealed to or opened from, to tell when another device has
    /// sent a new one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    synced: String,
}

fn entry_name(provider: &str) -> String {
    format!("ai key {provider}")
}

fn kept_keys(state: &AppState) -> CmdResult<HashMap<String, KeptKey>> {
    Ok(lock(state)?.local_setting(KEYS)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

fn save_keys(state: &AppState, keys: &HashMap<String, KeptKey>) -> CmdResult<()> {
    Ok(lock(state)?.set_local_setting(KEYS, &serde_json::to_value(keys).unwrap_or_default())?)
}

/// Keeps a provider's API key: in the keychain (the Keystore on Android),
/// or in the library where there is none.
#[tauri::command]
pub(crate) fn ai_set_key(app: tauri::AppHandle, state: tauri::State<AppState>, provider: String, key: String) -> CmdResult<()> {
    keep(&app, &state, provider, key.trim().to_owned(), String::new())
}

fn keep(app: &tauri::AppHandle, state: &AppState, provider: String, key: String, synced: String) -> CmdResult<()> {
    let mut keys = kept_keys(state)?;
    if let Some(old) = keys.remove(&provider) {
        secret::delete(&old.place, &entry_name(&provider));
    }
    if !key.is_empty() {
        let kept = match secret::put(app, &entry_name(&provider), &key) {
            Ok((place, sealed)) => KeptKey { place: place.into(), sealed, key: String::new(), synced },
            Err(e) => {
                tracing::warn!(error = %e, "no keychain for the API key; it is kept in the library");
                KeptKey { place: IN_LIBRARY.into(), sealed: String::new(), key, synced }
            }
        };
        keys.insert(provider, kept);
    }
    save_keys(state, &keys)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyInfo {
    provider: String,
    /// The synced copy it matches; None when not synced (yet).
    synced: Option<String>,
}

/// The providers that have a key on this device.
#[tauri::command]
pub(crate) fn ai_keys(state: tauri::State<AppState>) -> CmdResult<Vec<KeyInfo>> {
    Ok(kept_keys(&state)?.into_iter().map(|(provider, k)| KeyInfo { provider, synced: Some(k.synced).filter(|s| !s.is_empty()) }).collect())
}

/// The provider's key sealed for the workspace's other devices, to be
/// synced; None where this device does not sync or has no key.
#[tauri::command]
pub(crate) fn ai_seal_key(app: tauri::AppHandle, state: tauri::State<AppState>, provider: String) -> CmdResult<Option<String>> {
    let Some((workspace, wk)) = crate::sync::workspace_key(&app) else { return Ok(None) };
    let Some(key) = read_key(&app, &provider)?.filter(|k| !k.is_empty()) else { return Ok(None) };
    let sealed = folio_sync::crypto::b64(&folio_sync::crypto::seal_secret(&wk, &workspace, &entry_name(&provider), key.as_bytes()));
    let mut keys = kept_keys(&state)?;
    if let Some(k) = keys.get_mut(&provider) {
        k.synced = sealed.clone();
        save_keys(&state, &keys)?;
    }
    Ok(Some(sealed))
}

/// Keeps a provider's key under another provider: two devices' entries for
/// the same provider made one when their settings first sync.
#[tauri::command]
pub(crate) fn ai_move_key(app: tauri::AppHandle, state: tauri::State<AppState>, from: String, to: String) -> CmdResult<()> {
    let Some(key) = read_key(&app, &from)? else { return Ok(()) };
    keep(&app, &state, to, key, String::new())?;
    keep(&app, &state, from, String::new(), String::new())
}

/// Keeps a key another device synced, sealed (see [`ai_seal_key`]).
#[tauri::command]
pub(crate) fn ai_open_key(app: tauri::AppHandle, state: tauri::State<AppState>, provider: String, sealed: String) -> CmdResult<()> {
    let (workspace, wk) = crate::sync::workspace_key(&app).ok_or_else(|| CommandError::Other("no-sync".into()))?;
    let bytes = folio_sync::crypto::unb64(&sealed).map_err(|e| CommandError::Other(e.to_string()))?;
    let key = folio_sync::crypto::open_secret(&wk, &workspace, &entry_name(&provider), &bytes).map_err(|e| CommandError::Other(e.to_string()))?;
    let key = String::from_utf8(key).map_err(|e| CommandError::Other(e.to_string()))?;
    keep(&app, &state, provider, key, sealed)
}

fn read_key(app: &tauri::AppHandle, provider: &str) -> CmdResult<Option<String>> {
    let Some(k) = kept_keys(&app.state::<AppState>())?.remove(provider) else { return Ok(None) };
    if k.place == IN_LIBRARY {
        return Ok(Some(k.key));
    }
    secret::get(app, &k.place, &entry_name(provider), &k.sealed).map(Some).map_err(CommandError::Other)
}

/// The models a provider offers, which also checks its address and key:
/// `key` as typed in the form, or else the one kept for `provider`.
#[tauri::command]
pub(crate) async fn ai_models(app: tauri::AppHandle, protocol: Protocol, base_url: String, key: Option<String>, provider: Option<String>) -> CmdResult<Vec<String>> {
    let key = match key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()) {
        Some(k) => Some(k),
        None => match provider {
            Some(p) => read_key(&app, &p)?.filter(|k| !k.is_empty()),
            None => None,
        },
    };
    tauri::async_runtime::spawn_blocking(move || folio_ai::list_models(protocol, &base_url, key.as_deref()))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .map_err(|e| CommandError::Other(e.to_string()))
}

/// The tools the assistant can always use: the MCP server's, read-only.
#[tauri::command]
pub(crate) fn ai_tools() -> Vec<Tool> {
    folio_mcp::tools::list()
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| Tool {
            name: t["name"].as_str().unwrap_or("").to_owned(),
            description: t["description"].as_str().unwrap_or("").to_owned(),
            schema: t["inputSchema"].clone(),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolOutcome {
    content: String,
    is_error: bool,
}

#[tauri::command]
pub(crate) fn ai_tool(state: tauri::State<AppState>, name: String, input: Value) -> CmdResult<ToolOutcome> {
    let mut store = lock(&state)?;
    Ok(match folio_mcp::tools::call(&mut store, &name, &input) {
        Ok(content) => ToolOutcome { content, is_error: false },
        Err(content) => ToolOutcome { content, is_error: true },
    })
}

/// Turns the user stopped, until they notice.
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn cancelled(turn: &str) -> bool {
    CANCELLED.lock().map(|c| c.as_ref().is_some_and(|s| s.contains(turn))).unwrap_or(false)
}

#[tauri::command]
pub(crate) fn ai_cancel(turn: String) {
    if let Ok(mut c) = CANCELLED.lock() {
        c.get_or_insert_with(HashSet::new).insert(turn);
    }
}

/// One turn: the model's next message, its text streamed to `events`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ai_turn(
    app: tauri::AppHandle,
    turn: String,
    provider: String,
    // The provider's model this device chose; its first one when not given.
    model: Option<String>,
    // The thinking level the page chose for that model; "" for none.
    effort: Option<String>,
    system: String,
    messages: Vec<Message>,
    tools: Vec<Tool>,
    events: tauri::ipc::Channel<Event>,
) -> CmdResult<Reply> {
    let setting: ProvidersSetting = {
        let state = app.state::<AppState>();
        lock(&state)?.local_setting(PROVIDERS)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    };
    let p = setting.providers.into_iter().find(|p| p.id == provider).ok_or_else(|| CommandError::Other("no-provider".into()))?;
    let key = read_key(&app, &provider)?.filter(|k| !k.is_empty());
    // Anthropic always needs a key; an OpenAI-compatible server may not (Ollama).
    if key.is_none() && p.protocol == Protocol::Anthropic {
        return Err(CommandError::Other("no-key".into()));
    }
    let model = model.filter(|m| !m.is_empty()).unwrap_or(p.model);
    let effort = match effort {
        Some(e) => Some(e).filter(|e| !e.is_empty()),
        None => p.effort.filter(|e| !e.is_empty()),
    };
    let provider = Provider { protocol: p.protocol, base_url: p.base_url, model, key, effort };
    let id = turn.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        folio_ai::run_turn(&provider, &system, &messages, &tools, &mut |e| drop(events.send(e)), &|| cancelled(&id))
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;
    if let Ok(mut c) = CANCELLED.lock() {
        if let Some(s) = c.as_mut() {
            s.remove(&turn);
        }
    }
    result.map_err(|e| CommandError::Other(e.to_string()))
}
