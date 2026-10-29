//! The client's transport to `folio-server`: blocking HTTP (the sync loop runs
//! on its own thread) and a WebSocket that says when there is more to pull.

use std::time::Duration;

use crate::client::Transport;
use crate::crypto::WrappedKey;
use crate::protocol::{AcksResponse, BlobDone, BlobIds, BlobsResponse, DeviceInfo, DeviceName, DevicesResponse, HeavyDoc, HeavyResponse, Live, PullResponse, PushItem, PushRequest, AcksRequest, AcksStored, Round, PushResponse, RefsResponse, SnapshotRequest, SnapshotResponse, DEVICE_HEADER};
use crate::{Result, SyncError};

/// Where and as whom: the server's address and token, the workspace, this
/// device.
#[derive(Clone, Debug)]
pub struct Http {
    base: String,
    token: String,
    workspace: String,
    device: String,
    agent: ureq::Agent,
}

fn err(e: ureq::Error) -> SyncError {
    match e {
        ureq::Error::Status(401, _) => SyncError::Unauthorized,
        ureq::Error::Status(404, r) => SyncError::NotFound(r.into_string().unwrap_or_default()),
        ureq::Error::Status(410, _) => SyncError::Removed,
        ureq::Error::Status(409, r) => SyncError::Conflict(r.into_string().unwrap_or_default()),
        ureq::Error::Status(413, r) => SyncError::TooLarge(r.into_string().unwrap_or_default()),
        ureq::Error::Status(507, r) => SyncError::Full(r.into_string().unwrap_or_default()),
        ureq::Error::Status(code, r) => SyncError::Network(format!("{code}: {}", r.into_string().unwrap_or_default())),
        ureq::Error::Transport(t) => SyncError::Network(t.to_string()),
    }
}

