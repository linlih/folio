//! The sync relay over HTTP (design/ARCHITECTURE.md §5.3; endpoints in
//! `folio_sync::protocol`). Storage is `folio_sync::relay::Relay`; this adds the
//! token check and the live channel that tells connected devices when a
//! workspace has more to pull.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use folio_sync::crypto::WrappedKey;
use folio_sync::protocol::{AcksRequest, AcksStored, BlobDone, BlobIds, BlobsResponse, DeviceName, DevicesResponse, HeavyResponse, Live, PurgeRequest, PushRequest, PushResponse, RefsResponse, SnapshotRequest, SnapshotResponse, DEVICE_HEADER, MAX_PULL};
use folio_sync::relay::Relay;
use folio_sync::SyncError;
use serde::Deserialize;
use tokio::sync::broadcast;

/// Largest request body: a push of a few big first snapshots.
const BODY_LIMIT: usize = 64 * 1024 * 1024;

pub struct Server {
    relay: Relay,
    token: String,
    live: Mutex<HashMap<String, broadcast::Sender<i64>>>,
}

impl Server {
    pub fn new(relay: Relay, token: impl Into<String>) -> Arc<Server> {
        Arc::new(Server { relay, token: token.into(), live: Mutex::new(HashMap::new()) })
    }

    fn channel(&self, workspace: &str) -> broadcast::Sender<i64> {
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        live.entry(workspace.to_owned()).or_insert_with(|| broadcast::channel(16).0).clone()
    }
}

pub fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/v1/w/{ws}/key", get(get_key).put(put_key))
        .route("/v1/w/{ws}/push", post(push))
        .route("/v1/w/{ws}/pull", get(pull))
        .route("/v1/w/{ws}/live", get(live))
        .route("/v1/w/{ws}/device", axum::routing::put(put_device))
        .route("/v1/w/{ws}/devices", get(devices))
        .route("/v1/w/{ws}/devices/{device}", axum::routing::delete(remove_device))
        .route("/v1/w/{ws}/heavy", get(heavy))
        .route("/v1/w/{ws}/snapshot", post(push_snapshot))
        .route("/v1/w/{ws}/acks", get(pull_acks).post(push_acks))
        .route("/v1/w/{ws}/blobs/have", post(blobs_have))
        .route("/v1/w/{ws}/blobs/refs", axum::routing::put(blob_refs))
        .route("/v1/w/{ws}/purge", post(purge))
        .route("/v1/w/{ws}/blobs/{id}/done", post(blob_done))
        .route("/v1/w/{ws}/blobs/{id}/{n}", get(get_chunk).put(put_chunk))
        .route("/health", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(server)
}

struct Failure(StatusCode, String);

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

impl From<SyncError> for Failure {
    fn from(e: SyncError) -> Self {
        let code = match e {
            SyncError::NotFound(_) => StatusCode::NOT_FOUND,
            SyncError::Conflict(_) => StatusCode::CONFLICT,
            SyncError::Unauthorized => StatusCode::UNAUTHORIZED,
            SyncError::Removed => StatusCode::GONE,
            SyncError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            SyncError::Full(_) => StatusCode::INSUFFICIENT_STORAGE,
            SyncError::Protocol(_) | SyncError::Crypto(_) => StatusCode::BAD_REQUEST,
            _ => {
                tracing::error!("relay: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Failure(code, e.to_string())
    }
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Checks the token; returns the calling device.
fn authorize(server: &Server, headers: &HeaderMap) -> Result<String, Failure> {
    let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if !same(bearer.as_bytes(), server.token.as_bytes()) {
        return Err(Failure(StatusCode::UNAUTHORIZED, "not authorized".into()));
    }
    let device = headers.get(DEVICE_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("");
    if device.is_empty() || device.len() > 128 {
        return Err(Failure(StatusCode::BAD_REQUEST, format!("missing {DEVICE_HEADER}")));
    }
    Ok(device.to_owned())
}

fn check_workspace(ws: &str) -> Result<(), Failure> {
    if ws.is_empty() || ws.len() > 128 || !ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Failure(StatusCode::BAD_REQUEST, "bad workspace id".into()));
    }
    Ok(())
}

/// Runs relay work off the async threads (SQLite is blocking).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> folio_sync::Result<T> + Send + 'static) -> Result<T, Failure> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Failure(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.map_err(Failure::from)
}

async fn get_key(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap) -> Result<Json<WrappedKey>, Failure> {
    authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let key = blocking(move || s.relay.wrapped_key(&ws)).await?;
    key.map(Json).ok_or_else(|| Failure(StatusCode::NOT_FOUND, "no such workspace".into()))
}

async fn put_key(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(key): Json<WrappedKey>) -> Result<StatusCode, Failure> {
    authorize(&s, &headers)?;
    check_workspace(&ws)?;
    blocking(move || s.relay.create_workspace(&ws, &key)).await?;
    Ok(StatusCode::CREATED)
}

async fn push(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<PushRequest>) -> Result<Json<PushResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let s2 = s.clone();
    let ws2 = ws.clone();
    let head = blocking(move || s2.relay.push(&ws2, &device, &req.items)).await?;
    // Nobody listening is fine.
    let _ = s.channel(&ws).send(head);
    Ok(Json(PushResponse { head }))
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    after: i64,
    limit: Option<u32>,
}

async fn pull(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Query(q): Query<PullQuery>) -> Result<Response, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let resp = blocking(move || s.relay.pull(&ws, &device, q.after, q.limit.unwrap_or(MAX_PULL))).await?;
    Ok(Json(resp).into_response())
}

