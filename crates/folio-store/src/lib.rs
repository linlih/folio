//! SQLite storage (design/ARCHITECTURE.md §3.1, §4.4).
//!
//! - `store.db` is the source of truth: a snapshot per document plus the
//!   append-only log of updates since that snapshot, the sync outbox and the
//!   device-local settings.
//! - `index.db` is derived and can be deleted at any time; it is attached to
//!   the same connection as schema `idx` and rebuilt from `store.db`.
//!
//! `Store::apply_update` is the single write path for document content: local
//! edits, remote updates and imports all go through it (§3.1 invariant 1).

pub mod assets;
pub mod backup;
mod compact;
mod schema;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use loro::{ExportMode, LoroDoc};
use folio_core::card::{self, CardKind, CardSummary};
use folio_core::{DocId, DocKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub use assets::{AssetInfo, Incoming, Swept};
pub use backup::{BackupInfo, CardVersion};
pub use compact::Compacted;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("loro: {0}")]
    Loro(String),
    #[error("{0}")]
    Id(#[from] folio_core::IdError),
    #[error("unknown document {0}")]
    NotFound(String),
    #[error("settings value is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the file is larger than {} MB", .0 / 1024 / 1024)]
    TooLarge(u64),
    #[error("damaged: {0}")]
    Damaged(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn loro_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::Loro(e.to_string())
}

/// Where an update came from; recorded with it for audits and sync.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Typed on this device; also queued for upload.
    Local,
    /// Received from the sync server.
    Remote,
    /// Produced by an importer.
    Import,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::Local => "local",
            Origin::Remote => "remote",
            Origin::Import => "import",
        }
    }
}

/// A tag in use (`idx.tags`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    /// Lower case; what tags are matched by.
    pub key: String,
    /// As most recently written.
    pub name: String,
    pub blocks: i64,
    pub cards: i64,
    pub last_used: Option<i64>,
}

/// A card's title and body text (one line per block, tabs for depth), for
/// showing it on a whiteboard (§4.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardText {
    pub id: String,
    pub title: String,
    pub text: String,
    pub deleted: bool,
}

/// A topic's number of cards (§4.7).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicCount {
    pub id: String,
    pub cards: i64,
}

/// A local update waiting to be sent to the sync server.
#[derive(Clone, Debug)]
pub struct OutboxItem {
    pub id: i64,
    pub doc: DocId,
    pub kind: DocKind,
    pub bytes: Vec<u8>,
}

/// A row of the card library (`idx.cards`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub preview: String,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

/// A link in the inbox.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub title: String,
    /// The notes written on it, or the page's summary.
    pub preview: String,
    pub clip: Option<folio_core::card::Clip>,
    pub inbox_at: i64,
    pub updated_at: i64,
}

/// A row of a tag's database.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCard {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    /// Field values by field id, a JSON object.
    pub props: String,
    /// The link, for a clipped card.
    pub url: Option<String>,
}

/// A block that links to a card or references one of its blocks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub card_id: String,
    pub card_title: String,
    pub card_kind: String,
    pub bid: String,
    pub text: String,
    /// "link" ([[card]]) or "ref" (((block)) of the card), or "mention"
    /// (unlinked: the card's title appears in the text).
    pub via: String,
    /// The blocks nested under it, in document order (a tag page: a tag
    /// written alone on a line, with the note indented below it).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ChildBlock>,
}

/// A block nested under another; `depth` 1 is directly under it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildBlock {
    pub bid: String,
    pub depth: u32,
    pub text: String,
}

/// A search result: a card (by title, `bid` None) or one of its blocks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub card_id: String,
    pub card_title: String,
    pub card_kind: String,
    pub bid: Option<String>,
    pub text: String,
}

/// A block's current text, for rendering block references.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockText {
    pub bid: String,
    pub card_id: String,
    pub text: String,
}

/// True when the library in `dir` holds any document. Read-only, without
/// opening the store (which would create and migrate it): the app uses it to
/// tell an empty library started by mistake from a real one.
pub fn has_documents(dir: &Path) -> Result<bool> {
    let path = dir.join("store.db");
    if !path.exists() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let has_table: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'docs')", [], |r| r.get(0))?;
    if !has_table {
        return Ok(false);
    }
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM docs)", [], |r| r.get(0))?)
}

