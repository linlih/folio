//! What client and server exchange (design/ARCHITECTURE.md §5.3), as JSON
//! over HTTP; WebSocket messages only say "there is more" (`Live`).
//!
//! - `PUT  /v1/w/{workspace}/key`  — the wrapped workspace key (first device;
//!   refused if one exists)
//! - `GET  /v1/w/{workspace}/key`  — the wrapped key (a joining device)
//! - `POST /v1/w/{workspace}/push` — encrypted updates → the new head
//! - `GET  /v1/w/{workspace}/pull?after=N&limit=M` — updates after a cursor
//! - `GET  /v1/w/{workspace}/live` — WebSocket; `Live { head }` on new data
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
        let code = code.trim();
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
        assert!(SyncCode::decode("folio-sync:???").is_err());
        assert!(SyncCode::decode("hello").is_err());
    }
}
