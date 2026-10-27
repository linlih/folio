//! The server's storage (design/ARCHITECTURE.md §5.3): per workspace, the
//! wrapped key and an append-only log of encrypted updates, numbered by a
//! sequence clients pull after. It understands nothing of their content:
//! Loro updates can be imported repeatedly and in any order, so storing and
//! handing them out by cursor is all a relay has to do.
//!
//! Compaction (§5.3): a device that has every update of a document up to
//! some seq uploads the document's full snapshot (sealed like an update, so
//! it is pulled and imported like one); the relay appends it to the log and
//! deletes the document's entries up to that seq. A device behind gets the
//! snapshot instead of what it replaced. Full snapshots import into any
//! replica, so nothing is ever lost by deleting what they cover.
//!
//! Used by `folio-server` behind HTTP, and directly by the simulator.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::crypto::WrappedKey;
use crate::protocol::{AcksResponse, DeviceInfo, HeavyDoc, PullResponse, PulledAck, PulledItem, PushItem, MAX_PULL};
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

/// Columns added after the first release, as (table, column, definition).
/// Added when missing, so a server's existing database keeps working.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    // 'update', or 'snapshot' for a compacted document's full snapshot.
    ("updates", "kind", "TEXT NOT NULL DEFAULT 'update'"),
    // Set when another device removed this one from the workspace.
    ("devices", "removed_at", "INTEGER"),
];

/// A document's log is due for a snapshot from this many updates…
pub const SNAPSHOT_MIN_UPDATES: i64 = 100;
/// …or this many bytes.
pub const SNAPSHOT_MIN_BYTES: i64 = 256 * 1024;

