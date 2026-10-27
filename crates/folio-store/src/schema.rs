//! Table definitions (design/ARCHITECTURE.md §4.4) and migrations.
//!
//! `store.db` migrations are numbered with `PRAGMA user_version`; never edit a
//! released step, add a new one. `index.db` is derived: when its layout
//! changes, bump `INDEX_VERSION` and the tables are dropped and rebuilt from
//! `store.db` instead of migrated.

use rusqlite::Connection;

const STORE_MIGRATIONS: &[&str] = &[
    // 1: initial layout
    "CREATE TABLE docs (
       doc_id      TEXT PRIMARY KEY,
       kind        TEXT NOT NULL,
       snapshot    BLOB,
       snapshot_vv BLOB,
       updated_at  INTEGER NOT NULL
     );
     CREATE TABLE doc_updates (
       id      INTEGER PRIMARY KEY AUTOINCREMENT,
       doc_id  TEXT NOT NULL,
       bytes   BLOB NOT NULL,
       origin  TEXT NOT NULL,
       at      INTEGER NOT NULL
     );
     CREATE INDEX doc_updates_doc ON doc_updates(doc_id, id);
     CREATE TABLE assets (
       sha256 TEXT PRIMARY KEY, mime TEXT, size INTEGER,
       original_name TEXT, created_at INTEGER, meta TEXT,
       uploaded INTEGER DEFAULT 0, local INTEGER DEFAULT 1
     );
     CREATE TABLE sync_state (key TEXT PRIMARY KEY, value BLOB);
     CREATE TABLE device_acks (
       doc_id TEXT, device_id TEXT, version BLOB, at INTEGER,
       PRIMARY KEY (doc_id, device_id)
     );
     CREATE TABLE local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, bytes BLOB NOT NULL, at INTEGER NOT NULL
     );",
    // 2: a counter that grows with every write to a document, unlike
    // `updated_at` (a clock, which can go back): what sync reports go by.
    "ALTER TABLE docs ADD COLUMN changed INTEGER NOT NULL DEFAULT 0;
     CREATE INDEX docs_by_changed ON docs(changed);",
];

/// Whether `store.db` has steps to run (and is not new).
pub fn has_pending_migrations(conn: &Connection) -> rusqlite::Result<bool> {
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    Ok(version > 0 && version < STORE_MIGRATIONS.len())
}

/// Bump whenever `INDEX_TABLES` changes.
const INDEX_VERSION: i64 = 6;

const INDEX_TABLES: &str = "
  CREATE TABLE idx.cards (
    card_id TEXT PRIMARY KEY, kind TEXT, title TEXT, preview TEXT, text TEXT,
    created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, pinned_at INTEGER
  );
  CREATE INDEX idx.cards_by_updated ON cards(updated_at);
  CREATE TABLE idx.blocks (
    bid TEXT, card_id TEXT, parent_bid TEXT, ord INTEGER, text TEXT, type TEXT,
    PRIMARY KEY (card_id, bid)
  );
  CREATE INDEX idx.blocks_by_bid ON blocks(bid);
  -- [[card]] links: which block of which card links to which card.
  CREATE TABLE idx.links (from_card TEXT, from_bid TEXT, to_card TEXT);
  CREATE INDEX idx.links_to ON links(to_card);
  CREATE INDEX idx.links_from ON links(from_card);
  -- ((block)) references.
  CREATE TABLE idx.refs (from_card TEXT, from_bid TEXT, to_bid TEXT);
  CREATE INDEX idx.refs_to ON refs(to_bid);
  CREATE INDEX idx.refs_from ON refs(from_card);
  -- #tags: `tag` is the name in lower case (tags match case-insensitively),
  -- `name` as written.
  CREATE TABLE idx.tags (card_id TEXT, bid TEXT, tag TEXT, name TEXT);
  CREATE INDEX idx.tags_by_tag ON tags(tag);
  CREATE INDEX idx.tags_by_card ON tags(card_id);
  -- The topics a card is in (§4.7), by topic id in the workspace document.
  CREATE TABLE idx.card_topics (card_id TEXT, topic TEXT);
  CREATE INDEX idx.card_topics_by_topic ON card_topics(topic);
  CREATE INDEX idx.card_topics_by_card ON card_topics(card_id);
  -- Full text of titles (bid '') and blocks. Trigram works for Chinese
  -- without word splitting; queries under 3 characters use LIKE instead.
  CREATE VIRTUAL TABLE idx.fts USING fts5(card_id UNINDEXED, bid UNINDEXED, text, tokenize = 'trigram');
";

/// Brings both databases up to date. Returns true when the index was
/// recreated and has to be rebuilt.
pub fn migrate(conn: &Connection) -> rusqlite::Result<bool> {
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    for (i, step) in STORE_MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(step)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        tx.commit()?;
    }
    let index_version: i64 = conn.query_row("PRAGMA idx.user_version", [], |r| r.get(0))?;
    if index_version == INDEX_VERSION {
        return Ok(false);
    }
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS idx.cards; DROP TABLE IF EXISTS idx.blocks; DROP TABLE IF EXISTS idx.links;
         DROP TABLE IF EXISTS idx.refs; DROP TABLE IF EXISTS idx.fts; DROP TABLE IF EXISTS idx.tags;
         DROP TABLE IF EXISTS idx.card_topics;
         {INDEX_TABLES} PRAGMA idx.user_version = {INDEX_VERSION};"
    ))?;
    Ok(true)
}
