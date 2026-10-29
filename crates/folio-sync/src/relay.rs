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
//! Files (design/attachments.md §5.1): sealed chunks in a folder beside the
//! database (`<db>.blobs/<workspace>/<id prefix>/<id>/<n>`), recorded in
//! `blobs` and `blob_chunks`. A file can be downloaded once its uploader
//! said every chunk is there; unfinished uploads expire after a week.
//!
//! Unused files (§6): each device reports the files it still uses (its
//! latest report replaces the one before, in `blob_refs`). A whole file no
//! device uses is marked `unused_since`; it is deleted once it has been
//! unused for the grace period (30 days by default) and every device has
//! reported since it was marked. A device that never reports keeps every
//! file; removing a device stops it counting.
//!
//! Used by `folio-server` behind HTTP, and directly by the simulator.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::crypto::WrappedKey;
use crate::crypto::{chunks_for, MAX_SEALED_CHUNK};
use crate::protocol::{Round, AcksResponse, BlobState, BlobsResponse, DeviceInfo, HeavyDoc, PullResponse, PulledAck, PulledItem, PushItem, MAX_BLOB_IDS, MAX_PULL, MAX_REF_IDS};
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
  -- Files: one row each, whole once 'complete'; the chunks received.
  CREATE TABLE IF NOT EXISTS blobs (
    workspace TEXT NOT NULL, id TEXT NOT NULL, chunks INTEGER,
    size INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
    device TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace, id)
  );
  CREATE TABLE IF NOT EXISTS blob_chunks (
    workspace TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (workspace, id, n)
  );
  -- Each device's latest report of the files it uses.
  CREATE TABLE IF NOT EXISTS blob_refs (
    workspace TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL,
    PRIMARY KEY (workspace, device, id)
  );
";

/// Columns added after the first release, as (table, column, definition).
/// Added when missing, so a server's existing database keeps working.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    // 'update', or 'snapshot' for a compacted document's full snapshot.
    ("updates", "kind", "TEXT NOT NULL DEFAULT 'update'"),
    // Set when another device removed this one from the workspace.
    ("devices", "removed_at", "INTEGER"),
    // When the device last reported the files it uses.
    ("devices", "refs_at", "INTEGER"),
    // When the file was first seen used by no device.
    ("blobs", "unused_since", "INTEGER"),
    // The cursor the device's version reports are true as of, and the
    // number of its last round of them.
    ("devices", "acked_through", "INTEGER"),
    ("devices", "acked_round", "INTEGER"),
    ("devices", "acked_started", "INTEGER"),
];

/// A document's log is due for a snapshot from this many updates…
pub const SNAPSHOT_MIN_UPDATES: i64 = 100;
/// …or this many bytes.
pub const SNAPSHOT_MIN_BYTES: i64 = 256 * 1024;

/// The largest file accepted, in plain bytes (as the app's own limit).
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Unfinished uploads older than this are deleted.
pub const UNFINISHED_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Files no device uses are deleted after this long, by default.
pub const UNUSED_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub struct Relay {
    conn: Mutex<Connection>,
    /// When a document's log is due for a snapshot: updates, bytes.
    snapshot_at: (i64, i64),
    /// Where file chunks are kept.
    blob_dir: PathBuf,
    /// A folder of its own for an in-memory relay, removed with it.
    temporary: bool,
    /// Largest file (plain bytes); room per workspace (stored bytes).
    max_file: u64,
    quota: Option<u64>,
    /// How long a file no device uses is kept; None keeps it for good.
    unused_grace: Option<i64>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_dir_all(&self.blob_dir);
        }
    }
}