pub struct Relay {
    conn: Mutex<Connection>,
    /// When a document's log is due for a snapshot: updates, bytes.
    snapshot_at: (i64, i64),
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
        for (table, column, definition) in ADDED_COLUMNS {
            let exists: bool =
                conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1)"), [column], |r| r.get(0))?;
            if !exists {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;
            }
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS updates_by_doc ON updates(workspace, doc, seq);")?;
        Ok(Relay { conn: Mutex::new(conn), snapshot_at: (SNAPSHOT_MIN_UPDATES, SNAPSHOT_MIN_BYTES) })
    }

    /// Other thresholds for `heavy_docs` (tests reach them sooner).
    pub fn with_snapshot_thresholds(mut self, updates: i64, bytes: i64) -> Relay {
        self.snapshot_at = (updates, bytes);
        self
    }

    /// The workspace's log: updates and snapshots in it.
    pub fn log_stats(&self, workspace: &str) -> Result<(i64, i64)> {
        Ok(self.conn().query_row(
            "SELECT count(*) FILTER (WHERE kind = 'update'), count(*) FILTER (WHERE kind = 'snapshot') FROM updates WHERE workspace = ?1",
            [workspace],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
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

    /// Notes that `device` used the workspace now; `Removed` if another
    /// device removed it.
    fn touch(conn: &Connection, workspace: &str, device: &str, at: i64) -> Result<()> {
        let removed: bool = conn
            .query_row("SELECT removed_at IS NOT NULL FROM devices WHERE workspace = ?1 AND device = ?2", params![workspace, device], |r| r.get(0))
            .optional()?
            .unwrap_or(false);
        if removed {
            return Err(SyncError::Removed);
        }
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

    /// Checks that `device` may use the workspace (for the live channel).
    pub fn check_device(&self, workspace: &str, device: &str) -> Result<()> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())
    }

    /// Removes `other` from the workspace: its requests are refused from now
    /// on (it can join again as a new device) and its reports are dropped.
    pub fn remove_device(&self, workspace: &str, device: &str, other: &str) -> Result<()> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        if other == device {
            return Err(SyncError::Conflict("a device cannot remove itself".into()));
        }
        let tx = conn.transaction()?;
        Self::touch(&tx, workspace, device, now_ms())?;
        let changed = tx.execute(
            "UPDATE devices SET removed_at = ?3 WHERE workspace = ?1 AND device = ?2 AND removed_at IS NULL",
            params![workspace, other, now_ms()],
        )?;
        if changed == 0 {
            return Err(SyncError::NotFound(format!("device {other}")));
        }
        tx.execute("DELETE FROM acks WHERE workspace = ?1 AND device = ?2", params![workspace, other])?;
        tx.commit()?;
        Ok(())
    }

    /// The workspace's devices, most recently seen first.
    pub fn devices(&self, workspace: &str, device: &str) -> Result<Vec<DeviceInfo>> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT device, name, first_seen, last_seen FROM devices WHERE workspace = ?1 AND removed_at IS NULL ORDER BY last_seen DESC, device",
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

    /// Documents whose log has grown enough to be replaced by a snapshot.
    pub fn heavy_docs(&self, workspace: &str, device: &str) -> Result<Vec<HeavyDoc>> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT doc, count(*), sum(length(blob)) FROM updates WHERE workspace = ?1 AND kind = 'update'
             GROUP BY doc HAVING count(*) >= ?2 OR sum(length(blob)) >= ?3",
        )?;
        let rows = stmt.query_map(params![workspace, self.snapshot_at.0, self.snapshot_at.1], |r| {
            Ok(HeavyDoc { doc: r.get(0)?, updates: r.get(1)?, bytes: r.get(2)? })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Stores a document's full snapshot, which holds every update of it up
    /// to `covers` (the device has pulled that far), and deletes those.
    /// Returns the snapshot's seq.
    pub fn push_snapshot(&self, workspace: &str, device: &str, item: &PushItem, covers: i64) -> Result<i64> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let tx = conn.transaction()?;
        let at = now_ms();
        Self::touch(&tx, workspace, device, at)?;
        if covers > Self::head_of(&tx, workspace)? {
            return Err(SyncError::Protocol("a snapshot cannot cover updates not yet on the server".into()));
        }
        let blob = crate::crypto::unb64(&item.blob)?;
        tx.execute(
            "INSERT INTO updates(workspace, doc, device, blob, at, kind) VALUES (?1, ?2, ?3, ?4, ?5, 'snapshot')",
            params![workspace, item.doc, device, blob, at],
        )?;
        let seq = tx.last_insert_rowid();
        tx.execute("DELETE FROM updates WHERE workspace = ?1 AND doc = ?2 AND seq <= ?3", params![workspace, item.doc, covers])?;
        tx.commit()?;
        Ok(seq)
    }

    pub fn head(&self, workspace: &str) -> Result<i64> {
        Self::head_of(&self.conn(), workspace)
    }

    fn head_of(conn: &Connection, workspace: &str) -> Result<i64> {
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM updates WHERE workspace = ?1", [workspace], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server database from before snapshots and removal gets the new
    /// columns and keeps its log.
    #[test]
    fn an_older_database_is_brought_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, wrapped_key TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE TABLE updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, doc TEXT NOT NULL,
                   device TEXT NOT NULL, blob BLOB NOT NULL, at INTEGER NOT NULL);
                 CREATE TABLE devices (workspace TEXT NOT NULL, device TEXT NOT NULL, name BLOB,
                   first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (workspace, device));
                 INSERT INTO workspaces VALUES ('ws', '{}', 1);
                 INSERT INTO updates(workspace, doc, device, blob, at) VALUES ('ws', 'tag', 'a', x'01', 1), ('ws', 'tag', 'a', x'02', 2);",
            )
            .unwrap();
        }
        let relay = Relay::open(&path).unwrap().with_snapshot_thresholds(2, 1 << 20);
        assert_eq!(relay.log_stats("ws").unwrap(), (2, 0));
        assert_eq!(relay.heavy_docs("ws", "a").unwrap().len(), 1);
        let item = PushItem { doc: "tag".into(), blob: crate::crypto::b64(b"snapshot") };
        assert!(relay.push_snapshot("ws", "a", &item, 3).is_err(), "cannot cover what is not there");
        let seq = relay.push_snapshot("ws", "a", &item, 2).unwrap();
        assert_eq!(relay.log_stats("ws").unwrap(), (0, 1));
        assert_eq!(relay.pull("ws", "a", 0, 10).unwrap().updates.iter().map(|u| u.seq).collect::<Vec<_>>(), vec![seq]);
        // Opening again changes nothing.
        drop(relay);
        assert_eq!(Relay::open(&path).unwrap().log_stats("ws").unwrap(), (0, 1));
    }
}
