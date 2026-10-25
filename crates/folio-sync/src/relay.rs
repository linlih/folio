//! The server's storage (design/ARCHITECTURE.md §5.3): per workspace, the
//! wrapped key and an append-only log of encrypted updates, numbered by a
//! sequence clients pull after. It understands nothing of their content:
//! Loro updates can be imported repeatedly and in any order, so storing and
//! handing them out by cursor is all a relay has to do.
//!
//! Used by `folio-server` behind HTTP, and directly by the simulator.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::crypto::WrappedKey;
use crate::protocol::{PullResponse, PulledItem, PushItem, MAX_PULL};
use crate::{Result, SyncError};

const SCHEMA: &str = "
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, wrapped_key TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS updates (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL, doc TEXT NOT NULL, device TEXT NOT NULL,
    blob BLOB NOT NULL, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS updates_by_workspace ON updates(workspace, seq);
";

pub struct Relay {
    conn: Mutex<Connection>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Relay {
    pub fn open(path: &Path) -> Result<Relay> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        Self::with(conn)
    }

    pub fn open_in_memory() -> Result<Relay> {
        Self::with(Connection::open_in_memory()?)
    }

    fn with(conn: Connection) -> Result<Relay> {
        conn.execute_batch(SCHEMA)?;
        Ok(Relay { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Creates the workspace with its wrapped key; Conflict if it exists.
    pub fn create_workspace(&self, workspace: &str, key: &WrappedKey) -> Result<()> {
        let json = serde_json::to_string(key)?;
        let inserted = self.conn().execute(
            "INSERT OR IGNORE INTO workspaces(id, wrapped_key, created_at) VALUES (?1, ?2, ?3)",
            params![workspace, json, now_ms()],
        )?;
        if inserted == 0 {
            return Err(SyncError::Conflict(format!("workspace {workspace} exists")));
        }
        Ok(())
    }

    pub fn wrapped_key(&self, workspace: &str) -> Result<Option<WrappedKey>> {
        let json: Option<String> =
            self.conn().query_row("SELECT wrapped_key FROM workspaces WHERE id = ?1", [workspace], |r| r.get(0)).optional()?;
        json.map(|j| serde_json::from_str(&j).map_err(SyncError::from)).transpose()
    }

    fn require(&self, conn: &Connection, workspace: &str) -> Result<()> {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)", [workspace], |r| r.get(0))?;
        if exists {
            Ok(())
        } else {
            Err(SyncError::NotFound(format!("workspace {workspace}")))
        }
    }

    /// Appends updates; returns the new head.
    pub fn push(&self, workspace: &str, device: &str, items: &[PushItem]) -> Result<i64> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let tx = conn.transaction()?;
        let at = now_ms();
        for item in items {
            let blob = crate::crypto::unb64(&item.blob)?;
            tx.execute(
                "INSERT INTO updates(workspace, doc, device, blob, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace, item.doc, device, blob, at],
            )?;
        }
        tx.commit()?;
        Self::head_of(&conn, workspace)
    }

    /// Updates after `after`, oldest first.
    pub fn pull(&self, workspace: &str, after: i64, limit: u32) -> Result<PullResponse> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        let mut stmt = conn.prepare_cached(
            "SELECT seq, doc, device, blob FROM updates WHERE workspace = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![workspace, after, limit.clamp(1, MAX_PULL)], |r| {
            Ok(PulledItem { seq: r.get(0)?, doc: r.get(1)?, device: r.get(2)?, blob: crate::crypto::b64(&r.get::<_, Vec<u8>>(3)?) })
        })?;
        let updates = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(PullResponse { updates, head: Self::head_of(&conn, workspace)? })
    }

    pub fn head(&self, workspace: &str) -> Result<i64> {
        Self::head_of(&self.conn(), workspace)
    }

    fn head_of(conn: &Connection, workspace: &str) -> Result<i64> {
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM updates WHERE workspace = ?1", [workspace], |r| r.get(0))?)
    }
}