fn is_blob_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn io(e: std::io::Error) -> SyncError {
    SyncError::Storage(e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Relay {
    /// Opens the database at `path`; files go in `<path>.blobs` beside it.
    pub fn open(path: &Path) -> Result<Relay> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        let mut dir = path.as_os_str().to_owned();
        dir.push(".blobs");
        let relay = Self::with(conn, PathBuf::from(dir), false)?;
        relay.skip_used_seqs()?;
        Ok(relay)
    }

    /// Starts the logs' seqs at no less than the time (µs): a database put
    /// back to an older copy would otherwise give out seqs again that
    /// devices have pulled past, and they would miss what goes under them.
    /// Seqs given out before are below it unless more than a million a
    /// second were.
    fn skip_used_seqs(&self) -> Result<()> {
        let floor = now_ms() * 1000;
        let conn = self.conn();
        for table in ["updates", "acks"] {
            let n = conn.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?2) WHERE name = ?1", params![table, floor])?;
            if n == 0 {
                conn.execute("INSERT INTO sqlite_sequence(name, seq) VALUES (?1, ?2)", params![table, floor])?;
            }
        }
        Ok(())
    }

    /// A relay that keeps nothing: its files go in a temporary folder.
    pub fn open_in_memory() -> Result<Relay> {
        let name = format!("folio-relay-{}", crate::crypto::random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect::<String>());
        Self::with(Connection::open_in_memory()?, std::env::temp_dir().join(name), true)
    }

    fn with(conn: Connection, blob_dir: PathBuf, temporary: bool) -> Result<Relay> {
        conn.execute_batch(SCHEMA)?;
        for (table, column, definition) in ADDED_COLUMNS {
            let exists: bool =
                conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1)"), [column], |r| r.get(0))?;
            if !exists {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;
            }
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS updates_by_doc ON updates(workspace, doc, seq);")?;
        Ok(Relay { conn: Mutex::new(conn), snapshot_at: (SNAPSHOT_MIN_UPDATES, SNAPSHOT_MIN_BYTES), blob_dir, temporary, max_file: MAX_FILE_BYTES, quota: None, unused_grace: Some(UNUSED_GRACE_MS) })
    }

    /// Other limits for files: the largest (plain bytes), and the room each
    /// workspace has (stored bytes; None for no limit).
    pub fn with_file_limits(mut self, max_file: u64, quota: Option<u64>) -> Relay {
        self.max_file = max_file;
        self.quota = quota;
        self
    }

    /// How long a file no device uses is kept before it is deleted (None:
    /// for good).
    pub fn with_unused_grace(mut self, grace_ms: Option<i64>) -> Relay {
        self.unused_grace = grace_ms;
        self
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
        tx.execute("DELETE FROM blob_refs WHERE workspace = ?1 AND device = ?2", params![workspace, other])?;
        tx.commit()?;
        Ok(())
    }

    /// The workspace's devices, most recently seen first.
    pub fn devices(&self, workspace: &str, device: &str) -> Result<Vec<DeviceInfo>> {
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut stmt = conn.prepare_cached(
            "SELECT device, name, first_seen, last_seen, acked_through, acked_round, acked_started,
                    (SELECT COUNT(*) FROM acks a WHERE a.workspace = devices.workspace AND a.device = devices.device)
             FROM devices WHERE workspace = ?1 AND removed_at IS NULL ORDER BY last_seen DESC, device",
        )?;
        let rows = stmt.query_map([workspace], |r| {
            Ok(DeviceInfo {
                device: r.get(0)?,
                name: r.get::<_, Option<Vec<u8>>>(1)?.map(|n| crate::crypto::b64(&n)),
                first_seen: r.get(2)?,
                last_seen: r.get(3)?,
                acked_through: r.get(4)?,
                acked_round: r.get(5)?,
                acked_started: r.get(6)?,
                acked_docs: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Stores the device's reports, each replacing its previous one for
    /// that document, and the round they end if it is taken (see
    /// `AcksStored`). Returns whether it was (true with no round).
    pub fn push_acks(&self, workspace: &str, device: &str, items: &[PushItem], round: Option<Round>) -> Result<bool> {
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let tx = conn.transaction()?;
        let at = now_ms();
        Self::touch(&tx, workspace, device, at)?;
        let (previous, started): (Option<i64>, Option<i64>) = tx.query_row(
            "SELECT acked_round, acked_started FROM devices WHERE workspace = ?1 AND device = ?2",
            params![workspace, device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        for item in items {
            let blob = crate::crypto::unb64(&item.blob)?;
            tx.execute(
                "INSERT OR REPLACE INTO acks(workspace, device, doc, blob, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace, device, item.doc, blob, at],
            )?;
        }
        let accepted = round.is_none_or(|round| {
            round.number == 1 || (started == Some(round.started) && previous.is_some_and(|p| p == round.number || p + 1 == round.number))
        });
        if let Some(round) = round.filter(|_| accepted) {
            tx.execute(
                "UPDATE devices SET acked_through = ?3, acked_round = ?4, acked_started = ?5 WHERE workspace = ?1 AND device = ?2",
                params![workspace, device, round.through, round.number, round.started],
            )?;
        }
        tx.commit()?;
        Ok(accepted)
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
        // The device pulled further than the server now has (it was put
        // back to an older copy): the device starts over at its next sync.
        if covers > Self::head_of(&tx, workspace)? {
            return Err(SyncError::Conflict("a snapshot cannot cover updates not yet on the server".into()));
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

    fn chunk_path(&self, workspace: &str, id: &str, n: u32) -> PathBuf {
        self.blob_dir.join(workspace).join(&id[..2]).join(id).join(n.to_string())
    }

    fn check_blob(id: &str) -> Result<()> {
        if is_blob_id(id) { Ok(()) } else { Err(SyncError::Protocol("bad file id".into())) }
    }

    /// Which of `ids` the server has, whole or in part; and how many bytes
    /// the workspace's whole files take.
    pub fn blobs(&self, workspace: &str, device: &str, ids: &[String]) -> Result<BlobsResponse> {
        if ids.len() > MAX_BLOB_IDS {
            return Err(SyncError::Protocol(format!("at most {MAX_BLOB_IDS} files at once")));
        }
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let mut blobs = Vec::new();
        for id in ids {
            let row: Option<(bool, Option<u32>)> = conn
                .query_row("SELECT complete, chunks FROM blobs WHERE workspace = ?1 AND id = ?2", params![workspace, id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let Some((complete, chunks)) = row else { continue };
            let have = if complete {
                Vec::new()
            } else {
                let mut stmt = conn.prepare_cached("SELECT n FROM blob_chunks WHERE workspace = ?1 AND id = ?2 ORDER BY n")?;
                stmt.query_map(params![workspace, id], |r| r.get(0))?.collect::<std::result::Result<Vec<u32>, _>>()?
            };
            blobs.push(BlobState { id: id.clone(), complete, chunks: if complete { chunks.unwrap_or(0) } else { have.len() as u32 }, have });
        }
        let total_bytes = conn.query_row("SELECT COALESCE(SUM(size), 0) FROM blobs WHERE workspace = ?1 AND complete = 1", [workspace], |r| r.get(0))?;
        Ok(BlobsResponse { blobs, total_bytes })
    }

    /// Stores chunk `n` of a file. A chunk of a file already whole is
    /// ignored; one sent again replaces the first.
    pub fn put_chunk(&self, workspace: &str, device: &str, id: &str, n: u32, bytes: &[u8]) -> Result<()> {
        Self::check_blob(id)?;
        if bytes.len() > MAX_SEALED_CHUNK {
            return Err(SyncError::TooLarge(format!("a chunk has at most {MAX_SEALED_CHUNK} bytes")));
        }
        if n >= chunks_for(self.max_file) {
            return Err(SyncError::TooLarge(format!("files on this server have at most {} MB", self.max_file / 1024 / 1024)));
        }
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let complete: Option<bool> =
            conn.query_row("SELECT complete FROM blobs WHERE workspace = ?1 AND id = ?2", params![workspace, id], |r| r.get(0)).optional()?;
        if complete == Some(true) {
            return Ok(());
        }
        if let Some(quota) = self.quota {
            let used: i64 = conn.query_row("SELECT COALESCE(SUM(size), 0) FROM blob_chunks WHERE workspace = ?1", [workspace], |r| r.get(0))?;
            if used as u64 + bytes.len() as u64 > quota {
                return Err(SyncError::Full(format!("this sync space has room for {} MB of files", quota / 1024 / 1024)));
            }
        }
        let path = self.chunk_path(workspace, id, n);
        std::fs::create_dir_all(path.parent().expect("a folder")).map_err(io)?;
        let partial = path.with_extension("part");
        std::fs::write(&partial, bytes).map_err(io)?;
        std::fs::rename(&partial, &path).map_err(io)?;
        conn.execute(
            "INSERT OR IGNORE INTO blobs(workspace, id, device, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![workspace, id, device, now_ms()],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO blob_chunks(workspace, id, n, size) VALUES (?1, ?2, ?3, ?4)",
            params![workspace, id, n, bytes.len() as i64],
        )?;
        Ok(())
    }

    /// Marks a file whole: chunks 0 to `chunks - 1` must all be there.
    pub fn finish_blob(&self, workspace: &str, device: &str, id: &str, chunks: u32) -> Result<()> {
        Self::check_blob(id)?;
        let conn = self.conn();
        self.require(&conn, workspace)?;
        Self::touch(&conn, workspace, device, now_ms())?;
        let complete: Option<bool> =
            conn.query_row("SELECT complete FROM blobs WHERE workspace = ?1 AND id = ?2", params![workspace, id], |r| r.get(0)).optional()?;
        match complete {
            Some(true) => return Ok(()),
            Some(false) => {}
            None => return Err(SyncError::NotFound(format!("file {id}"))),
        }
        let (count, size): (u32, i64) = conn.query_row(
            "SELECT count(*), COALESCE(SUM(size), 0) FROM blob_chunks WHERE workspace = ?1 AND id = ?2 AND n < ?3",
            params![workspace, id, chunks],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if chunks == 0 || count != chunks {
            return Err(SyncError::Conflict(format!("file {id} has {count} of {chunks} chunks")));
        }
        conn.execute("DELETE FROM blob_chunks WHERE workspace = ?1 AND id = ?2 AND n >= ?3", params![workspace, id, chunks])?;
        conn.execute(
            "UPDATE blobs SET complete = 1, chunks = ?3, size = ?4 WHERE workspace = ?1 AND id = ?2",
            params![workspace, id, chunks, size],
        )?;
        Ok(())
    }

    /// Chunk `n` of a whole file.
    pub fn get_chunk(&self, workspace: &str, device: &str, id: &str, n: u32) -> Result<Vec<u8>> {
        Self::check_blob(id)?;
        {
            let conn = self.conn();
            self.require(&conn, workspace)?;
            Self::touch(&conn, workspace, device, now_ms())?;
            let whole: bool = conn
                .query_row("SELECT complete = 1 AND ?3 < chunks FROM blobs WHERE workspace = ?1 AND id = ?2", params![workspace, id, n], |r| r.get(0))
                .optional()?
                .unwrap_or(false);
            if !whole {
                return Err(SyncError::NotFound(format!("file {id} chunk {n}")));
            }
        }
        std::fs::read(self.chunk_path(workspace, id, n)).map_err(io)
    }

    /// Deletes uploads left unfinished since before `now - UNFINISHED_MS`;
    /// returns how many.
    pub fn expire_unfinished(&self, now: i64) -> Result<usize> {
        let stale: Vec<(String, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT workspace, id FROM blobs WHERE complete = 0 AND created_at < ?1")?;
            stmt.query_map([now - UNFINISHED_MS], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?
        };
        for (workspace, id) in &stale {
            self.delete_blob(workspace, id)?;
        }
        Ok(stale.len())
    }

    /// Records the files `device` uses now, replacing its last report;
    /// returns those of them the server does not have whole, for the
    /// device to upload again if it has them.
    pub fn report_refs(&self, workspace: &str, device: &str, ids: &[String]) -> Result<Vec<String>> {
        if ids.len() > MAX_REF_IDS {
            return Err(SyncError::Protocol(format!("at most {MAX_REF_IDS} files in a report")));
        }
        if let Some(bad) = ids.iter().find(|id| !is_blob_id(id)) {
            return Err(SyncError::Protocol(format!("bad file id {bad}")));
        }
        let mut conn = self.conn();
        self.require(&conn, workspace)?;
        let now = now_ms();
        let tx = conn.transaction()?;
        Self::touch(&tx, workspace, device, now)?;
        tx.execute("DELETE FROM blob_refs WHERE workspace = ?1 AND device = ?2", params![workspace, device])?;
        let mut missing = Vec::new();
        {
            let mut add = tx.prepare_cached("INSERT OR IGNORE INTO blob_refs(workspace, device, id) VALUES (?1, ?2, ?3)")?;
            let mut whole =
                tx.prepare_cached("UPDATE blobs SET unused_since = NULL WHERE workspace = ?1 AND id = ?2 AND complete = 1 RETURNING 1")?;
            for id in ids {
                add.execute(params![workspace, device, id])?;
                if whole.query_row(params![workspace, id], |_| Ok(())).optional()?.is_none() {
                    missing.push(id.clone());
                }
            }
        }
        tx.execute("UPDATE devices SET refs_at = ?3 WHERE workspace = ?1 AND device = ?2", params![workspace, device, now])?;
        tx.commit()?;
        Ok(missing)
    }

    /// Marks whole files no device uses, unmarks those used again, and
    /// deletes those unused for the grace period that every device has
    /// reported without since; returns how many were deleted.
    pub fn sweep_unused(&self, now: i64) -> Result<usize> {
        const USED: &str = "EXISTS (SELECT 1 FROM blob_refs r JOIN devices d ON d.workspace = r.workspace AND d.device = r.device
                             WHERE r.workspace = blobs.workspace AND r.id = blobs.id AND d.removed_at IS NULL)";
        let doomed: Vec<(String, String)> = {
            let conn = self.conn();
            conn.execute(&format!("UPDATE blobs SET unused_since = NULL WHERE unused_since IS NOT NULL AND {USED}"), [])?;
            conn.execute(&format!("UPDATE blobs SET unused_since = ?1 WHERE complete = 1 AND unused_since IS NULL AND NOT {USED}"), [now])?;
            let Some(grace) = self.unused_grace else { return Ok(0) };
            let mut stmt = conn.prepare(
                "SELECT workspace, id FROM blobs b WHERE complete = 1 AND unused_since <= ?1
                   AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.workspace = b.workspace AND d.removed_at IS NULL
                                     AND (d.refs_at IS NULL OR d.refs_at < b.unused_since))",
            )?;
            stmt.query_map([now - grace], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?
        };
        for (workspace, id) in &doomed {
            self.delete_blob(workspace, id)?;
        }
        Ok(doomed.len())
    }

    /// Deletes a file's record, then its chunks.
    fn delete_blob(&self, workspace: &str, id: &str) -> Result<()> {
        {
            let conn = self.conn();
            conn.execute("DELETE FROM blob_chunks WHERE workspace = ?1 AND id = ?2", params![workspace, id])?;
            conn.execute("DELETE FROM blobs WHERE workspace = ?1 AND id = ?2", params![workspace, id])?;
        }
        let _ = std::fs::remove_dir_all(self.blob_dir.join(workspace).join(&id[..2]).join(id));
        Ok(())
    }

    /// Copies the whole database to `path` (a backup).
    pub fn copy_to(&self, path: &Path) -> Result<()> {
        self.conn().execute("VACUUM main INTO ?1", [path.to_string_lossy()])?;
        Ok(())
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

    /// Files: chunks in any order, whole only when all are there, limits,
    /// and unfinished uploads expire.
    #[test]
    fn file_chunks_and_limits() {
        let relay = Relay::open_in_memory().unwrap().with_file_limits(3 * crate::crypto::CHUNK as u64, Some(400));
        relay.create_workspace("ws", &crate::crypto::wrap(&crate::crypto::WorkspaceKey::generate(), "p", (1024, 1, 1)).unwrap()).unwrap();
        let id = "0123456789abcdef0123456789abcdef";
        assert!(matches!(relay.put_chunk("ws", "a", "../../etc", 0, b"x"), Err(SyncError::Protocol(_))));
        assert!(matches!(relay.put_chunk("ws", "a", id, 3, b"x"), Err(SyncError::TooLarge(_))), "a fourth chunk is over 3 MB");
        assert!(matches!(relay.finish_blob("ws", "a", id, 2), Err(SyncError::NotFound(_))));
        relay.put_chunk("ws", "a", id, 1, &[1; 100]).unwrap();
        assert!(matches!(relay.finish_blob("ws", "a", id, 2), Err(SyncError::Conflict(_))), "chunk 0 is missing");
        assert!(matches!(relay.get_chunk("ws", "b", id, 1), Err(SyncError::NotFound(_))), "not whole yet");
        let state = &relay.blobs("ws", "b", &[id.into(), "f".repeat(32)]).unwrap().blobs;
        assert_eq!(state, &[BlobState { id: id.into(), complete: false, chunks: 1, have: vec![1] }]);
        relay.put_chunk("ws", "a", id, 0, &[0; 100]).unwrap();
        relay.put_chunk("ws", "a", id, 0, &[0; 150]).unwrap();
        relay.finish_blob("ws", "a", id, 2).unwrap();
        relay.finish_blob("ws", "a", id, 2).unwrap();
        assert_eq!(relay.get_chunk("ws", "b", id, 0).unwrap(), vec![0; 150], "sent again: the second one");
        let r = relay.blobs("ws", "b", &[id.into()]).unwrap();
        assert_eq!((r.blobs[0].complete, r.blobs[0].chunks, r.total_bytes), (true, 2, 250));
        // Room for 400 bytes: 250 used.
        let other = "f".repeat(32);
        assert!(matches!(relay.put_chunk("ws", "a", &other, 0, &[2; 200]), Err(SyncError::Full(_))));
        relay.put_chunk("ws", "a", &other, 0, &[2; 100]).unwrap();
        assert_eq!(relay.expire_unfinished(now_ms()).unwrap(), 0, "not a week old");
        assert_eq!(relay.expire_unfinished(now_ms() + UNFINISHED_MS + 1).unwrap(), 1);
        assert!(relay.blobs("ws", "a", &[other.clone()]).unwrap().blobs.is_empty());
        assert!(!relay.chunk_path("ws", &other, 0).exists());
        assert!(relay.chunk_path("ws", id, 0).exists(), "whole files stay");
        // A removed device gets nothing.
        relay.check_device("ws", "b").unwrap();
        relay.remove_device("ws", "a", "b").unwrap();
        assert!(matches!(relay.get_chunk("ws", "b", id, 0), Err(SyncError::Removed)));
    }

    /// Files no device uses go after the grace period, and only once every
    /// device has said so; a file used again, or a device that never
    /// reports, keeps them.
    #[test]
    fn unused_files_are_deleted_once_every_device_agrees() {
        let relay = Relay::open_in_memory().unwrap();
        relay.create_workspace("ws", &crate::crypto::wrap(&crate::crypto::WorkspaceKey::generate(), "p", (1024, 1, 1)).unwrap()).unwrap();
        let (x, y, z) = ("a".repeat(32), "b".repeat(32), "c".repeat(32));
        for id in [&x, &y] {
            relay.put_chunk("ws", "a", id, 0, &[1; 10]).unwrap();
            relay.finish_blob("ws", "a", id, 1).unwrap();
        }
        relay.check_device("ws", "b").unwrap();
        relay.check_device("ws", "c").unwrap();
        let later = |t: i64| t + UNUSED_GRACE_MS + 1;
        let ids = |v: &[&String]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(relay.report_refs("ws", "a", &ids(&[&x, &z])).unwrap(), vec![z.clone()], "the server lacks z");
        assert!(matches!(relay.report_refs("ws", "a", &["../x".into()]), Err(SyncError::Protocol(_))));
        let t0 = now_ms();
        assert_eq!(relay.sweep_unused(t0).unwrap(), 0, "y is marked, not deleted");
        relay.report_refs("ws", "b", &[]).unwrap();
        assert_eq!(relay.sweep_unused(later(t0)).unwrap(), 0, "a reported before y was marked; c never did");
        relay.report_refs("ws", "a", &ids(&[&x])).unwrap();
        assert_eq!(relay.sweep_unused(later(t0)).unwrap(), 0, "c never reported");
        relay.remove_device("ws", "a", "c").unwrap();
        assert_eq!(relay.sweep_unused(t0 + UNUSED_GRACE_MS - 1).unwrap(), 0, "not 30 days yet");
        assert_eq!(relay.sweep_unused(later(t0)).unwrap(), 1, "y goes");
        assert!(!relay.chunk_path("ws", &y, 0).exists());
        assert_eq!(relay.blobs("ws", "a", &ids(&[&x, &y])).unwrap().blobs.len(), 1, "x stays");

        // x falls out of use, then a card uses it again before it goes.
        relay.report_refs("ws", "a", &[]).unwrap();
        let t1 = now_ms();
        relay.sweep_unused(t1).unwrap();
        assert_eq!(relay.report_refs("ws", "a", &ids(&[&x])).unwrap(), Vec::<String>::new());
        relay.report_refs("ws", "b", &[]).unwrap();
        assert_eq!(relay.sweep_unused(later(t1)).unwrap(), 0, "used again");

        // Kept for good when the grace is off.
        let relay = relay.with_unused_grace(None);
        relay.report_refs("ws", "a", &[]).unwrap();
        relay.sweep_unused(t1).unwrap();
        relay.report_refs("ws", "a", &[]).unwrap();
        relay.report_refs("ws", "b", &[]).unwrap();
        assert_eq!(relay.sweep_unused(later(t1)).unwrap(), 0);
        assert!(relay.chunk_path("ws", &x, 0).exists());
    }

    /// A server database from before snapshots and removal gets the new
    /// columns and keeps its log.
    /// A round of reports: its cursor and number kept and listed with the
    /// devices; a round that does not follow the last is refused (what lets
    /// a device see the server lost its reports).
    #[test]
    fn rounds_of_reports_are_kept() {
        let relay = Relay::open_in_memory().unwrap();
        relay.create_workspace("ws", &crate::crypto::wrap(&crate::crypto::WorkspaceKey::generate(), "p", (1024, 1, 1)).unwrap()).unwrap();
        let item = PushItem { doc: "tag".into(), blob: crate::crypto::b64(b"sealed") };
        let round = |through, number, started| Some(Round { through, number, started });
        assert!(relay.push_acks("ws", "a", &[item.clone()], None).unwrap());
        assert!(!relay.push_acks("ws", "a", &[], round(3, 4, 5)).unwrap(), "not a first round");
        assert!(relay.push_acks("ws", "a", &[item], round(7, 1, 5)).unwrap());
        assert!(relay.push_acks("ws", "a", &[], round(9, 2, 5)).unwrap());
        assert!(relay.push_acks("ws", "a", &[], round(9, 2, 5)).unwrap(), "the reply was lost");
        assert!(!relay.push_acks("ws", "a", &[], round(9, 4, 5)).unwrap(), "round 3 is missing");
        assert!(!relay.push_acks("ws", "a", &[], round(9, 3, 6)).unwrap(), "another count");
        let device = |d: &str| relay.devices("ws", "b").unwrap().into_iter().find(|x| x.device == d).unwrap();
        assert_eq!((device("a").acked_through, device("a").acked_round, device("a").acked_started), (Some(9), Some(2), Some(5)));
        assert_eq!(device("a").acked_docs, Some(1));
        assert_eq!(device("b").acked_through, None);
    }

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
