//! The MCP server that lets AI tools read the knowledge base (design/
//! ARCHITECTURE.md §0.3). Read-only for now. Safety, as §0.3 asks:
//! - off until the user turns it on; listens on 127.0.0.1 only;
//! - every request needs the bearer token from Settings;
//! - a client must be approved in the app the first time it connects;
//!   approval opens a session, and every later request must carry it;
//! - requests from web pages (an Origin header that is not local) are
//!   refused, against DNS rebinding.
//!
//! Transport: MCP Streamable HTTP, one JSON response per request (no SSE).

pub mod server;
pub mod tools;

use folio_store::Store;
use serde_json::{json, Value};

/// Protocol versions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// What the server needs from the app.
pub trait Host: Send + Sync + 'static {
    /// Runs `f` with the store (the app's single store, under its lock).
    fn with_store(&self, f: &mut dyn FnMut(&mut Store));
    /// Whether this client may connect: approved before, or approved now by
    /// the user (this may wait for their answer).
    fn approve(&self, client: &str) -> bool;
}

/// A JSON-RPC answer, or a refusal the HTTP layer turns into a status.
#[derive(Debug, PartialEq)]
pub enum Reply {
    Json(Value),
    /// A notification or response: accepted, nothing to answer (202).
    Accepted,
    /// The session id is missing or unknown (404 makes clients reconnect).
    UnknownSession,
}

fn result(id: &Value, result: Value) -> Reply {
    Reply::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error(id: &Value, code: i64, message: &str) -> Reply {
    Reply::Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
}

pub const INSTRUCTIONS: &str = "Folio is the user's personal notes: cards (each with a title) and a journal (one document per day, id journal:YYYY-MM-DD). \
Use search to find things, read_card to read one in full (Markdown), get_backlinks to see what refers to a card. Read-only.";

/// Handles one JSON-RPC message. `session` is the request's session, if it
/// carried a valid one; `open_session` makes one for an approved client.
pub fn handle(host: &dyn Host, message: &Value, session: Option<&str>, open_session: &mut dyn FnMut(&str) -> String) -> (Reply, Option<String>) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // A response from the client (we send no requests): nothing to do.
        return (Reply::Accepted, None);
    };
    let is_notification = message.get("id").is_none();
    if method == "initialize" {
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let client = params.pointer("/clientInfo/name").and_then(Value::as_str).unwrap_or("unknown client");
        if !host.approve(client) {
            return (error(&id, -32001, "Not allowed: the connection was declined in Folio."), None);
        }
        let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSIONS[0]);
        let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
        let new_session = open_session(client);
        let reply = result(
            &id,
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "Folio", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }),
        );
        return (reply, Some(new_session));
    }
    if session.is_none() {
        return (Reply::UnknownSession, None);
    }
    if is_notification {
        return (Reply::Accepted, None);
    }
    let reply = match method {
        "ping" => result(&id, json!({})),
        "tools/list" => result(&id, json!({ "tools": tools::list() })),
        "tools/call" => {
            let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            let mut outcome = Err("store unavailable".to_owned());
            host.with_store(&mut |store| outcome = tools::call(store, name, &args));
            match outcome {
                Ok(text) => result(&id, json!({ "content": [{ "type": "text", "text": text }], "isError": false })),
                Err(e) => result(&id, json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        _ => error(&id, -32601, &format!("method not found: {method}")),
    };
    (reply, None)
}

#[cfg(test)]
mod tests;
