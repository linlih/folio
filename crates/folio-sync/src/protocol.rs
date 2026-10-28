//! What client and server exchange (design/ARCHITECTURE.md §5.3), as JSON
//! over HTTP; WebSocket messages only say "there is more" (`Live`).
//!
//! - `PUT  /v1/w/{workspace}/key`  — the wrapped workspace key (first device;
//!   refused if one exists)
//! - `GET  /v1/w/{workspace}/key`  — the wrapped key (a joining device)
//! - `POST /v1/w/{workspace}/push` — encrypted updates → the new head
//! - `GET  /v1/w/{workspace}/pull?after=N&limit=M` — updates after a cursor
//! - `GET  /v1/w/{workspace}/live` — WebSocket; `Live { head }` on new data
//! - `PUT  /v1/w/{workspace}/device` — this device's name (sealed)
//! - `GET  /v1/w/{workspace}/devices` — the workspace's devices
//! - `POST /v1/w/{workspace}/acks` — this device's versions of documents
//!   (sealed), replacing what it reported before for each
//! - `GET  /v1/w/{workspace}/acks?after=N&limit=M` — reports after a cursor
//! - `DELETE /v1/w/{workspace}/devices/{device}` — removes another device;
//!   its requests get 410 Gone from then on
//! - `GET  /v1/w/{workspace}/heavy` — documents whose log is due for a
//!   snapshot
//! - `POST /v1/w/{workspace}/snapshot` — a document's full snapshot (sealed
//!   like an update) covering its updates up to `covers`; those are deleted
//! - `POST /v1/w/{workspace}/blobs/have` `{ids}` — which of these files the
//!   server has, whole or in part (design/attachments.md §5.1)
//! - `PUT  /v1/w/{workspace}/blobs/{id}/{n}` — chunk n of a file (raw sealed
//!   bytes); sending a chunk again is fine
//! - `POST /v1/w/{workspace}/blobs/{id}/done` `{chunks}` — every chunk is
//!   there; the file can be downloaded, and live devices hear of it
//! - `GET  /v1/w/{workspace}/blobs/{id}/{n}` — chunk n of a whole file
//!
//! Acknowledgements (`device_acks`, §5.3 compaction): after each sync a
//! device reports, per changed document, the version it now has. History
//! older than what every counted device has can be compacted.
//!
//! Every request carries `Authorization: Bearer <server token>` (the token
//! the server was started with) and `X-Folio-Device: <device id>`.

use serde::{Deserialize, Serialize};

pub const DEVICE_HEADER: &str = "X-Folio-Device";

/// One encrypted update as pushed: the document's opaque tag and the sealed
/// blob (base64).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushItem {
    pub doc: String,
    pub blob: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PushRequest {
    pub items: Vec<PushItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushResponse {
    /// The workspace's latest sequence number after the push.
    pub head: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PulledItem {
    pub seq: i64,
    pub doc: String,
    pub blob: String,
    /// The device that pushed it.
    pub device: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullResponse {
    pub updates: Vec<PulledItem>,
    pub head: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Live {
    pub head: i64,
}

/// A device's name, sealed (only devices with the key can read it).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceName {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device: String,
    /// Sealed name (base64); None until the device sent one.
    pub name: Option<String>,
    pub first_seen: i64,
    /// Its last request to the server.
    pub last_seen: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DevicesResponse {
    pub devices: Vec<DeviceInfo>,
}

/// One acknowledgement as pulled: the device's latest report for a document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PulledAck {
    pub seq: i64,
    pub device: String,
    pub doc: String,
    pub blob: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcksResponse {
    pub acks: Vec<PulledAck>,
    pub head: i64,
}

/// A document whose log on the server is due for a snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeavyDoc {
    pub doc: String,
    pub updates: i64,
    pub bytes: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeavyResponse {
    pub docs: Vec<HeavyDoc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotRequest {
    pub item: PushItem,
    /// The pusher has every update of the document up to this seq.
    pub covers: i64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct SnapshotResponse {
    pub seq: i64,
}

/// Files asked about.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlobIds {
    pub ids: Vec<String>,
}

/// A file the server has, whole or in part.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobState {
    pub id: String,
    pub complete: bool,
    /// For a whole file: how many chunks it has.
    pub chunks: u32,
    /// For a partial one: the chunks received so far.
    #[serde(default)]
    pub have: Vec<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobsResponse {
    /// Only the files the server has.
    pub blobs: Vec<BlobState>,
    /// The workspace's whole files, in bytes as stored.
    #[serde(default)]
    pub total_bytes: i64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct BlobDone {
    pub chunks: u32,
}

/// Most files asked about at once.
pub const MAX_BLOB_IDS: usize = 500;

/// The files a device uses, reported so the server can delete the rest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RefsResponse {
    /// The reported files the server does not have whole.
    pub missing: Vec<String>,
}

/// Most files in one report.
pub const MAX_REF_IDS: usize = 500_000;

/// Most updates a pull returns.
pub const MAX_PULL: u32 = 1000;

/// What a second device needs to find the workspace, as one string to copy:
/// the server, its token and the workspace id. The passphrase is never in
/// it; it is typed on each device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCode {
    pub server: String,
    pub token: String,
    pub workspace: String,
}

const CODE_PREFIX: &str = "folio-sync:";

impl SyncCode {
    pub fn encode(&self) -> String {
        format!("{CODE_PREFIX}{}", crate::crypto::b64(serde_json::to_string(self).unwrap_or_default().as_bytes()))
    }

    pub fn decode(code: &str) -> crate::Result<SyncCode> {
        let bad = || crate::SyncError::Protocol("this is not a sync code".into());
        // Forgiving of how a code gets typed or copied: a Chinese input
        // method's full-width colon, and line breaks or spaces anywhere.
        let code: String = code.chars().filter(|c| !c.is_whitespace()).map(|c| if c == '：' { ':' } else { c }).collect();
        let body = code.strip_prefix(CODE_PREFIX).ok_or_else(bad)?;
        let json = crate::crypto::unb64(body).map_err(|_| bad())?;
        serde_json::from_slice(&json).map_err(|_| bad())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_code_round_trips() {
        let code = SyncCode { server: "http://192.168.1.5:8787".into(), token: "t".repeat(20), workspace: "abc".into() };
        assert_eq!(SyncCode::decode(&format!("  {}\n", code.encode())).unwrap(), code);
        let encoded = code.encode();
        let (head, tail) = encoded.split_at(40);
        let typed = format!("{}\n{tail}", head.replacen(':', "：", 1));
        assert_eq!(SyncCode::decode(&typed).unwrap(), code, "full-width colon, wrapped line");
        assert!(SyncCode::decode("folio-sync:???").is_err());
        assert!(SyncCode::decode("hello").is_err());
    }
}
