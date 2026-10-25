//! The HTTP side: 127.0.0.1 only, bearer token, local origins only,
//! sessions for approved clients (see lib.rs).

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::Value;
use tiny_http::{Header, Method, Request, Response, StatusCode};

use crate::{handle, Host, Reply};

const SESSION_HEADER: &str = "Mcp-Session-Id";
const MAX_BODY: u64 = 1 << 20;

/// A random secret as hex: tokens and session ids.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("system randomness");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new access token for Settings.
pub fn new_token() -> String {
    random_hex(32)
}

/// Sessions of approved clients: session id → client name.
type Sessions = Arc<Mutex<HashMap<String, String>>>;

pub struct Server {
    http: Arc<tiny_http::Server>,
    thread: Option<JoinHandle<()>>,
    sessions: Sessions,
    port: u16,
}

impl Server {
    /// Starts listening on 127.0.0.1:`port`.
    pub fn start(port: u16, token: String, host: Arc<dyn Host>) -> std::io::Result<Server> {
        let http = Arc::new(tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| std::io::Error::other(e.to_string()))?);
        let port = http.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
        let sessions: Sessions = Arc::default();
        let thread = {
            let (http, sessions, token) = (http.clone(), sessions.clone(), Arc::new(token));
            std::thread::spawn(move || {
                for request in http.incoming_requests() {
                    let (host, sessions, token) = (host.clone(), sessions.clone(), token.clone());
                    // Own thread: approving a new client waits for the user.
                    std::thread::spawn(move || serve(request, &*host, &sessions, &token));
                }
            })
        };
        tracing::info!(port, "MCP server listening");
        Ok(Server { http, thread: Some(thread), sessions, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Ends every session of a client whose approval was withdrawn.
    pub fn drop_client(&self, client: &str) {
        self.sessions.lock().unwrap().retain(|_, c| c != client);
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.http.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.sessions.lock().unwrap().clear();
        tracing::info!(port = self.port, "MCP server stopped");
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.shutdown();
        }
    }
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

/// Compares without stopping at the first difference.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Web pages may not talk to the server (DNS rebinding); local tools send
/// no Origin, or a local one.
fn local_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let host = origin.split("://").nth(1).unwrap_or("").split([':', '/']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn respond(request: Request, status: u16, body: Option<Value>, session: Option<String>) {
    let mut response = match body {
        Some(v) => Response::from_string(v.to_string())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
        None => Response::from_string(String::new()),
    }
    .with_status_code(StatusCode(status));
    if let Some(s) = session {
        response = response.with_header(Header::from_bytes(SESSION_HEADER, s).unwrap());
    }
    if status == 401 {
        response = response.with_header(Header::from_bytes("WWW-Authenticate", "Bearer").unwrap());
    }
    let _ = request.respond(response);
}

fn serve(mut request: Request, host: &dyn Host, sessions: &Sessions, token: &str) {
    if request.url().split('?').next() != Some("/mcp") {
        return respond(request, 404, None, None);
    }
    if !local_origin(header(&request, "Origin")) {
        return respond(request, 403, None, None);
    }
    let authorized = header(&request, "Authorization")
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|t| same_secret(t.trim(), token));
    if !authorized {
        return respond(request, 401, None, None);
    }
    let session = header(&request, SESSION_HEADER).map(str::to_owned);
    match request.method() {
        Method::Post => {}
        Method::Delete => {
            if let Some(s) = &session {
                sessions.lock().unwrap().remove(s);
            }
            return respond(request, 200, None, None);
        }
        // No server-initiated messages: no event stream.
        _ => return respond(request, 405, None, None),
    }
    let mut body = String::new();
    if request.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() {
        return respond(request, 400, None, None);
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return respond(request, 400, Some(serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })), None);
    };
    let known = session.as_deref().filter(|s| sessions.lock().unwrap().contains_key(*s));
    let mut open = |client: &str| {
        let id = random_hex(16);
        sessions.lock().unwrap().insert(id.clone(), client.to_owned());
        id
    };
    let (reply, new_session) = handle(host, &message, known, &mut open);
    match reply {
        Reply::Json(v) => respond(request, 200, Some(v), new_session),
        Reply::Accepted => respond(request, 202, None, None),
        // Spec: 400 without a session header, 404 for an unknown session.
        Reply::UnknownSession => respond(request, if session.is_some() { 404 } else { 400 }, None, None),
    }
}
