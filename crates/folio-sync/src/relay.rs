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
use crate::protocol::{AcksResponse, DeviceInfo, PullResponse, PulledAck, PulledItem, PushItem, MAX_PULL};
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
  CREATE TABLE IF NOT EXISTS devices (
    workspace TEXT NOT NULL, device TEXT NOT NULL, name BLOB,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    PRIMARY KEY (workspace, device)
  );
  -- A device's latest report per document; a new report replaces the row
  -- and so takes a new seq, which is what pulls go by.
  CREATE TABLE IF NOT EXISTS acks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL, device TEXT NOT NULL, doc TEXT NOT NULL,
    blob BLOB NOT NULL, at INTEGER NOT NULL,
    UNIQUE (workspace, device, doc)
  );
  CREATE INDEX IF NOT EXISTS acks_by_workspace ON acks(workspace, seq);
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

    /// Notes that `device` used the workspace now.
    fn touch(conn: &Connection, workspace: &str, device: &str, at: i64) -> Result<()> {
        conn.execute(
            "INSERT INTO devices(workspace, device, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(workspace, device) DO UPDATE SET last_seen = excluded.last_seen",
            params![workspace, device, at],
        )?;
        Ok(())
    }

    /// Appends updates; returns the new head.
    pub fn push(&self, workspace: &str, device: &str, items: &[PushItem]) -> Result<i64> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let tx = conn.transaction()?;
        let at = now_ms();
        Self::touch(&tx, workspace, device, at)?;
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
    pub fn pull(&self, workspace: &str, device: &str, after: i64, limit: u32) -> Result<PullResponse> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT seq, doc, device, blob FROM updates WHERE workspace = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![workspace, after, limit.clamp(1, MAX_PULL)], |r| {
            Ok(PulledItem { seq: r.get(0)?, doc: r.get(1)?, device: r.get(2)?, blob: crate::crypto::b64(&r.get::<_, Vec<u8>>(3)?) })
        })?;
        let updates = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(PullResponse { updates, head: Self::head_of(&conn, workspace)? })
    }

    /// Sets the device's sealed name.
    pub fn set_device_name(&self, workspace: &str, device: &str, name: &[u8]) -> Result<()> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        conn.execute("UPDATE devices SET name = ?3 WHERE workspace = ?1 AND device = ?2", params![workspace, device, name])?;
        Ok(())
    }

    /// The workspace's devices, most recently seen first.
    pub fn devices(&self, workspace: &str, device: &str) -> Result<Vec<DeviceInfo>> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT device, name, first_seen, last_seen FROM devices WHERE workspace = ?1 ORDER BY last_seen DESC, device",
        )?;
        let rows = stmt.query_map([workspace], |r| {
            Ok(DeviceInfo {
                device: r.get(0)?,
                name: r.get::<_, Option<Vec<u8>>>(1)?.map(|n| crate::crypto::b64(&n)),
                first_seen: r.get(2)?,
                last_seen: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Stores the device's reports, each replacing its previous one for
    /// that document.
    pub fn push_acks(&self, workspace: &str, device: &str, items: &[PushItem]) -> Result<()> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let tx = conn.transaction()?;
        let at = now_ms();
        Self::touch(&tx, workspace, device, at)?;
        for item in items {
            let blob = crate::crypto::unb64(&item.blob)?;
            tx.execute(
                "INSERT OR REPLACE INTO acks(workspace, device, doc, blob, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace, device, item.doc, blob, at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Reports after `after`, oldest first.
    pub fn pull_acks(&self, workspace: &str, device: &str, after: i64, limit: u32) -> Result<AcksResponse> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT seq, device, doc, blob FROM acks WHERE workspace = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![workspace, after, limit.clamp(1, MAX_PULL)], |r| {
            Ok(PulledAck { seq: r.get(0)?, device: r.get(1)?, doc: r.get(2)?, blob: crate::crypto::b64(&r.get::<_, Vec<u8>>(3)?) })
        })?;
        let acks = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let head = conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM acks WHERE workspace = ?1", [workspace], |r| r.get(0))?;
        Ok(AcksResponse { acks, head })
    }

    pub fn head(&self, workspace: &str) -> Result<i64> {
        Self::head_of(&self.conn(), workspace)
    }

    fn head_of(conn: &Connection, workspace: &str) -> Result<i64> {
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM updates WHERE workspace = ?1", [workspace], |r| r.get(0))?)
    }
}