/// Longest sealed device name accepted.
const MAX_NAME: usize = 1024;

async fn put_device(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<DeviceName>) -> Result<StatusCode, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let name = folio_sync::crypto::unb64(&req.name).map_err(Failure::from)?;
    if name.len() > MAX_NAME {
        return Err(Failure(StatusCode::PAYLOAD_TOO_LARGE, "device name too long".into()));
    }
    blocking(move || s.relay.set_device_name(&ws, &device, &name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn devices(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap) -> Result<Json<DevicesResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let devices = blocking(move || s.relay.devices(&ws, &device)).await?;
    Ok(Json(DevicesResponse { devices }))
}

async fn remove_device(State(s): State<Arc<Server>>, Path((ws, other)): Path<(String, String)>, headers: HeaderMap) -> Result<StatusCode, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    blocking(move || s.relay.remove_device(&ws, &device, &other)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn heavy(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap) -> Result<Json<HeavyResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let docs = blocking(move || s.relay.heavy_docs(&ws, &device)).await?;
    Ok(Json(HeavyResponse { docs }))
}

async fn push_snapshot(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<SnapshotRequest>) -> Result<Json<SnapshotResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let s2 = s.clone();
    let ws2 = ws.clone();
    let seq = blocking(move || s2.relay.push_snapshot(&ws2, &device, &req.item, req.covers)).await?;
    let _ = s.channel(&ws).send(seq);
    Ok(Json(SnapshotResponse { seq }))
}

async fn push_acks(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<AcksRequest>) -> Result<Json<AcksStored>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let accepted = blocking(move || s.relay.push_acks(&ws, &device, &req.items, req.round)).await?;
    Ok(Json(AcksStored { accepted }))
}

async fn pull_acks(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Query(q): Query<PullQuery>) -> Result<Response, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let resp = blocking(move || s.relay.pull_acks(&ws, &device, q.after, q.limit.unwrap_or(MAX_PULL))).await?;
    Ok(Json(resp).into_response())
}

async fn blobs_have(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<BlobIds>) -> Result<Json<BlobsResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    Ok(Json(blocking(move || s.relay.blobs(&ws, &device, &req.ids)).await?))
}

async fn purge(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<PurgeRequest>) -> Result<(), Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    blocking(move || s.relay.purge(&ws, &device, &req.docs)).await
}

async fn blob_refs(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, Json(req): Json<BlobIds>) -> Result<Json<RefsResponse>, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let missing = blocking(move || s.relay.report_refs(&ws, &device, &req.ids)).await?;
    Ok(Json(RefsResponse { missing }))
}

async fn put_chunk(
    State(s): State<Arc<Server>>,
    Path((ws, id, n)): Path<(String, String, u32)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<StatusCode, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    blocking(move || s.relay.put_chunk(&ws, &device, &id, n, &body)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A file is whole: devices waiting for it hear of it on the live channel
/// (as the current head, which makes them sync and try again).
async fn blob_done(State(s): State<Arc<Server>>, Path((ws, id)): Path<(String, String)>, headers: HeaderMap, Json(req): Json<BlobDone>) -> Result<StatusCode, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let s2 = s.clone();
    let ws2 = ws.clone();
    let head = blocking(move || {
        s2.relay.finish_blob(&ws2, &device, &id, req.chunks)?;
        s2.relay.head(&ws2)
    })
    .await?;
    let _ = s.channel(&ws).send(head);
    Ok(StatusCode::NO_CONTENT)
}

async fn get_chunk(State(s): State<Arc<Server>>, Path((ws, id, n)): Path<(String, String, u32)>, headers: HeaderMap) -> Result<Response, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let bytes = blocking(move || s.relay.get_chunk(&ws, &device, &id, n)).await?;
    Ok(([(axum::http::header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

/// Hourly: deletes uploads left unfinished for a week, and files no device
/// has used for the grace period (`Relay::sweep_unused`).
pub async fn housekeeping(server: Arc<Server>) {
    let mut every = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
    loop {
        every.tick().await;
        let s = server.clone();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        match blocking(move || s.relay.expire_unfinished(now)).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(files = n, "deleted unfinished uploads"),
            Err(Failure(_, e)) => tracing::warn!(error = %e, "deleting unfinished uploads failed"),
        }
        let s = server.clone();
        match blocking(move || s.relay.sweep_unused(now)).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(files = n, "deleted files no device uses"),
            Err(Failure(_, e)) => tracing::warn!(error = %e, "deleting unused files failed"),
        }
    }
}

async fn live(State(s): State<Arc<Server>>, Path(ws): Path<String>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Result<Response, Failure> {
    let device = authorize(&s, &headers)?;
    check_workspace(&ws)?;
    let s2 = s.clone();
    let ws2 = ws.clone();
    let head = blocking(move || {
        s2.relay.check_device(&ws2, &device)?;
        s2.relay.head(&ws2)
    })
    .await?;
    let rx = s.channel(&ws).subscribe();
    Ok(upgrade.on_upgrade(move |socket| watch(socket, head, rx)))
}

/// Sends the head on connect and whenever it moves, until the device leaves.
async fn watch(mut socket: WebSocket, head: i64, mut rx: broadcast::Receiver<i64>) {
    let text = |head| serde_json::to_string(&Live { head }).unwrap_or_default();
    if socket.send(Message::Text(text(head).into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            got = rx.recv() => match got {
                Ok(head) => if socket.send(Message::Text(text(head).into())).await.is_err() { return },
                // Fell behind: the latest notice is all that matters.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            },
        }
    }
}
