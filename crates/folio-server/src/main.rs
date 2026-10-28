//! `folio-server`: the self-hosted sync relay (design/ARCHITECTURE.md §5.3).
//!
//! Configured by the environment:
//! - `FOLIO_SERVER_TOKEN` (required): the token every device presents;
//! - `FOLIO_SERVER_ADDR` (default `127.0.0.1:8787`; `0.0.0.0:8787` to serve
//!   the network);
//! - `FOLIO_SERVER_DB` (default `folio-server.db`): where updates are kept;
//! - `FOLIO_SERVER_SNAPSHOT_UPDATES` (default 100): a document's log is
//!   replaced by a snapshot from this many updates (lower it to try
//!   compaction out);
//! - `FOLIO_SERVER_MAX_FILE_MB` (default 100): the largest image or
//!   attachment;
//! - `FOLIO_SERVER_QUOTA_MB` (default none): room for files per sync space.
//!
//! Files are kept in `<FOLIO_SERVER_DB>.blobs/` beside the database.
//!
//! It stores only ciphertext and opaque document tags; the passphrase never
//! leaves the devices.

use std::path::PathBuf;

use folio_sync::relay::Relay;

/// Ctrl-C, or SIGTERM from systemd stopping the service: finish what is in
/// flight, then exit.
async fn stopped() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("stopping");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        // Plain text when written to a log file (systemd), colours on a terminal.
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let token = match std::env::var("FOLIO_SERVER_TOKEN") {
        Ok(t) if t.len() >= 16 => t,
        _ => {
            eprintln!("Set FOLIO_SERVER_TOKEN to a secret of at least 16 characters (for example: openssl rand -hex 24).");
            std::process::exit(2);
        }
    };
    let addr = std::env::var("FOLIO_SERVER_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let db = PathBuf::from(std::env::var("FOLIO_SERVER_DB").unwrap_or_else(|_| "folio-server.db".into()));
    let mut relay = Relay::open(&db).unwrap_or_else(|e| {
        eprintln!("Cannot open {}: {e}", db.display());
        std::process::exit(1);
    });
    if let Some(n) = std::env::var("FOLIO_SERVER_SNAPSHOT_UPDATES").ok().and_then(|n| n.parse::<i64>().ok()).filter(|n| *n > 0) {
        relay = relay.with_snapshot_thresholds(n, folio_sync::relay::SNAPSHOT_MIN_BYTES);
        tracing::info!(updates = n, "snapshot threshold");
    }
    let mb = |name: &str| std::env::var(name).ok().and_then(|n| n.parse::<u64>().ok()).filter(|n| *n > 0).map(|n| n * 1024 * 1024);
    let max_file = mb("FOLIO_SERVER_MAX_FILE_MB").unwrap_or(folio_sync::relay::MAX_FILE_BYTES);
    let quota = mb("FOLIO_SERVER_QUOTA_MB");
    relay = relay.with_file_limits(max_file, quota);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        eprintln!("Cannot listen on {addr}: {e}");
        std::process::exit(1);
    });
    tracing::info!("folio-server listening on http://{addr}, data in {}", db.display());
    let server = folio_server::Server::new(relay, token);
    tokio::spawn(folio_server::housekeeping(server.clone()));
    axum::serve(listener, folio_server::router(server))
        .with_graceful_shutdown(stopped())
        .await
        .unwrap();
}
