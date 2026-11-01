//! The in-app assistant's host side (design/ai.md): the providers' API keys,
//! kept out of the page and out of the library where the device allows
//! (secret.rs); a turn sent to the provider with folio-ai, streamed to the
//! page; the read-only tools, the same as the MCP server's.
//!
//! The providers themselves (name, protocol, address, model) are the page's
//! setting `ai.providers`; only the keys are kept here, in `ai.keys`, which
//! the page cannot read.

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
    let key = key.trim().to_owned();
    let mut keys = kept_keys(&state)?;
    if let Some(old) = keys.remove(&provider) {
        secret::delete(&old.place, &entry_name(&provider));
    }
    if !key.is_empty() {
        let kept = match secret::put(&app, &entry_name(&provider), &key) {
            Ok((place, sealed)) => KeptKey { place: place.into(), sealed, key: String::new() },
            Err(e) => {
                tracing::warn!(error = %e, "no keychain for the API key; it is kept in the library");
                KeptKey { place: IN_LIBRARY.into(), sealed: String::new(), key }
            }
        };
        keys.insert(provider, kept);
    }
    save_keys(&state, &keys)
}

/// The providers that have a key on this device.
#[tauri::command]
pub(crate) fn ai_keys(state: tauri::State<AppState>) -> CmdResult<Vec<String>> {
    Ok(kept_keys(&state)?.into_keys().collect())
}

fn read_key(app: &tauri::AppHandle, provider: &str) -> CmdResult<Option<String>> {
    let Some(k) = kept_keys(&app.state::<AppState>())?.remove(provider) else { return Ok(None) };
    if k.place == IN_LIBRARY {
        return Ok(Some(k.key));
    }
    secret::get(app, &k.place, &entry_name(provider), &k.sealed).map(Some).map_err(CommandError::Other)
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
    let provider = Provider { protocol: p.protocol, base_url: p.base_url, model: p.model, key, effort: p.effort };
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
