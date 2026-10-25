//! Logging to a file in the app's log directory, and the diagnostics export
//! (design/ARCHITECTURE.md §0.1 principle 3). Logs must never contain note
//! content: log ids, counts and timings only.

use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

const LOG_PREFIX: &str = "folio.log";

/// Starts logging; keep the returned guard alive for the app's lifetime.
pub fn init_logging(log_dir: &Path) -> WorkerGuard {
    let appender = tracing_appender::rolling::daily(log_dir, LOG_PREFIX);
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("FOLIO_LOG").unwrap_or_else(|_| EnvFilter::new("info,folio=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(writer).with_ansi(false).init();
    guard
}

/// Facts about the install that help reproduce a bug, without note content.
pub struct Facts<'a> {
    pub version: &'a str,
    pub data_dir: &'a Path,
    pub cards: usize,
}

/// Writes `diagnostics-<unix ms>.txt` next to the logs and returns its path.
pub fn export(log_dir: &Path, facts: &Facts, now_ms: i64) -> std::io::Result<PathBuf> {
    let mut out = String::new();
    out.push_str(&format!("Folio {}\n", facts.version));
    out.push_str(&format!("os: {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
    out.push_str(&format!("data dir: {}\n", facts.data_dir.display()));
    out.push_str(&format!("cards: {}\n", facts.cards));
    out.push_str("\n--- recent log lines ---\n");
    out.push_str(&recent_log_lines(log_dir, 400));
    let path = log_dir.join(format!("diagnostics-{now_ms}.txt"));
    std::fs::write(&path, out)?;
    Ok(path)
}

/// The tail of the newest log file.
fn recent_log_lines(log_dir: &Path, max: usize) -> String {
    let newest = std::fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(LOG_PREFIX))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let Some(entry) = newest else { return "(no log file)\n".into() };
    let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n") + "\n"
}
