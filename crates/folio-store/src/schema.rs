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
    // 3: when a file stopped being used by any card; it is deleted a while
    // later (design/attachments.md §6).
    "ALTER TABLE assets ADD COLUMN orphan_since INTEGER;",
    // 4: documents deleted for good (§5.4), from the workspace document's
    // `purged` map: their updates are refused from then on. `sent` once the
    // sync server was told to delete its copy.
    "CREATE TABLE purged (doc_id TEXT PRIMARY KEY, at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0);",
];

/// Whether `store.db` has steps to run (and is not new).
pub fn has_pending_migrations(conn: &Connection) -> rusqlite::Result<bool> {
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    Ok(version > 0 && version < STORE_MIGRATIONS.len())
}

/// Bump whenever `INDEX_TABLES` changes.
const INDEX_VERSION: i64 = 11;

const INDEX_TABLES: &str = "
  CREATE TABLE idx.cards (
    card_id TEXT PRIMARY KEY, kind TEXT, title TEXT, preview TEXT, text TEXT,
    created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, pinned_at INTEGER,
    -- The inbox (design/inbox-and-tags.md): in it since; the clipped link
    -- as JSON; the link's site, author and summary for substring search.
    inbox_at INTEGER, clip TEXT, clip_text TEXT,
    -- Database field values by field id, JSON (design/inbox-and-tags.md §3).
    props TEXT,
    -- A journal day's lines with their links, JSON (folio_core::body::Line).
    lines TEXT
  );
  CREATE INDEX idx.cards_by_inbox ON cards(inbox_at);
  CREATE INDEX idx.cards_by_updated ON cards(updated_at);
  CREATE TABLE idx.blocks (
    bid TEXT, card_id TEXT, parent_bid TEXT, ord INTEGER, text TEXT, type TEXT,
    -- A task's state (todo, doing, done, …), priority and YYYY-MM-DD dates.
    task_status TEXT, priority TEXT, deadline TEXT, scheduled TEXT,
    PRIMARY KEY (card_id, bid)
  );
  CREATE INDEX idx.blocks_by_task ON blocks(task_status) WHERE task_status IS NOT NULL;
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
  -- Files (assets) the cards use, by hash.
  CREATE TABLE idx.asset_refs (sha256 TEXT, doc_id TEXT, mime TEXT, PRIMARY KEY (sha256, doc_id));
  CREATE INDEX idx.asset_refs_by_doc ON asset_refs(doc_id);
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
         DROP TABLE IF EXISTS idx.card_topics; DROP TABLE IF EXISTS idx.asset_refs;
         {INDEX_TABLES} PRAGMA idx.user_version = {INDEX_VERSION};"
    ))?;
    Ok(true)
}