/// What substring search sees of a clipped link besides its title.
fn clip_text(s: &CardSummary) -> Option<String> {
    let c = s.clip.as_ref()?;
    Some([c.site.as_str(), c.author.as_str(), c.excerpt.as_str()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n"))
}

/// A tag's key: tags match case-insensitively.
pub fn tag_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// FTS5 trigram needs three characters; shorter queries use LIKE.
fn fts_ok(q: &str) -> bool {
    q.chars().count() >= 3
}

/// A query as one FTS5 phrase.
fn fts_phrase(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

fn like(q: &str) -> String {
    format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// A journal day that has content, for the read-only part of the journal stream.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDay {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// One line per block; tabs mark outline depth.
    pub text: String,
    pub updated_at: i64,
}

fn backlink_row(r: &rusqlite::Row) -> rusqlite::Result<Backlink> {
    Ok(Backlink { card_id: r.get(0)?, card_title: r.get(1)?, card_kind: r.get(2)?, bid: r.get(3)?, text: r.get(4)?, via: r.get(5)?, children: Vec::new() })
}

pub struct Store {
    conn: Connection,
    /// The Rust-side replica of each open document (§3.1 invariant 3).
    docs: HashMap<DocId, LoroDoc>,
    /// This device's peer id for documents edited from Rust (§4.5 rule 3).
    peer: u64,
    /// The data folder (`store.db`, `index.db`, `backups/`).
    dir: PathBuf,
    /// Documents deleted for good since `take_purged` was last called.
    purged_now: Vec<DocId>,
}

/// The workspace document's map of documents deleted for good: id → when
/// (§5.4). It syncs like any edit, so every device deletes them.
const PURGED: &str = "purged";

/// `sync_state` keys of this library's peer ids: Rust's, the editor's and
/// the API replica's (§4.5 rule 3).
pub(crate) const PEER_KEYS: [&str; 3] = ["peer.rust", "peer.frontend", "peer.api"];

impl Store {
    /// Opens (creating if needed) `store.db` and `index.db` in `dir`.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("store.db"))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        let index_path: PathBuf = dir.join("index.db");
        conn.execute("ATTACH DATABASE ?1 AS idx", [index_path.to_string_lossy()])?;
        if schema::has_pending_migrations(&conn)? {
            backup::backup_conn_before_upgrade(&conn, &backup::backups_dir(dir), now_ms())?;
        }
        let index_recreated = schema::migrate(&conn)?;
        let peer = Self::load_or_create_peer(&conn, PEER_KEYS[0])?;
        let mut store = Store { conn, docs: HashMap::new(), peer, dir: dir.to_path_buf(), purged_now: Vec::new() };
        let migrated = store.migrate_bodies()?;
        if index_recreated || migrated > 0 || store.index_is_empty()? {
            store.rebuild_index()?;
        }
        // A library from an app that did not delete for good yet.
        store.apply_purges(now_ms())?;
        Ok(store)
    }

    fn load_or_create_peer(conn: &Connection, key: &str) -> Result<u64> {
        let existing: Option<Vec<u8>> =
            conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        if let Some(bytes) = existing.filter(|b| b.len() == 8) {
            return Ok(u64::from_le_bytes(bytes.try_into().unwrap()));
        }
        // Random, persisted, never shared with another live replica.
        let peer = loro::LoroDoc::new().peer_id();
        conn.execute("INSERT OR REPLACE INTO sync_state(key, value) VALUES (?1, ?2)", params![key, peer.to_le_bytes().to_vec()])?;
        Ok(peer)
    }

    /// The peer id the frontend replica must use: distinct from Rust's own and
    /// stable across launches (§4.5 rule 3).
    pub fn frontend_peer(&self) -> Result<u64> {
        Self::load_or_create_peer(&self.conn, PEER_KEYS[1])
    }

    /// The peer id of the frontend's API replica (`web/src/api`), which edits
    /// documents on behalf of commands, plugins and AI next to the editor's
    /// replica, so it needs its own id.
    pub fn api_peer(&self) -> Result<u64> {
        Self::load_or_create_peer(&self.conn, PEER_KEYS[2])
    }

    /// The single write path for document content.
    /// Updates of a document deleted for good are dropped.
    pub fn apply_update(&mut self, id: &DocId, kind: DocKind, bytes: &[u8], origin: Origin, now_ms: i64) -> Result<()> {
        if self.is_purged(id)? {
            tracing::debug!(doc = %id, "dropped an update of a document deleted for good");
            return Ok(());
        }
        let doc = self.doc_mut(id, kind)?;
        doc.import(bytes).map_err(loro_err)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO docs(doc_id, kind, snapshot, updated_at, changed)
               VALUES (?1, ?2, NULL, ?3, (SELECT COALESCE(MAX(changed), 0) + 1 FROM docs))
             ON CONFLICT(doc_id) DO UPDATE SET updated_at = excluded.updated_at, changed = excluded.changed",
            params![id.as_str(), kind.as_str(), now_ms],
        )?;
        tx.execute(
            "INSERT INTO doc_updates(doc_id, bytes, origin, at) VALUES (?1, ?2, ?3, ?4)",
            params![id.as_str(), bytes, origin.as_str(), now_ms],
        )?;
        if origin == Origin::Local {
            tx.execute("INSERT INTO outbox(doc_id, bytes, at) VALUES (?1, ?2, ?3)", params![id.as_str(), bytes, now_ms])?;
        }
        tx.commit()?;
        if kind == DocKind::Card {
            self.reindex_card(id, now_ms)?;
        }
        if kind == DocKind::Workspace {
            self.apply_purges(now_ms)?;
        }
        Ok(())
    }

    // ---- sync (§5.3; the engine is in folio-sync) ----

    /// The oldest local updates not yet acknowledged by the server.
    pub fn outbox_batch(&self, limit: u32) -> Result<Vec<OutboxItem>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT o.id, o.doc_id, d.kind, o.bytes FROM outbox o JOIN docs d ON d.doc_id = o.doc_id ORDER BY o.id LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Vec<u8>>(3)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, doc, kind, bytes) = row?;
            let Some(kind) = DocKind::parse(&kind) else { continue };
            out.push(OutboxItem { id, doc: DocId::parse(&doc)?, kind, bytes });
        }
        Ok(out)
    }

    /// Drops outbox entries the server has stored.
    pub fn outbox_ack(&self, ids: &[i64]) -> Result<()> {
        let mut stmt = self.conn.prepare_cached("DELETE FROM outbox WHERE id = ?1")?;
        for id in ids {
            stmt.execute([id])?;
        }
        Ok(())
    }

    pub fn outbox_len(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))?)
    }

    /// Documents with updates still to send.
    pub fn outbox_docs(&self) -> Result<std::collections::HashSet<DocId>> {
        let mut stmt = self.conn.prepare_cached("SELECT DISTINCT doc_id FROM outbox")?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?;
        ids.map(|id| DocId::parse(&id?).map_err(StoreError::from)).collect()
    }

    /// Queues an update of a stored document to send again (the convergence
    /// check found a device without it).
    pub fn queue_update(&self, id: &DocId, bytes: &[u8], now_ms: i64) -> Result<()> {
        self.conn.execute("INSERT INTO outbox(doc_id, bytes, at) VALUES (?1, ?2, ?3)", params![id.as_str(), bytes, now_ms])?;
        Ok(())
    }

    /// Replaces the outbox with each document's whole history, one entry per
    /// document: what a device sends when it starts syncing, so nothing
    /// written before (migrations, restores, imports) is left behind.
    pub fn queue_everything(&mut self, now_ms: i64) -> Result<usize> {
        let docs: Vec<(String, String)> = {
            let mut stmt = self.conn.prepare("SELECT doc_id, kind FROM docs ORDER BY doc_id")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?
        };
        let mut all = Vec::with_capacity(docs.len());
        for (id, kind) in &docs {
            let (Ok(id), Some(kind)) = (DocId::parse(id), DocKind::parse(kind)) else { continue };
            let bytes = self.doc_mut(&id, kind)?.export(ExportMode::all_updates()).map_err(loro_err)?;
            all.push((id, bytes));
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM outbox", [])?;
        for (id, bytes) in &all {
            tx.execute("INSERT INTO outbox(doc_id, bytes, at) VALUES (?1, ?2, ?3)", params![id.as_str(), bytes, now_ms])?;
        }
        tx.commit()?;
        Ok(all.len())
    }

    /// A value of the sync state (`sync_state`: cursor, device id, …).
    pub fn sync_value(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_sync_value(&self, key: &str, value: &[u8]) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO sync_state(key, value) VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    /// Documents written after change number `after` (see `docs.changed`;
    /// -1 for all), with their latest change number.
    pub fn docs_changed_after(&self, after: i64) -> Result<Vec<(DocId, DocKind, i64)>> {
        let mut stmt = self.conn.prepare_cached("SELECT doc_id, kind, changed FROM docs WHERE changed > ?1 ORDER BY changed")?;
        let rows = stmt.query_map([after], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, kind, changed) = row?;
            let Some(kind) = DocKind::parse(&kind) else { continue };
            out.push((DocId::parse(&id)?, kind, changed));
        }
        Ok(out)
    }

    /// The version this device has of a document (encoded version vector).
    pub fn doc_version(&mut self, id: &DocId, kind: DocKind) -> Result<Vec<u8>> {
        Ok(self.doc_mut(id, kind)?.oplog_vv().encode())
    }

    /// The version `device` last reported having of a document (§5.3
    /// compaction); this device's own reports are kept here too.
    pub fn device_ack(&self, id: &DocId, device: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .query_row("SELECT version FROM device_acks WHERE doc_id = ?1 AND device_id = ?2", params![id.as_str(), device], |r| r.get(0))
            .optional()?)
    }

    /// How many documents there is a report of from this device.
    pub fn device_ack_count(&self, device: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM device_acks WHERE device_id = ?1", [device], |r| r.get(0))?)
    }

    pub fn set_device_ack(&self, id: &DocId, device: &str, version: &[u8], at: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO device_acks(doc_id, device_id, version, at) VALUES (?1, ?2, ?3, ?4)",
            params![id.as_str(), device, version, at],
        )?;
        Ok(())
    }

    /// Forgets every report (this device left the workspace).
    pub fn clear_device_acks(&self) -> Result<()> {
        self.conn.execute("DELETE FROM device_acks", [])?;
        Ok(())
    }

    /// Applies an update from another device. False when it brought nothing
    /// new (our own update coming back, or one seen before): then nothing is
    /// stored or reindexed.
    pub fn apply_remote(&mut self, id: &DocId, kind: DocKind, bytes: &[u8], now_ms: i64) -> Result<bool> {
        if self.is_purged(id)? {
            return Ok(false);
        }
        if self.kind_of(id)?.is_some() {
            let doc = self.doc_mut(id, kind)?;
            let before = doc.oplog_vv();
            let status = doc.import(bytes).map_err(loro_err)?;
            // An update waiting for one it depends on is kept too: Loro holds
            // it in memory only, and it must survive a restart.
            if doc.oplog_vv() == before && status.pending.is_none() {
                return Ok(false);
            }
        }
        self.apply_update(id, kind, bytes, Origin::Remote, now_ms)?;
        Ok(true)
    }

    /// Creates a card on this device and returns its id.
    pub fn create_card(&mut self, kind: CardKind, title: &str, now_ms: i64) -> Result<DocId> {
        let id = DocId::new_card();
        let doc = LoroDoc::new();
        doc.set_peer_id(self.peer).map_err(loro_err)?;
        card::init_card(&doc, kind, title, now_ms).map_err(loro_err)?;
        let bytes = doc.export(ExportMode::all_updates()).map_err(loro_err)?;
        self.apply_update(&id, DocKind::Card, &bytes, Origin::Local, now_ms)?;
        Ok(id)
    }

    /// A card for a clipped link, in the inbox (design/inbox-and-tags.md §2):
    /// the page's title, the link and its summary, and the person's note
    /// as the first paragraph when there is one.
    pub fn create_clip(&mut self, title: &str, clip: &card::Clip, note: &str, now_ms: i64) -> Result<DocId> {
        let id = DocId::new_card();
        let doc = LoroDoc::new();
        doc.set_peer_id(self.peer).map_err(loro_err)?;
        card::init_card(&doc, CardKind::Note, title, now_ms).map_err(loro_err)?;
        card::set_clip(&doc, clip, now_ms).map_err(loro_err)?;
        if !note.trim().is_empty() {
            card::append_paragraph(&doc, note.trim()).map_err(loro_err)?;
        }
        let bytes = doc.export(ExportMode::all_updates()).map_err(loro_err)?;
        self.apply_update(&id, DocKind::Card, &bytes, Origin::Local, now_ms)?;
        Ok(id)
    }

    /// Puts a card back in the inbox or takes it out (dealt with).
    pub fn set_inbox(&mut self, id: &DocId, inbox: bool, now_ms: i64) -> Result<()> {
        self.edit(id, DocKind::Card, now_ms, |doc| card::set_inbox(doc, inbox.then_some(now_ms)))
    }

    /// Everything a replica needs to load the document (snapshot form).
    pub fn doc_snapshot(&mut self, id: &DocId) -> Result<Vec<u8>> {
        self.doc_snapshot_if_exists(id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))
    }

    /// Like `doc_snapshot`, but `None` for a document that was never written.
    /// Journal days are only created by their first edit (§5.2a).
    pub fn doc_snapshot_if_exists(&mut self, id: &DocId) -> Result<Option<Vec<u8>>> {
        let Some(kind) = self.kind_of(id)? else { return Ok(None) };
        let doc = self.doc_mut(id, kind)?;
        doc.export(ExportMode::Snapshot).map(Some).map_err(loro_err)
    }

    /// What a replica at version `since` lacks; `None` for a document that
    /// was never written.
    pub fn doc_updates_since(&mut self, id: &DocId, since: &loro::VersionVector) -> Result<Option<Vec<u8>>> {
        let Some(kind) = self.kind_of(id)? else { return Ok(None) };
        let doc = self.doc_mut(id, kind)?;
        doc.export(ExportMode::updates(since)).map(Some).map_err(loro_err)
    }

    /// Moves a card to the trash. Its content stays; restoring brings it back.
    pub fn trash_card(&mut self, id: &DocId, now_ms: i64) -> Result<()> {
        self.edit(id, DocKind::Card, now_ms, |doc| card::set_deleted(doc, Some(now_ms)))
    }

    pub fn restore_card(&mut self, id: &DocId, now_ms: i64) -> Result<()> {
        self.edit(id, DocKind::Card, now_ms, |doc| card::set_deleted(doc, None))
    }

    // ---- deleting for good (§5.4) ----

    /// Deletes cards for good on every device: lists them in the workspace
    /// document's `purged` map, which syncs, and deletes them here. Returns
    /// those deleted. Never a journal day: its id is its date, and a date
    /// deleted for good could never be written again.
    pub fn purge_cards(&mut self, ids: &[DocId], now_ms: i64) -> Result<Vec<DocId>> {
        let ws = DocId::workspace();
        let ids: Vec<&DocId> = ids.iter().filter(|id| **id != ws && !id.is_journal()).collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let write = |doc: &LoroDoc| -> loro::LoroResult<()> {
            let map = doc.get_map(PURGED);
            for id in &ids {
                map.insert(id.as_str(), now_ms)?;
            }
            doc.commit();
            Ok(())
        };
        if self.kind_of(&ws)?.is_some() {
            self.edit(&ws, DocKind::Workspace, now_ms, write)?;
        } else {
            let doc = LoroDoc::new();
            doc.set_peer_id(self.peer).map_err(loro_err)?;
            write(&doc).map_err(loro_err)?;
            let bytes = doc.export(ExportMode::all_updates()).map_err(loro_err)?;
            self.apply_update(&ws, DocKind::Workspace, &bytes, Origin::Local, now_ms)?;
        }
        Ok(self.take_purged())
    }

    /// Cards (not journal days) moved to the trash at or before `cutoff`
    /// (ms): what is deleted for good after a while there.
    pub fn trashed_before(&self, cutoff: i64) -> Result<Vec<DocId>> {
        let mut stmt =
            self.conn.prepare_cached("SELECT card_id FROM idx.cards WHERE deleted_at IS NOT NULL AND deleted_at <= ?1 AND kind != 'journal'")?;
        let ids = stmt.query_map([cutoff], |r| r.get::<_, String>(0))?;
        ids.map(|id| DocId::parse(&id?).map_err(StoreError::from)).collect()
    }

    /// Cards that have been in the trash for `days`, counted from no earlier
    /// than when this device first looked (`trash.cleanupSince`): cards
    /// trashed before the app deleted anything for good were trashed as
    /// "can be restored any time", so they get the full time from then.
    pub fn expired_trash(&mut self, days: i64, now_ms: i64) -> Result<Vec<DocId>> {
        const SINCE: &str = "trash.cleanupSince";
        let since = match self.local_setting(SINCE)?.and_then(|v| v.as_i64()) {
            Some(at) => at,
            None => {
                self.set_local_setting(SINCE, &serde_json::json!(now_ms))?;
                now_ms
            }
        };
        let span = days * 24 * 60 * 60 * 1000;
        if now_ms - since < span {
            return Ok(Vec::new());
        }
        self.trashed_before(now_ms - span)
    }

    /// Documents deleted for good since the last call (here or, through the
    /// workspace document, on another device), for the app to close them.
    pub fn take_purged(&mut self) -> Vec<DocId> {
        std::mem::take(&mut self.purged_now)
    }

    pub fn is_purged(&self, id: &DocId) -> Result<bool> {
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM purged WHERE doc_id = ?1)", [id.as_str()], |r| r.get(0))?)
    }

    /// Deletes here what the workspace document lists as deleted for good
    /// and is not yet: the document, its updates, what waits to be sent,
    /// the reports of it and its index rows. (Local backups keep it until
    /// they are rotated out.)
    fn apply_purges(&mut self, now_ms: i64) -> Result<()> {
        let ws = DocId::workspace();
        if self.kind_of(&ws)?.is_none() {
            return Ok(());
        }
        let listed: Vec<String> = self.doc_mut(&ws, DocKind::Workspace)?.get_map(PURGED).keys().map(|k| k.to_string()).collect();
        if listed.is_empty() {
            return Ok(());
        }
        let known: std::collections::HashSet<String> = {
            let mut stmt = self.conn.prepare_cached("SELECT doc_id FROM purged")?;
            stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?
        };
        let new: Vec<DocId> =
            listed.iter().filter(|id| !known.contains(*id)).filter_map(|id| DocId::parse(id).ok()).filter(|id| *id != ws && !id.is_journal()).collect();
        if new.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for id in &new {
            let id = id.as_str();
            for table in ["docs", "doc_updates", "outbox", "device_acks"] {
                tx.execute(&format!("DELETE FROM {table} WHERE doc_id = ?1"), [id])?;
            }
            for (table, column) in [
                ("cards", "card_id"),
                ("blocks", "card_id"),
                ("fts", "card_id"),
                ("tags", "card_id"),
                ("card_topics", "card_id"),
                ("asset_refs", "doc_id"),
                ("links", "from_card"),
                ("refs", "from_card"),
            ] {
                tx.execute(&format!("DELETE FROM idx.{table} WHERE {column} = ?1"), [id])?;
            }
            tx.execute("INSERT OR IGNORE INTO purged(doc_id, at) VALUES (?1, ?2)", params![id, now_ms])?;
        }
        tx.commit()?;
        for id in &new {
            self.docs.remove(id);
            tracing::info!(doc = %id, "deleted a document for good");
        }
        self.purged_now.extend(new);
        Ok(())
    }

    /// Documents deleted for good that the sync server has not been told of.
    pub fn purges_unsent(&self) -> Result<Vec<DocId>> {
        let mut stmt = self.conn.prepare_cached("SELECT doc_id FROM purged WHERE sent = 0 ORDER BY doc_id")?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?;
        ids.map(|id| DocId::parse(&id?).map_err(StoreError::from)).collect()
    }

    pub fn set_purges_sent(&self, ids: &[DocId], sent: bool) -> Result<()> {
        let mut stmt = self.conn.prepare_cached("UPDATE purged SET sent = ?2 WHERE doc_id = ?1")?;
        for id in ids {
            stmt.execute(params![id.as_str(), sent])?;
        }
        Ok(())
    }

    /// Tells the (next) sync server of every deletion again: a device
    /// joining a workspace, or starting over.
    pub fn resend_purges(&self) -> Result<()> {
        self.conn.execute("UPDATE purged SET sent = 0", [])?;
        Ok(())
    }

    /// Pins a card to the sidebar, or unpins it.
    /// Adds a card to a topic (by id) or takes it out (§4.7). The app does
    /// this in its own replica; this is for the API and tests.
    pub fn set_card_topic(&mut self, id: &DocId, topic: &str, on: bool, now_ms: i64) -> Result<()> {
        self.edit(id, DocKind::Card, now_ms, |doc| if on { card::add_card_topic(doc, topic, now_ms) } else { card::remove_card_topic(doc, topic) })
    }

    pub fn pin_card(&mut self, id: &DocId, pinned: bool, now_ms: i64) -> Result<()> {
        self.edit(id, DocKind::Card, now_ms, |doc| card::set_pinned(doc, pinned.then_some(now_ms)))
    }

    /// Pinned cards not in the trash, in the order they were pinned.
    pub fn pinned_cards(&self) -> Result<Vec<CardRow>> {
        self.query_cards(
            "SELECT card_id, kind, title, preview, created_at, updated_at FROM idx.cards
             WHERE pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at",
            [],
        )
    }

    /// The inbox: clipped links not dealt with yet, newest first.
    pub fn inbox(&self) -> Result<Vec<InboxItem>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT card_id, title, preview, clip, inbox_at, updated_at FROM idx.cards
              WHERE inbox_at IS NOT NULL AND deleted_at IS NULL ORDER BY inbox_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let clip: Option<String> = r.get(3)?;
            Ok(InboxItem {
                id: r.get(0)?,
                title: r.get(1)?,
                preview: r.get(2)?,
                clip: clip.and_then(|c| serde_json::from_str(&c).ok()),
                inbox_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// The cards of a tag's database (design/inbox-and-tags.md §3): cards,
    /// not journal days, with the tag anywhere in them, and their field
    /// values; most recently changed first.
    pub fn tag_cards(&self, tag: &str) -> Result<Vec<TagCard>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT c.card_id, c.title, c.preview, c.created_at, c.updated_at, c.props, c.clip FROM idx.cards c
              WHERE c.deleted_at IS NULL AND c.kind != 'journal'
                AND c.card_id IN (SELECT card_id FROM idx.tags WHERE tag = ?1)
              ORDER BY c.updated_at DESC",
        )?;
        let rows = stmt.query_map([tag_key(tag)], |r| {
            let clip: Option<String> = r.get(6)?;
            Ok(TagCard {
                id: r.get(0)?,
                title: r.get(1)?,
                preview: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                props: r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "{}".into()),
                url: clip.and_then(|c| serde_json::from_str::<folio_core::card::Clip>(&c).ok()).map(|c| c.url),
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Cards in the trash, most recently trashed first.
    pub fn list_trash(&self, limit: u32) -> Result<Vec<CardRow>> {
        self.query_cards(
            "SELECT card_id, kind, title, preview, created_at, updated_at FROM idx.cards
             WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?1",
            params![limit],
        )
    }

    /// Journal days between two dates (inclusive, `YYYY-MM-DD`) that have a
    /// document, newest first, with their text for read-only display.
    pub fn journal_days(&self, from: &str, to: &str) -> Result<Vec<JournalDay>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT card_id, text, updated_at FROM idx.cards
             WHERE card_id BETWEEN ?1 AND ?2 AND kind = 'journal' AND deleted_at IS NULL ORDER BY card_id DESC",
        )?;
        let rows = stmt.query_map(params![format!("journal:{from}"), format!("journal:{to}")], |r| {
            let id: String = r.get(0)?;
            Ok(JournalDay { date: id.trim_start_matches("journal:").to_owned(), id, text: r.get(1)?, updated_at: r.get(2)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn card_summary(&mut self, id: &DocId) -> Result<CardSummary> {
        let doc = self.doc_mut(id, DocKind::Card)?;
        Ok(card::summarize(doc))
    }

    /// The card library, most recently changed first, without deleted cards
    /// and without journal days (they live in the journal).
    pub fn list_cards(&self, limit: u32) -> Result<Vec<CardRow>> {
        self.query_cards(
            "SELECT card_id, kind, title, preview, created_at, updated_at FROM idx.cards
             WHERE deleted_at IS NULL AND kind != 'journal' ORDER BY updated_at DESC LIMIT ?1",
            params![limit],
        )
    }

    /// Every card not in the trash, journal days included (export, MCP).
    pub fn live_cards(&self) -> Result<Vec<CardRow>> {
        self.query_cards(
            "SELECT card_id, kind, title, preview, created_at, updated_at FROM idx.cards
             WHERE deleted_at IS NULL ORDER BY kind, updated_at DESC",
            [],
        )
    }

    /// A copy of a document to read from without touching the store's replica.
    pub fn doc_copy(&mut self, id: &DocId) -> Result<LoroDoc> {
        let kind = self.kind_of(id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;
        Ok(self.doc_mut(id, kind)?.fork())
    }

    /// The current text of every indexed block, by id (block references in
    /// exports).
    pub fn all_block_texts(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT bid, text FROM idx.blocks")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn query_cards(&self, sql: &str, args: impl rusqlite::Params) -> Result<Vec<CardRow>> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let rows = stmt.query_map(args, |r| {
            Ok(CardRow { id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, preview: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Drops and rebuilds `index.db` from `store.db` (§3.1 invariant 5).
    pub fn rebuild_index(&mut self) -> Result<()> {
        self.conn.execute("DELETE FROM idx.cards", [])?;
        let rows: Vec<(String, i64)> = {
            let mut stmt = self.conn.prepare("SELECT doc_id, updated_at FROM docs WHERE kind = 'card'")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?
        };
        for (id, updated_at) in rows {
            self.reindex_card(&DocId::parse(&id)?, updated_at)?;
        }
        Ok(())
    }

    // ---- links, references and search (§8 M2) ----

    /// Blocks in other cards that link to this card or reference one of its
    /// blocks, most recently edited cards first.
    pub fn backlinks(&self, card: &DocId) -> Result<Vec<Backlink>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT * FROM (
               SELECT l.from_card, c.title, c.kind, l.from_bid, COALESCE(b.text, ''), 'link', c.updated_at
                 FROM idx.links l JOIN idx.cards c ON c.card_id = l.from_card
                 LEFT JOIN idx.blocks b ON b.card_id = l.from_card AND b.bid = l.from_bid
                WHERE l.to_card = ?1 AND l.from_card != ?1 AND c.deleted_at IS NULL
               UNION
               SELECT r.from_card, c.title, c.kind, r.from_bid, COALESCE(b.text, ''), 'ref', c.updated_at
                 FROM idx.refs r JOIN idx.blocks t ON t.bid = r.to_bid AND t.card_id = ?1
                 JOIN idx.cards c ON c.card_id = r.from_card
                 LEFT JOIN idx.blocks b ON b.card_id = r.from_card AND b.bid = r.from_bid
                WHERE r.from_card != ?1 AND c.deleted_at IS NULL
             ) ORDER BY 7 DESC, 1, 4",
        )?;
        let rows = stmt.query_map([card.as_str()], backlink_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Blocks in other cards whose text contains this card's title but that
    /// do not link to it (Logseq's and Heptabase's unlinked references).
    pub fn unlinked_references(&self, card: &DocId, limit: u32) -> Result<Vec<Backlink>> {
        let title: Option<String> =
            self.conn.query_row("SELECT title FROM idx.cards WHERE card_id = ?1", [card.as_str()], |r| r.get(0)).optional()?;
        let title = title.unwrap_or_default();
        let title = title.trim();
        if title.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let not_linked = "AND NOT EXISTS (SELECT 1 FROM idx.links l WHERE l.from_card = x.card_id AND l.from_bid = x.bid AND l.to_card = ?2)";
        let sql = if fts_ok(title) {
            format!(
                "SELECT x.card_id, c.title, c.kind, x.bid, x.text, 'mention', c.updated_at
                   FROM idx.fts x JOIN idx.cards c ON c.card_id = x.card_id
                  WHERE fts MATCH ?1 AND x.bid != '' AND x.card_id != ?2 AND c.deleted_at IS NULL {not_linked}
                  ORDER BY c.updated_at DESC LIMIT ?3"
            )
        } else {
            format!(
                "SELECT x.card_id, c.title, c.kind, x.bid, x.text, 'mention', c.updated_at
                   FROM idx.blocks x JOIN idx.cards c ON c.card_id = x.card_id
                  WHERE x.text LIKE ?1 ESCAPE '\\' AND x.card_id != ?2 AND c.deleted_at IS NULL {not_linked}
                  ORDER BY c.updated_at DESC LIMIT ?3"
            )
        };
        let pattern = if fts_ok(title) { fts_phrase(title) } else { like(title) };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pattern, card.as_str(), limit], backlink_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Cards by title and blocks by text; title matches first. Three or more
    /// characters use the full-text index, shorter queries a substring scan
    /// (trigram cannot match them; two-character Chinese words are common).
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
        // Every word must appear, as people expect, not the words as a phrase.
        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let row = |r: &rusqlite::Row| Ok(SearchHit { card_id: r.get(0)?, card_title: r.get(1)?, card_kind: r.get(2)?, bid: r.get(3)?, text: r.get(4)? });
        if terms.iter().all(|t| fts_ok(t)) {
            // FTS5: phrases separated by spaces are ANDed.
            let pattern = terms.iter().map(|t| fts_phrase(t)).collect::<Vec<_>>().join(" ");
            let mut stmt = self.conn.prepare_cached(
                "SELECT x.card_id, c.title, c.kind, NULLIF(x.bid, ''), x.text
                   FROM idx.fts x JOIN idx.cards c ON c.card_id = x.card_id
                  WHERE fts MATCH ?1 AND c.deleted_at IS NULL
                  ORDER BY x.bid = '' DESC, bm25(fts), c.updated_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![pattern, limit], row)?;
            return Ok(rows.collect::<std::result::Result<_, _>>()?);
        }
        // A word too short for the trigram index (two Chinese characters):
        // LIKE for every word.
        let all = |column: &str| (0..terms.len()).map(|i| format!("{column} LIKE ?{} ESCAPE '\\'", i + 1)).collect::<Vec<_>>().join(" AND ");
        let sql = format!(
            "SELECT * FROM (
               SELECT card_id, title, kind, NULL, title, 0 AS rank, updated_at FROM idx.cards
                WHERE {} AND deleted_at IS NULL
               UNION ALL
               SELECT b.card_id, c.title, c.kind, b.bid, b.text, 1, c.updated_at
                 FROM idx.blocks b JOIN idx.cards c ON c.card_id = b.card_id
                WHERE {} AND c.deleted_at IS NULL
             ) ORDER BY rank, updated_at DESC LIMIT ?{}",
            all("(title || char(10) || ifnull(clip_text, ''))"),
            all("b.text"),
            terms.len() + 1
        );
        let mut args: Vec<rusqlite::types::Value> = terms.iter().map(|t| like(t).into()).collect();
        args.push((limit as i64).into());
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Tags in use, most recently used first: name as most recently written,
    /// how many blocks have it, and in how many cards.
    pub fn tags(&self, limit: u32) -> Result<Vec<TagInfo>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.tag, count(*), count(DISTINCT t.card_id), max(c.updated_at),
                    (SELECT t2.name FROM idx.tags t2 JOIN idx.cards c2 ON c2.card_id = t2.card_id
                      WHERE t2.tag = t.tag ORDER BY c2.updated_at DESC LIMIT 1)
               FROM idx.tags t JOIN idx.cards c ON c.card_id = t.card_id
              WHERE c.deleted_at IS NULL
              GROUP BY t.tag ORDER BY max(c.updated_at) DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(TagInfo { key: r.get(0)?, blocks: r.get(1)?, cards: r.get(2)?, last_used: r.get(3)?, name: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Cards in a topic (§4.7), most recently changed first.
    pub fn topic_cards(&self, topic: &str) -> Result<Vec<CardRow>> {
        self.query_cards(
            "SELECT c.card_id, c.kind, c.title, c.preview, c.created_at, c.updated_at FROM idx.card_topics t
               JOIN idx.cards c ON c.card_id = t.card_id
              WHERE t.topic = ?1 AND c.deleted_at IS NULL ORDER BY c.updated_at DESC",
            params![topic],
        )
    }

    /// Titles and body text of cards, trashed ones too (a whiteboard shows
    /// them as in the trash).
    pub fn card_texts(&self, ids: &[String]) -> Result<Vec<CardText>> {
        let mut stmt = self.conn.prepare_cached("SELECT card_id, title, text, deleted_at IS NOT NULL FROM idx.cards WHERE card_id = ?1")?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = stmt
                .query_row([id], |r| Ok(CardText { id: r.get(0)?, title: r.get(1)?, text: r.get::<_, Option<String>>(2)?.unwrap_or_default(), deleted: r.get(3)? }))
                .optional()?
            {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// Every (card, topic) pair of cards not in the trash: the card library
    /// groups cards by topic and finds the ones in none.
    pub fn card_topic_pairs(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.card_id, t.topic FROM idx.card_topics t JOIN idx.cards c ON c.card_id = t.card_id WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// How many cards (not in the trash) each topic has, by topic id.
    pub fn topic_counts(&self) -> Result<Vec<TopicCount>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.topic, count(*) FROM idx.card_topics t JOIN idx.cards c ON c.card_id = t.card_id
              WHERE c.deleted_at IS NULL GROUP BY t.topic",
        )?;
        let rows = stmt.query_map([], |r| Ok(TopicCount { id: r.get(0)?, cards: r.get(1)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Blocks with a tag (any case), newest cards first.
    pub fn tagged(&self, tag: &str, limit: u32) -> Result<Vec<Backlink>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT b.card_id, c.title, c.kind, b.bid, b.text, 'tag', c.updated_at
               FROM idx.tags t
               JOIN idx.blocks b ON b.card_id = t.card_id AND b.bid = t.bid
               JOIN idx.cards c ON c.card_id = t.card_id
              WHERE t.tag = ?1 AND c.deleted_at IS NULL
              GROUP BY b.card_id, b.bid
              ORDER BY c.updated_at DESC, b.ord LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![tag_key(tag), limit], backlink_row)?;
        let mut rows: Vec<Backlink> = rows.collect::<std::result::Result<_, _>>()?;
        for row in &mut rows {
            row.children = self.child_blocks(&row.card_id, &row.bid)?;
        }
        Ok(rows)
    }

    /// The blocks nested under a block, in document order: blocks of a card
    /// are indexed in document order, so their rowids are too.
    fn child_blocks(&self, card_id: &str, bid: &str) -> Result<Vec<ChildBlock>> {
        let mut stmt = self.conn.prepare_cached(
            "WITH RECURSIVE sub(bid, depth) AS (
               SELECT bid, 1 FROM idx.blocks WHERE card_id = ?1 AND parent_bid = ?2
               UNION ALL
               SELECT b.bid, s.depth + 1 FROM idx.blocks b JOIN sub s ON b.card_id = ?1 AND b.parent_bid = s.bid
             )
             SELECT b.bid, s.depth, b.text FROM sub s JOIN idx.blocks b ON b.card_id = ?1 AND b.bid = s.bid
              ORDER BY b.rowid LIMIT 200",
        )?;
        let rows = stmt.query_map(params![card_id, bid], |r| Ok(ChildBlock { bid: r.get(0)?, depth: r.get(1)?, text: r.get(2)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// The current text of blocks, by id (for block references). A block in
    /// a trashed card is still found: the reference shows it, greyed out.
    pub fn block_texts(&self, bids: &[String]) -> Result<Vec<BlockText>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT b.bid, b.card_id, b.text FROM idx.blocks b JOIN idx.cards c ON c.card_id = b.card_id
              WHERE b.bid = ?1 ORDER BY c.deleted_at IS NOT NULL LIMIT 1",
        )?;
        let mut out = Vec::new();
        for bid in bids {
            if let Some(row) = stmt
                .query_row([bid], |r| Ok(BlockText { bid: r.get(0)?, card_id: r.get(1)?, text: r.get(2)? }))
                .optional()?
            {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// Current titles of cards (card links show them, so renames follow).
    pub fn titles(&self, ids: &[String]) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare_cached("SELECT card_id, title FROM idx.cards WHERE card_id = ?1")?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = stmt.query_row([id], |r| Ok((r.get(0)?, r.get(1)?))).optional()? {
                out.push(row);
            }
        }
        Ok(out)
    }

    // ---- device-local settings (§4.1: never synced) ----

    pub fn local_setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let raw: Option<String> =
            self.conn.query_row("SELECT value FROM local_settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        Ok(match raw {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    pub fn set_local_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO local_settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    // ---- internals ----

    /// Moves every card body from layout 1 to layout 2 (movable children,
    /// `folio_core::card::migrate_body`), once per database. Each migration is
    /// stored as a local update; `updated_at` is left alone so the library
    /// order does not change. Returns how many documents were migrated.
    /// Moves card bodies to the current layout once per library: layout 1
    /// → 2 → 3 (blocks in a LoroTree, §4.5 rule 4).
    fn migrate_bodies(&mut self) -> Result<usize> {
        // ".1": the first layout-3 migration skipped cards an editor had
        // already written into (see body::migrate_to_tree); run it again.
        const DONE: &str = "migration.body_layout_3.1";
        let done: Option<Vec<u8>> =
            self.conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [DONE], |r| r.get(0)).optional()?;
        if done.is_some() {
            return Ok(0);
        }
        let rows: Vec<(String, i64)> = {
            let mut stmt = self.conn.prepare("SELECT doc_id, updated_at FROM docs WHERE kind = 'card'")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?
        };
        // A copy of the library as it was, before anything is rewritten.
        if !rows.is_empty() {
            self.backup_before_upgrade(&backup::backups_dir(&self.dir), now_ms())?;
        }
        let mut migrated = 0;
        for (id, updated_at) in rows {
            let id = DocId::parse(&id)?;
            let doc = self.doc_mut(&id, DocKind::Card)?;
            let before = doc.oplog_vv();
            let to_2 = card::migrate_body(doc).map_err(loro_err)?;
            let to_3 = folio_core::body::migrate_to_tree(doc).map_err(loro_err)?;
            if !to_2 && !to_3 {
                continue;
            }
            let bytes = doc.export(ExportMode::updates(&before)).map_err(loro_err)?;
            self.apply_update(&id, DocKind::Card, &bytes, Origin::Local, updated_at)?;
            migrated += 1;
        }
        self.conn.execute("INSERT OR REPLACE INTO sync_state(key, value) VALUES (?1, ?2)", params![DONE, vec![1u8]])?;
        if migrated > 0 {
            tracing::info!(documents = migrated, "migrated card bodies to layout 3");
        }
        Ok(migrated)
    }

    /// Runs an edit on the Rust replica and stores the resulting update like
    /// any other local change.
    fn edit(&mut self, id: &DocId, kind: DocKind, now_ms: i64, f: impl FnOnce(&LoroDoc) -> loro::LoroResult<()>) -> Result<()> {
        if self.kind_of(id)?.is_none() {
            return Err(StoreError::NotFound(id.to_string()));
        }
        let doc = self.doc_mut(id, kind)?;
        let before = doc.oplog_vv();
        f(doc).map_err(loro_err)?;
        let bytes = doc.export(ExportMode::updates(&before)).map_err(loro_err)?;
        // Importing our own update again is a no-op; this keeps one write path.
        self.apply_update(id, kind, &bytes, Origin::Local, now_ms)
    }

    fn kind_of(&self, id: &DocId) -> Result<Option<DocKind>> {
        let kind: Option<String> =
            self.conn.query_row("SELECT kind FROM docs WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
        Ok(kind.and_then(|k| DocKind::parse(&k)))
    }

    /// The cached replica, loaded from snapshot + update log on first use.
    fn doc_mut(&mut self, id: &DocId, kind: DocKind) -> Result<&mut LoroDoc> {
        if !self.docs.contains_key(id) {
            let doc = LoroDoc::new();
            doc.set_peer_id(self.peer).map_err(loro_err)?;
            let snapshot: Option<Option<Vec<u8>>> =
                self.conn.query_row("SELECT snapshot FROM docs WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
            if let Some(Some(s)) = snapshot {
                doc.import(&s).map_err(loro_err)?;
            }
            let mut stmt = self.conn.prepare_cached("SELECT bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY id")?;
            let updates = stmt.query_map([id.as_str()], |r| r.get::<_, Vec<u8>>(0))?;
            for u in updates {
                doc.import(&u?).map_err(loro_err)?;
            }
            tracing::debug!(doc = %id, kind = kind.as_str(), "loaded document");
            self.docs.insert(id.clone(), doc);
        }
        Ok(self.docs.get_mut(id).expect("inserted above"))
    }

    fn reindex_card(&mut self, id: &DocId, updated_at: i64) -> Result<()> {
        let s = card::summarize(self.doc_mut(id, DocKind::Card)?);
        self.conn.execute(
            "INSERT INTO idx.cards(card_id, kind, title, preview, text, created_at, updated_at, deleted_at, pinned_at,
                                   inbox_at, clip, clip_text, props)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(card_id) DO UPDATE SET kind = excluded.kind, title = excluded.title, preview = excluded.preview,
               text = excluded.text, created_at = excluded.created_at, updated_at = excluded.updated_at,
               deleted_at = excluded.deleted_at, pinned_at = excluded.pinned_at, inbox_at = excluded.inbox_at,
               clip = excluded.clip, clip_text = excluded.clip_text, props = excluded.props",
            params![
                id.as_str(),
                s.kind,
                s.title,
                s.preview,
                s.text,
                s.created_at,
                updated_at,
                s.deleted_at,
                s.pinned_at,
                s.inbox_at,
                s.clip.as_ref().map(|c| serde_json::to_string(c).expect("plain struct")),
                clip_text(&s),
                s.props
            ],
        )?;
        let x = folio_core::index::extract(self.doc_mut(id, DocKind::Card)?);
        let topics = card::card_topics(self.doc_mut(id, DocKind::Card)?);
        let tx = self.conn.unchecked_transaction()?;
        for table in ["blocks", "links", "refs", "fts", "tags", "card_topics", "asset_refs"] {
            let column = match table {
                "blocks" | "fts" | "tags" | "card_topics" => "card_id",
                "asset_refs" => "doc_id",
                _ => "from_card",
            };
            tx.execute(&format!("DELETE FROM idx.{table} WHERE {column} = ?1"), [id.as_str()])?;
        }
        tx.execute("INSERT INTO idx.fts(card_id, bid, text) VALUES (?1, '', ?2)", params![id.as_str(), s.title])?;
        // A clipped link is found by its site and summary too, as a title is.
        if let Some(extra) = clip_text(&s) {
            tx.execute("INSERT INTO idx.fts(card_id, bid, text) VALUES (?1, '', ?2)", params![id.as_str(), extra])?;
        }
        for b in &x.blocks {
            tx.execute(
                "INSERT OR REPLACE INTO idx.blocks(bid, card_id, parent_bid, ord, text, type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![b.bid, id.as_str(), b.parent, b.ord, b.text, b.kind],
            )?;
            if !b.text.is_empty() {
                tx.execute("INSERT INTO idx.fts(card_id, bid, text) VALUES (?1, ?2, ?3)", params![id.as_str(), b.bid, b.text])?;
            }
        }
        for (from, to) in &x.links {
            tx.execute("INSERT INTO idx.links(from_card, from_bid, to_card) VALUES (?1, ?2, ?3)", params![id.as_str(), from, to])?;
        }
        for (from, to) in &x.refs {
            tx.execute("INSERT INTO idx.refs(from_card, from_bid, to_bid) VALUES (?1, ?2, ?3)", params![id.as_str(), from, to])?;
        }
        for (bid, name) in &x.tags {
            tx.execute(
                "INSERT INTO idx.tags(card_id, bid, tag, name) VALUES (?1, ?2, ?3, ?4)",
                params![id.as_str(), bid, tag_key(name), name],
            )?;
        }
        for topic in &topics {
            tx.execute("INSERT INTO idx.card_topics(card_id, topic) VALUES (?1, ?2)", params![id.as_str(), topic])?;
        }
        for a in &x.assets {
            tx.execute("INSERT OR IGNORE INTO idx.asset_refs(sha256, doc_id, mime) VALUES (?1, ?2, ?3)", params![a.sha256, id.as_str(), a.mime])?;
        }
        tx.commit()?;
        Ok(())
    }

    fn index_is_empty(&self) -> Result<bool> {
        let docs: i64 = self.conn.query_row("SELECT count(*) FROM docs WHERE kind = 'card'", [], |r| r.get(0))?;
        let indexed: i64 = self.conn.query_row("SELECT count(*) FROM idx.cards", [], |r| r.get(0))?;
        Ok(docs > 0 && indexed == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_deleted_for_good_is_gone_everywhere_and_stays_gone() {
        let (a_dir, b_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut a = Store::open(a_dir.path()).unwrap();
        let mut b = Store::open(b_dir.path()).unwrap();
        let gone = a.create_card(CardKind::Note, "旧笔记", 1).unwrap();
        let kept = a.create_card(CardKind::Note, "留着", 2).unwrap();
        for id in [&gone, &kept] {
            b.apply_remote(id, DocKind::Card, &a.doc_snapshot(id).unwrap(), 3).unwrap();
        }
        a.trash_card(&gone, 10).unwrap();
        assert_eq!(a.trashed_before(10).unwrap(), vec![gone.clone()]);
        assert!(a.trashed_before(9).unwrap().is_empty());
        let edit_from_b = {
            let doc = b.doc_copy(&gone).unwrap();
            let v = doc.oplog_vv();
            folio_core::card::append_paragraph(&doc, "离线时写的").unwrap();
            doc.export(ExportMode::updates(&v)).unwrap()
        };
        a.outbox_ack(&a.outbox_batch(100).unwrap().iter().map(|o| o.id).collect::<Vec<_>>()).unwrap();

        let day = DocId::journal(2026, 10, 1).unwrap();
        let snapshot = a.doc_snapshot(&gone).unwrap();
        a.apply_update(&day, DocKind::Card, &snapshot, Origin::Local, 11).unwrap();
        assert_eq!(a.purge_cards(&[gone.clone(), day.clone()], 20).unwrap(), vec![gone.clone()], "never a journal day");
        assert!(!a.is_purged(&day).unwrap());
        assert!(a.doc_snapshot_if_exists(&gone).unwrap().is_none());
        let trash: Vec<String> = a.list_trash(10).unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(trash, vec![day.to_string()], "the journal day stays in the trash");
        assert!(a.search("旧笔记", 10).unwrap().is_empty());
        assert_eq!(a.list_cards(10).unwrap().len(), 1);
        assert_eq!(a.purges_unsent().unwrap(), vec![gone.clone()]);
        // Nothing of it is left to send; the workspace document listing it is.
        let outbox = a.outbox_batch(100).unwrap();
        assert!(outbox.iter().all(|o| o.doc != gone) && outbox.iter().any(|o| o.doc == DocId::workspace()));
        // An update made elsewhere before the deletion arrived is dropped,
        // and so is one from an editor still open here.
        assert!(!a.apply_remote(&gone, DocKind::Card, &edit_from_b, 21).unwrap());
        a.apply_update(&gone, DocKind::Card, &edit_from_b, Origin::Local, 22).unwrap();
        assert!(a.doc_snapshot_if_exists(&gone).unwrap().is_none());

        // The other device deletes it when the workspace document arrives.
        for o in &outbox {
            b.apply_remote(&o.doc, o.kind, &o.bytes, 30).unwrap();
        }
        assert_eq!(b.take_purged(), vec![gone.clone()]);
        assert!(b.doc_snapshot_if_exists(&gone).unwrap().is_none());
        assert_eq!(b.card_summary(&kept).unwrap().title, "留着");
        assert!(!b.outbox_docs().unwrap().contains(&gone), "nothing of it is sent");
        // And it stays deleted after a restart.
        drop(a);
        let mut a = Store::open(a_dir.path()).unwrap();
        assert!(a.take_purged().is_empty());
        assert!(!a.apply_remote(&gone, DocKind::Card, &edit_from_b, 40).unwrap());
    }

    #[test]
    fn cards_trashed_before_the_cleanup_existed_get_the_full_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let day = 24 * 60 * 60 * 1000;
        let old = s.create_card(CardKind::Note, "早就在回收站", 1).unwrap();
        s.trash_card(&old, 1).unwrap();
        let start = 100 * day;
        assert!(s.expired_trash(30, start).unwrap().is_empty(), "the first look only starts the clock");
        let new = s.create_card(CardKind::Note, "后来放进去", start).unwrap();
        s.trash_card(&new, start + day).unwrap();
        assert!(s.expired_trash(30, start + 29 * day).unwrap().is_empty());
        assert_eq!(s.expired_trash(30, start + 30 * day).unwrap(), vec![old.clone()]);
        assert_eq!(s.expired_trash(30, start + 31 * day).unwrap().len(), 2);
    }

    #[test]
    fn a_library_from_before_deleting_for_good_catches_up_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let gone = {
            let mut s = Store::open(dir.path()).unwrap();
            let gone = s.create_card(CardKind::Note, "x", 1).unwrap();
            s.purge_cards(&[gone.clone()], 2).unwrap();
            // As an older app would have left it: listed, but still here.
            s.conn.execute("DELETE FROM purged", []).unwrap();
            s.create_card(CardKind::Note, "y", 3).unwrap();
            s.conn.execute("INSERT INTO docs(doc_id, kind, snapshot, updated_at) VALUES (?1, 'card', NULL, 1)", [gone.as_str()]).unwrap();
            gone
        };
        let mut s = Store::open(dir.path()).unwrap();
        assert_eq!(s.take_purged(), vec![gone.clone()]);
        assert!(s.doc_snapshot_if_exists(&gone).unwrap().is_none());
    }

    #[test]
    fn create_list_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let mut s = Store::open(dir.path()).unwrap();
            let id = s.create_card(CardKind::Note, "第一张卡片", 10).unwrap();
            s.create_card(CardKind::Note, "Second card", 20).unwrap();
            let titles: Vec<_> = s.list_cards(10).unwrap().into_iter().map(|c| c.title).collect();
            assert_eq!(titles, vec!["Second card", "第一张卡片"]);
            id
        };
        // Everything comes back from disk, including the index.
        let mut s = Store::open(dir.path()).unwrap();
        assert_eq!(s.list_cards(10).unwrap().len(), 2);
        assert_eq!(s.card_summary(&id).unwrap().title, "第一张卡片");
    }

    #[test]
    fn remote_update_is_applied_and_indexed_but_not_queued() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let id = s.create_card(CardKind::Note, "共享", 1).unwrap();
        // Another device edits the card.
        let other = LoroDoc::new();
        other.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let v = other.oplog_vv();
        folio_core::card::append_paragraph(&other, "来自另一台设备").unwrap();
        let update = other.export(ExportMode::updates(&v)).unwrap();
        s.apply_update(&id, DocKind::Card, &update, Origin::Remote, 2).unwrap();
        assert_eq!(s.card_summary(&id).unwrap().text, "来自另一台设备");
        let outbox: i64 = s.conn.query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(outbox, 1, "only the local creation is queued for upload");
    }

    #[test]
    fn change_counter_migration_backs_up_and_counts_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = {
            let mut s = Store::open(dir.path()).unwrap();
            let a = s.create_card(CardKind::Note, "A", 1).unwrap();
            let b = s.create_card(CardKind::Note, "B", 2).unwrap();
            // Back to layout 1, as a library from before the counter and
            // before files had an unused mark.
            s.conn
                .execute_batch(
                    "DROP INDEX docs_by_changed; ALTER TABLE docs DROP COLUMN changed;
                     ALTER TABLE assets DROP COLUMN orphan_since; DROP TABLE purged;
                     INSERT INTO assets(sha256, mime, size, local) VALUES ('kept', 'image/png', 3, 1);
                     PRAGMA user_version = 1;",
                )
                .unwrap();
            (a, b)
        };
        let mut s = Store::open(dir.path()).unwrap();
        let kept: (String, i64, Option<i64>) =
            s.conn.query_row("SELECT mime, size, orphan_since FROM assets WHERE sha256 = 'kept'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(kept, ("image/png".to_owned(), 3, None), "rows are kept through migration 3");
        let backups = backup::list_backups(&backup::backups_dir(dir.path())).unwrap();
        assert_eq!(backups.iter().filter(|b| b.reason.as_deref() == Some("upgrade")).count(), 1);
        let ids = |s: &Store, after| s.docs_changed_after(after).unwrap().into_iter().map(|(id, _, n)| (id, n)).collect::<Vec<_>>();
        assert_eq!(ids(&s, -1).len(), 2, "existing documents start at 0");
        assert!(ids(&s, 0).is_empty());
        // Clocks may go back; the counter does not.
        s.trash_card(&b, 0).unwrap();
        s.trash_card(&a, -5).unwrap();
        assert_eq!(ids(&s, 0), vec![(b.clone(), 1), (a.clone(), 2)]);
        assert_eq!(ids(&s, 1), vec![(a, 2)]);
        // Opening again migrates nothing and backs up nothing more.
        drop(s);
        Store::open(dir.path()).unwrap();
        assert_eq!(backup::list_backups(&backup::backups_dir(dir.path())).unwrap().len(), backups.len());
    }

    #[test]
    fn index_rebuilds_after_index_db_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut s = Store::open(dir.path()).unwrap();
            s.create_card(CardKind::Note, "索引可重建", 1).unwrap();
        }
        std::fs::remove_file(dir.path().join("index.db")).unwrap();
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.list_cards(10).unwrap()[0].title, "索引可重建");
    }

    #[test]
    fn peers_are_stable_and_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let (rust, front) = {
            let s = Store::open(dir.path()).unwrap();
            (s.peer, s.frontend_peer().unwrap())
        };
        let s = Store::open(dir.path()).unwrap();
        assert_ne!(rust, front);
        assert_ne!(s.api_peer().unwrap(), front);
        assert_eq!(s.peer, rust);
        assert_eq!(s.frontend_peer().unwrap(), front);
    }

    #[test]
    fn local_settings_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.local_setting("ui.locale").unwrap(), None);
        s.set_local_setting("ui.locale", &serde_json::json!("en")).unwrap();
        assert_eq!(s.local_setting("ui.locale").unwrap(), Some(serde_json::json!("en")));
    }

    #[test]
    fn trash_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let id = s.create_card(CardKind::Note, "要删的", 1).unwrap();
        s.trash_card(&id, 2).unwrap();
        assert!(s.list_cards(10).unwrap().is_empty());
        assert_eq!(s.list_trash(10).unwrap()[0].id, id.as_str());
        s.restore_card(&id, 3).unwrap();
        assert_eq!(s.list_cards(10).unwrap().len(), 1);
        assert!(s.list_trash(10).unwrap().is_empty());
        // The trash marker is a document edit, so it survives a restart.
        s.trash_card(&id, 4).unwrap();
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.list_trash(10).unwrap().len(), 1);
    }

    #[test]
    fn pinned_cards_in_pin_order_without_trashed_ones() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let a = s.create_card(CardKind::Note, "a", 1).unwrap();
        let b = s.create_card(CardKind::Note, "b", 1).unwrap();
        s.pin_card(&b, true, 2).unwrap();
        s.pin_card(&a, true, 3).unwrap();
        let ids = |s: &Store| s.pinned_cards().unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(ids(&s), [b.to_string(), a.to_string()]);
        s.trash_card(&b, 4).unwrap();
        assert_eq!(ids(&s), [a.to_string()]);
        s.pin_card(&a, false, 5).unwrap();
        assert!(ids(&s).is_empty());
    }

    #[test]
    fn journal_day_is_created_by_its_first_update() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let id = DocId::journal(2026, 10, 23).unwrap();
        assert_eq!(s.doc_snapshot_if_exists(&id).unwrap(), None);
        // The frontend starts the day and writes the first line.
        let doc = LoroDoc::new();
        card::init_card(&doc, CardKind::Journal, "", 1).unwrap();
        card::append_paragraph(&doc, "今天").unwrap();
        s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::all_updates()).unwrap(), Origin::Local, 5).unwrap();
        assert!(s.doc_snapshot_if_exists(&id).unwrap().is_some());
        let days = s.journal_days("2026-10-01", "2026-10-31").unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!((days[0].date.as_str(), days[0].text.as_str()), ("2026-10-23", "今天"));
        assert!(s.list_cards(10).unwrap().is_empty(), "journal days stay out of the card library");
    }

    #[test]
    fn outdated_index_is_recreated() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut s = Store::open(dir.path()).unwrap();
            s.create_card(CardKind::Note, "旧索引", 1).unwrap();
            s.conn.execute_batch("PRAGMA idx.user_version = 1").unwrap();
        }
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.list_cards(10).unwrap()[0].title, "旧索引");
    }

    /// A card written by an older build (layout 1: `doc` root, plain lists,
    /// a bold mark) is moved to layout 2 on open with everything intact.
    #[test]
    fn layout_1_bodies_are_migrated_on_open() {
        use loro::{LoroList, LoroMap, LoroText};
        let dir = tempfile::tempdir().unwrap();
        let id = DocId::new_card();
        {
            let mut s = Store::open(dir.path()).unwrap();
            let doc = LoroDoc::new();
            let meta = doc.get_map("meta");
            meta.insert("kind", "note").unwrap();
            meta.insert("title", "旧卡片").unwrap();
            let root = doc.get_map("doc");
            root.insert("nodeName", "doc").unwrap();
            root.ensure_mergeable_map("attributes").unwrap();
            let children = root.ensure_mergeable_list("children").unwrap();
            let list = children.insert_container(0, LoroMap::new()).unwrap();
            list.insert("nodeName", "bulletList").unwrap();
            #[allow(deprecated)]
            let items = list.get_or_create_container("children", LoroList::new()).unwrap();
            let item = items.insert_container(0, LoroMap::new()).unwrap();
            item.insert("nodeName", "listItem").unwrap();
            #[allow(deprecated)]
            item.get_or_create_container("attributes", LoroMap::new()).unwrap().insert("bid", "item-1").unwrap();
            #[allow(deprecated)]
            let p = item.get_or_create_container("children", LoroList::new()).unwrap().insert_container(0, LoroMap::new()).unwrap();
            p.insert("nodeName", "paragraph").unwrap();
            #[allow(deprecated)]
            let t = p.get_or_create_container("children", LoroList::new()).unwrap().insert_container(0, LoroText::new()).unwrap();
            t.insert(0, "粗体 and plain").unwrap();
            doc.config_default_text_style(Some(loro::StyleConfig { expand: loro::ExpandType::After }));
            t.mark(0..2, "bold", true).unwrap();
            doc.commit();
            s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::all_updates()).unwrap(), Origin::Import, 42).unwrap();
            // Pretend this database predates the migration.
            s.conn.execute("DELETE FROM sync_state WHERE key = 'migration.body_layout_3.1'", []).unwrap();
        }
        let mut s = Store::open(dir.path()).unwrap();
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        assert!(doc.get_map("doc").is_empty(), "the layout-1 root is emptied");
        assert!(doc.get_map("body").is_empty(), "the layout-2 root is emptied");
        // Layout 3: bulletList > listItem > paragraph in the block tree.
        let tree = folio_core::body::tree(&doc);
        let kids = |parent: Option<loro::TreeID>| tree.children(loro::TreeParentId::from(parent)).unwrap();
        let name = |id| tree.get_meta(id).unwrap().get("nodeName").unwrap().into_value().unwrap();
        let list = kids(None)[0];
        assert_eq!(name(list), loro::LoroValue::from("bulletList"));
        let item = kids(Some(list))[0];
        let attrs = match tree.get_meta(item).unwrap().get("attributes") {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(a))) => a,
            other => panic!("{other:?}"),
        };
        assert_eq!(attrs.get("bid").unwrap().into_value().unwrap(), loro::LoroValue::from("item-1"));
        let paragraph = kids(Some(item))[0];
        let inline = folio_core::body::inline(&doc, paragraph).unwrap();
        let Some(loro::ValueOrContainer::Container(loro::Container::Text(text))) = inline.get(0) else { panic!("no text") };
        assert_eq!(text.to_string(), "粗体 and plain");
        let delta = format!("{:?}", text.to_delta());
        assert!(delta.contains("bold"), "the bold mark survived: {delta}");
        assert_eq!(card::summarize(&doc).text, "粗体 and plain");
        assert_eq!(s.list_cards(10).unwrap()[0].updated_at, 42, "library order unchanged");
        let backups = backup::list_backups(&backup::backups_dir(dir.path())).unwrap();
        assert_eq!(backups.iter().filter(|b| b.reason.as_deref() == Some("upgrade")).count(), 1, "a copy from before the migration");
        // Only once.
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        let count: i64 = s.conn.query_row("SELECT count(*) FROM doc_updates WHERE doc_id = ?1", [id.as_str()], |r| r.get(0)).unwrap();
        assert_eq!(count, 2, "the import plus one migration update");
    }

    /// Builds a card body: each entry is a paragraph (bid, text, optional
    /// linked card, optional referenced block).
    fn write_card(s: &mut Store, title: &str, paras: &[(&str, &str, Option<&DocId>, Option<&str>)], t: i64) -> DocId {
        use folio_core::body::{add_block, push_inline, push_text};
        let id = s.create_card(CardKind::Note, title, t).unwrap();
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        for (bid, text, link, r) in paras {
            let p = add_block(&doc, None, "paragraph", &[("bid", (*bid).into())]).unwrap();
            push_text(&doc, p, text).unwrap();
            if let Some(link) = link {
                push_inline(&doc, p, "cardLink", &[("cardId", link.as_str())]).unwrap();
            }
            if let Some(r) = r {
                push_inline(&doc, p, "blockRef", &[("bid", r)]).unwrap();
            }
        }
        doc.commit();
        s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, t).unwrap();
        id
    }

    /// A card whose paragraphs end in tags: (block id, text, tag names).
    fn write_tagged(s: &mut Store, title: &str, paras: &[(&str, &str, &[&str])], t: i64) -> DocId {
        use folio_core::body::{add_block, push_inline, push_text};
        let id = s.create_card(CardKind::Note, title, t).unwrap();
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        for (bid, text, tags) in paras {
            let p = add_block(&doc, None, "paragraph", &[("bid", (*bid).into())]).unwrap();
            push_text(&doc, p, text).unwrap();
            for name in *tags {
                push_inline(&doc, p, "tag", &[("name", name)]).unwrap();
            }
        }
        doc.commit();
        s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, t).unwrap();
        id
    }

    #[test]
    fn tags_match_case_insensitively_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let a = write_tagged(&mut s, "周会", &[("a1", "讨论排期 ", &["会议", "Todo"]), ("a2", "无标签", &[])], 1);
        let b = write_tagged(&mut s, "Reading", &[("b1", "chapter 3 ", &["todo"])], 2);
        let trashed = write_tagged(&mut s, "Old", &[("c1", "gone ", &["会议"])], 3);
        s.trash_card(&trashed, 4).unwrap();

        let tags = s.tags(10).unwrap();
        let summary: Vec<_> = tags.iter().map(|t| (t.key.as_str(), t.name.as_str(), t.blocks, t.cards)).collect();
        // "todo" was last written in Reading (newer), so that spelling wins.
        assert_eq!(summary, vec![("todo", "todo", 2, 2), ("会议", "会议", 1, 1)]);

        let todo: Vec<_> = s.tagged("TODO", 10).unwrap().into_iter().map(|r| (r.card_id, r.bid, r.via)).collect();
        assert_eq!(todo, vec![(b.to_string(), "b1".to_owned(), "tag".to_owned()), (a.to_string(), "a1".to_owned(), "tag".to_owned())]);
        // Tags are part of the block's text, so search finds them too.
        assert!(s.search("#会议", 10).unwrap().iter().any(|h| h.bid.as_deref() == Some("a1")));
    }

    #[test]
    fn a_tagged_item_comes_with_the_items_under_it() {
        use folio_core::body::{add_block, push_inline, push_text};
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let id = s.create_card(CardKind::Note, "日记", 1).unwrap();
        let doc = LoroDoc::new();
        doc.import(&s.doc_snapshot(&id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        // - #想法
        //   - 第一条
        //     - 补充
        //   - 第二条
        // - 别的事
        let item = |list, bid: &str, text: &str| {
            let it = add_block(&doc, Some(list), "listItem", &[("bid", bid.into())]).unwrap();
            let p = add_block(&doc, Some(it), "paragraph", &[]).unwrap();
            push_text(&doc, p, text).unwrap();
            (it, p)
        };
        let top = add_block(&doc, None, "bulletList", &[]).unwrap();
        let (idea, p) = item(top, "idea", "");
        push_inline(&doc, p, "tag", &[("name", "想法")]).unwrap();
        let under = add_block(&doc, Some(idea), "bulletList", &[]).unwrap();
        let (first, _) = item(under, "c1", "第一条");
        let deeper = add_block(&doc, Some(first), "bulletList", &[]).unwrap();
        item(deeper, "c1a", "补充");
        item(under, "c2", "第二条");
        item(top, "other", "别的事");
        doc.commit();
        s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, 2).unwrap();

        let rows = s.tagged("想法", 10).unwrap();
        assert_eq!(rows.len(), 1);
        let kids: Vec<_> = rows[0].children.iter().map(|c| (c.bid.as_str(), c.depth, c.text.as_str())).collect();
        assert_eq!(kids, vec![("c1", 1, "第一条"), ("c1a", 2, "补充"), ("c2", 1, "第二条")]);
    }

    #[test]
    fn the_inbox_keeps_clipped_links_until_dealt_with() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let clip = card::Clip { url: "https://github.com/loro-dev/loro".into(), site: "GitHub".into(), excerpt: "CRDT 协同数据结构".into(), author: String::new() };
        let a = s.create_clip("loro-dev/loro", &clip, "", 1).unwrap();
        let b = s.create_clip("另一篇", &card::Clip { url: "https://a.com".into(), ..Default::default() }, " 值得一读 ", 2).unwrap();
        let ids = |s: &Store| s.inbox().unwrap().into_iter().map(|i| i.id).collect::<Vec<_>>();
        assert_eq!(ids(&s), vec![b.to_string(), a.to_string()]);
        let first = &s.inbox().unwrap()[1];
        assert_eq!((first.preview.as_str(), first.clip.as_ref()), ("CRDT 协同数据结构", Some(&clip)));
        assert_eq!(s.inbox().unwrap()[0].preview, "值得一读");
        // Found by its summary and site, with the full-text index and without.
        assert!(s.search("协同数据", 10).unwrap().iter().any(|h| h.card_id == a.as_str()));
        assert!(s.search("协同", 10).unwrap().iter().any(|h| h.card_id == a.as_str()));
        assert!(s.search("GitHub", 10).unwrap().iter().any(|h| h.card_id == a.as_str()));
        s.set_inbox(&a, false, 3).unwrap();
        assert_eq!(ids(&s), vec![b.to_string()]);
        // Still a card in the library, with its link.
        assert!(s.list_cards(10).unwrap().iter().any(|c| c.id == a.as_str()));
        s.trash_card(&b, 4).unwrap();
        assert!(ids(&s).is_empty());
        s.rebuild_index().unwrap();
        assert!(ids(&s).is_empty());
        s.restore_card(&b, 5).unwrap();
        assert_eq!(ids(&s), vec![b.to_string()]);
    }

    #[test]
    fn a_tags_database_has_its_cards_and_their_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let book = write_tagged(&mut s, "三体", &[("a1", "科幻 ", &["书"])], 1);
        let other = write_tagged(&mut s, "Rust 编程", &[("b1", "", &["书", "编程"]), ("b2", "again ", &["书"])], 2);
        let day = DocId::journal(2026, 10, 31).unwrap();
        s.apply_update(&day, DocKind::Card, &journal_with_tag(&s, "书"), Origin::Local, 3).unwrap();
        s.edit(&book, DocKind::Card, 4, |doc| {
            let props = doc.get_map(card::META).ensure_mergeable_map(card::CARD_PROPS)?;
            props.insert("status", "在读")?;
            props.insert("rating", 5)?;
            doc.commit();
            Ok(())
        })
        .unwrap();
        let rows = s.tag_cards("书").unwrap();
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec![book.as_str(), other.as_str()], "no journal days, each card once");
        let props: serde_json::Value = serde_json::from_str(&rows[0].props).unwrap();
        assert_eq!(props, serde_json::json!({ "status": "在读", "rating": 5 }));
        assert_eq!(rows[1].props, "{}");
        s.trash_card(&other, 5).unwrap();
        assert_eq!(s.tag_cards("书").unwrap().len(), 1);
    }

    /// A journal day with one paragraph holding a tag.
    fn journal_with_tag(s: &Store, name: &str) -> Vec<u8> {
        use folio_core::body::{add_block, push_inline};
        let doc = LoroDoc::new();
        doc.set_peer_id(s.peer + 1).unwrap();
        card::init_card(&doc, CardKind::Journal, "2026-10-31", 3).unwrap();
        let p = add_block(&doc, None, "paragraph", &[("bid", "j1".into())]).unwrap();
        push_inline(&doc, p, "tag", &[("name", name)]).unwrap();
        doc.commit();
        doc.export(ExportMode::all_updates()).unwrap()
    }

    #[test]
    fn topics_list_their_cards_apart_from_tags() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let note = write_tagged(&mut s, "指数基金", &[("n1", "定投 ", &["投资"])], 1);
        let book = s.create_card(CardKind::Note, "漫步华尔街", 2).unwrap();
        s.set_card_topic(&book, "topic-invest", true, 3).unwrap();
        s.set_card_topic(&book, "topic-books", true, 3).unwrap();
        s.set_card_topic(&note, "topic-invest", true, 4).unwrap();

        let ids = |rows: Vec<CardRow>| rows.into_iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(ids(s.topic_cards("topic-invest").unwrap()), [note.to_string(), book.to_string()]);
        let mut counts = s.topic_counts().unwrap();
        counts.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(counts, [TopicCount { id: "topic-books".into(), cards: 1 }, TopicCount { id: "topic-invest".into(), cards: 2 }]);
        // Tags are their own thing: the #投资 paragraph is a tag, not the topic.
        assert_eq!(s.tagged("投资", 10).unwrap().len(), 1);
        assert_eq!(s.tags(10).unwrap().iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), ["投资"]);
        let texts = s.card_texts(&[book.to_string(), "missing".into()]).unwrap();
        assert_eq!(texts.len(), 1);
        assert_eq!((texts[0].title.as_str(), texts[0].deleted), ("漫步华尔街", false));
        let mut pairs = s.card_topic_pairs().unwrap();
        pairs.sort();
        assert_eq!(pairs.len(), 3);
        assert!(pairs.contains(&(book.to_string(), "topic-books".into())));
        s.set_card_topic(&book, "topic-invest", false, 5).unwrap();
        assert_eq!(ids(s.topic_cards("topic-invest").unwrap()), [note.to_string()]);
        s.trash_card(&note, 6).unwrap();
        assert!(s.topic_cards("topic-invest").unwrap().is_empty());
    }

    #[test]
    fn backlinks_unlinked_references_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let target = write_card(&mut s, "卡片写作", &[("t1", "先写结论再写理由", None, None)], 1);
        let linking = write_card(&mut s, "读书笔记", &[("a1", "关于", Some(&target), None), ("a2", "无关的一句", None, None)], 2);
        let referencing = write_card(&mut s, "周报", &[("b1", "引用了：", None, Some("t1"))], 3);
        let mentioning = write_card(&mut s, "随想", &[("c1", "今天想到卡片写作的好处", None, None)], 4);

        let back: Vec<_> = s.backlinks(&target).unwrap().into_iter().map(|b| (b.card_id, b.bid, b.via)).collect();
        assert_eq!(
            back,
            vec![(referencing.to_string(), "b1".to_owned(), "ref".to_owned()), (linking.to_string(), "a1".to_owned(), "link".to_owned())]
        );

        // The linking block also contains the title, but it is linked already.
        let unlinked: Vec<_> = s.unlinked_references(&target, 10).unwrap().into_iter().map(|b| (b.card_id, b.bid)).collect();
        assert_eq!(unlinked, vec![(mentioning.to_string(), "c1".to_owned())]);

        // Three or more characters: full text, titles first.
        let hits: Vec<_> = s.search("卡片写作", 10).unwrap().into_iter().map(|h| (h.card_id, h.bid)).collect();
        assert_eq!(hits[0], (target.to_string(), None));
        assert!(hits.contains(&(mentioning.to_string(), Some("c1".to_owned()))));
        // Two characters: substring scan.
        let two: Vec<_> = s.search("理由", 10).unwrap().into_iter().map(|h| h.bid).collect();
        assert_eq!(two, vec![Some("t1".to_owned())]);
        assert!(s.search("  ", 10).unwrap().is_empty());
        // Several words: all of them, in any order, not as a phrase.
        let both: Vec<_> = s.search("写理由 先写结论", 10).unwrap().into_iter().map(|h| h.bid).collect();
        assert_eq!(both, vec![Some("t1".to_owned())]);
        let mixed: Vec<_> = s.search("理由 先写结论", 10).unwrap().into_iter().map(|h| h.bid).collect();
        assert_eq!(mixed, vec![Some("t1".to_owned())], "a short word falls back to LIKE for all words");
        assert!(s.search("理由 好处", 10).unwrap().is_empty(), "words in different blocks");

        let texts = s.block_texts(&["t1".to_owned(), "missing".to_owned()]).unwrap();
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0].text, "先写结论再写理由");
        assert_eq!(s.titles(&[target.to_string()]).unwrap()[0].1, "卡片写作");

        // A trashed card's links stop counting.
        s.trash_card(&linking, 5).unwrap();
        assert_eq!(s.backlinks(&target).unwrap().len(), 1);
    }
}