impl Http {
    pub fn new(base: &str, token: &str, workspace: &str, device: &str) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(60)).build();
        Http { base: base.trim_end_matches('/').to_owned(), token: token.to_owned(), workspace: workspace.to_owned(), device: device.to_owned(), agent }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1/w/{}/{path}", self.base, self.workspace)
    }

    fn req(&self, method: &str, path: &str) -> ureq::Request {
        self.agent
            .request(method, &self.url(path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set(DEVICE_HEADER, &self.device)
    }

    /// The wrapped workspace key; None when the workspace does not exist.
    pub fn get_key(&self) -> Result<Option<WrappedKey>> {
        match self.req("GET", "key").call() {
            Ok(r) => Ok(Some(r.into_json().map_err(|e| SyncError::Protocol(e.to_string()))?)),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    /// Creates the workspace with its wrapped key (the first device).
    pub fn put_key(&self, key: &WrappedKey) -> Result<()> {
        self.req("PUT", "key").send_json(key).map_err(err)?;
        Ok(())
    }

    /// Blocks reading the live socket, calling `on_more` for each
    /// notification, until the connection drops (then returns the error).
    pub fn listen(&self, mut on_more: impl FnMut(i64)) -> Result<()> {
        let url = self.url("live").replacen("http", "ws", 1);
        let request = tungstenite::client::IntoClientRequest::into_client_request(url.as_str()).map_err(|e| SyncError::Network(e.to_string()))?;
        let mut request = request;
        let headers = request.headers_mut();
        headers.insert("Authorization", format!("Bearer {}", self.token).parse().map_err(|_| SyncError::Protocol("token".into()))?);
        headers.insert(DEVICE_HEADER, self.device.parse().map_err(|_| SyncError::Protocol("device".into()))?);
        let (mut socket, _) = tungstenite::connect(request).map_err(|e| SyncError::Network(e.to_string()))?;
        loop {
            match socket.read().map_err(|e| SyncError::Network(e.to_string()))? {
                tungstenite::Message::Text(t) => {
                    if let Ok(live) = serde_json::from_str::<Live>(&t) {
                        on_more(live.head);
                    }
                }
                tungstenite::Message::Close(_) => return Err(SyncError::Network("closed".into())),
                _ => {}
            }
        }
    }
}

fn json<T: serde::de::DeserializeOwned>(r: ureq::Response) -> Result<T> {
    r.into_json().map_err(|e| SyncError::Protocol(e.to_string()))
}

impl Transport for Http {
    fn device(&self) -> &str {
        &self.device
    }

    fn push(&self, items: &[PushItem]) -> Result<i64> {
        let resp: PushResponse = self
            .req("POST", "push")
            .send_json(PushRequest { items: items.to_vec() })
            .map_err(err)?
            .into_json()
            .map_err(|e| SyncError::Protocol(e.to_string()))?;
        Ok(resp.head)
    }

    fn pull(&self, after: i64, limit: u32) -> Result<PullResponse> {
        self.req("GET", "pull")
            .query("after", &after.to_string())
            .query("limit", &limit.to_string())
            .call()
            .map_err(err)?
            .into_json()
            .map_err(|e| SyncError::Protocol(e.to_string()))
    }

    fn set_device_name(&self, sealed: &[u8]) -> Result<()> {
        self.req("PUT", "device").send_json(DeviceName { name: crate::crypto::b64(sealed) }).map_err(err)?;
        Ok(())
    }

    fn devices(&self) -> Result<Vec<DeviceInfo>> {
        Ok(json::<DevicesResponse>(self.req("GET", "devices").call().map_err(err)?)?.devices)
    }

    fn push_acks(&self, items: &[PushItem], round: Option<Round>) -> Result<Option<bool>> {
        let resp = self.req("POST", "acks").send_json(AcksRequest { items: items.to_vec(), round }).map_err(err)?;
        // An older server replies with no body.
        Ok(resp.into_json::<AcksStored>().ok().map(|a| a.accepted))
    }

    fn pull_acks(&self, after: i64, limit: u32) -> Result<AcksResponse> {
        json(self.req("GET", "acks").query("after", &after.to_string()).query("limit", &limit.to_string()).call().map_err(err)?)
    }

    fn remove_device(&self, other: &str) -> Result<()> {
        self.req("DELETE", &format!("devices/{other}")).call().map_err(err)?;
        Ok(())
    }

    fn heavy_docs(&self) -> Result<Vec<HeavyDoc>> {
        Ok(json::<HeavyResponse>(self.req("GET", "heavy").call().map_err(err)?)?.docs)
    }

    fn push_snapshot(&self, item: &PushItem, covers: i64) -> Result<i64> {
        Ok(json::<SnapshotResponse>(self.req("POST", "snapshot").send_json(SnapshotRequest { item: item.clone(), covers }).map_err(err)?)?.seq)
    }

    fn blobs(&self, ids: &[String]) -> Result<BlobsResponse> {
        json(self.req("POST", "blobs/have").send_json(BlobIds { ids: ids.to_vec() }).map_err(err)?)
    }

    fn put_chunk(&self, id: &str, n: u32, sealed: &[u8]) -> Result<()> {
        self.req("PUT", &format!("blobs/{id}/{n}")).set("Content-Type", "application/octet-stream").send_bytes(sealed).map_err(err)?;
        Ok(())
    }

    fn finish_blob(&self, id: &str, chunks: u32) -> Result<()> {
        self.req("POST", &format!("blobs/{id}/done")).send_json(BlobDone { chunks }).map_err(err)?;
        Ok(())
    }

    fn report_refs(&self, ids: &[String]) -> Result<Vec<String>> {
        let r: RefsResponse = json(self.req("PUT", "blobs/refs").send_json(BlobIds { ids: ids.to_vec() }).map_err(err)?)?;
        Ok(r.missing)
    }

    fn get_chunk(&self, id: &str, n: u32) -> Result<Vec<u8>> {
        use std::io::Read;
        let r = self.req("GET", &format!("blobs/{id}/{n}")).call().map_err(err)?;
        let mut out = Vec::new();
        r.into_reader().take(crate::crypto::MAX_SEALED_CHUNK as u64 + 1).read_to_end(&mut out).map_err(|e| SyncError::Network(e.to_string()))?;
        if out.len() > crate::crypto::MAX_SEALED_CHUNK {
            return Err(SyncError::Protocol("file chunk too long".into()));
        }
        Ok(out)
    }
}
