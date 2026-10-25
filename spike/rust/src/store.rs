//! `store.db` from ARCHITECTURE.md §4.4: a compacted snapshot per document
//! plus an append-only log of updates since that snapshot.

use std::time::Instant;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::DocEngine;

pub struct Store {
    pub conn: Connection,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LoadStats {
    pub snapshot_bytes: usize,
    pub updates: usize,
    pub update_bytes: usize,
    pub ms: f64,
}

impl Store {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (
               doc_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
               snapshot BLOB, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS doc_updates (
               id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL,
               bytes BLOB NOT NULL, origin TEXT NOT NULL, at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc_id, id);",
        )?;
        Ok(Store { conn })
    }

    /// The single write path: every local or remote update lands here first.
    pub fn append_update(&self, doc_id: &str, kind: &str, bytes: &[u8], origin: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO docs(doc_id, kind, snapshot, updated_at) VALUES (?1, ?2, NULL, 0)
             ON CONFLICT(doc_id) DO NOTHING",
            params![doc_id, kind],
        )?;
        tx.execute(
            "INSERT INTO doc_updates(doc_id, bytes, origin, at) VALUES (?1, ?2, ?3, 0)",
            params![doc_id, bytes, origin],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load<E: DocEngine>(&self, doc_id: &str, peer: u64) -> Result<(E, LoadStats)> {
        let t = Instant::now();
        let snapshot: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT snapshot FROM docs WHERE doc_id = ?1", [doc_id], |r| r.get(0))
            .optional()?
            .flatten();
        let mut stats = LoadStats::default();
        let engine = match &snapshot {
            Some(s) => {
                stats.snapshot_bytes = s.len();
                E::load(s, peer)?
            }
            None => E::new(peer),
        };
        let mut stmt = self.conn.prepare_cached("SELECT bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([doc_id], |r| r.get::<_, Vec<u8>>(0))?;
        for row in rows {
            let bytes = row?;
            stats.updates += 1;
            stats.update_bytes += bytes.len();
            engine.apply_update(&bytes)?;
        }
        stats.ms = t.elapsed().as_secs_f64() * 1000.0;
        Ok((engine, stats))
    }

    /// Fold the update log into a compacted snapshot.
    pub fn compact<E: DocEngine>(&self, doc_id: &str) -> Result<usize> {
        let (engine, _) = self.load::<E>(doc_id, 1)?;
        let bytes = engine.compact();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE docs SET snapshot = ?2 WHERE doc_id = ?1", params![doc_id, bytes])?;
        tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", [doc_id])?;
        tx.commit()?;
        Ok(bytes.len())
    }
}
