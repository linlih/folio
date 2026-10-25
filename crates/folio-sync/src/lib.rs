//! Sync (milestone M3, design/ARCHITECTURE.md §5.3).
//!
//! - `crypto`: end-to-end encryption; the server sees only ciphertext.
//! - `protocol`: what client and server exchange.
//! - `relay`: the server's storage (append-only encrypted log per workspace).
//! - `client`: the engine that pushes the outbox and pulls by cursor.
//! - `http`: the client's HTTP and WebSocket transport.

pub mod client;
pub mod crypto;
pub mod http;
pub mod protocol;
pub mod relay;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("the passphrase does not open this workspace")]
    WrongPassphrase,
    #[error("encryption: {0}")]
    Crypto(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not authorized")]
    Unauthorized,
    #[error("network: {0}")]
    Network(String),
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("store: {0}")]
    Store(#[from] folio_store::StoreError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, SyncError>;
