//! Library statistics (design/stats.md): a few numbers for the stats dialog.
//! Read-only: SELECTs on the index and `assets`, and file sizes.

use serde::Serialize;

use crate::{Result, Store, backup};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    /// Cards in the card library, counted as its header counts them.
    pub cards: i64,
    /// Words in the bodies of cards and journal days not in the trash.
    pub words: i64,
    /// Images and other files those cards use, and their size.
    pub files: i64,
    pub file_bytes: i64,
    /// Days a card was made or the journal written.
    pub days_recorded: i64,
    /// The first of them, `YYYY-MM-DD`.
    pub first_day: Option<String>,
    /// Those days from `from` on, oldest first.
    pub heat: Vec<HeatDay>,
    /// The library folder's size: databases, local files and backups.
    pub library_bytes: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatDay {
    pub date: String,
    /// Cards made that day.
    pub cards: i64,
    /// The journal of that day has something in it.
    pub journal: bool,
}

impl Store {
    /// The stats dialog's numbers; `from` (`YYYY-MM-DD`) is where its heat map starts.
    pub fn library_stats(&self, from: &str) -> Result<LibraryStats> {
        let one = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        // As the card library: no journal days, nothing in the trash, and
        // nothing still in the inbox or under 已整理 unless it is in a topic.
        let cards = one(
            "SELECT count(*) FROM idx.cards WHERE kind != 'journal' AND deleted_at IS NULL
               AND NOT ((inbox_at IS NOT NULL OR archived_at IS NOT NULL)
                        AND card_id NOT IN (SELECT card_id FROM idx.card_topics))",
        )?;
        let mut words = 0;
        let mut stmt = self.conn.prepare("SELECT text FROM idx.cards WHERE deleted_at IS NULL")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            words += folio_core::words::count_words(r.get_ref(0)?.as_str().unwrap_or_default()) as i64;
        }
        let (files, file_bytes) = self.conn.query_row(
            "SELECT count(*), coalesce(sum(a.size), 0) FROM
               (SELECT DISTINCT r.sha256 FROM idx.asset_refs r JOIN idx.cards c ON c.card_id = r.doc_id WHERE c.deleted_at IS NULL)
             LEFT JOIN assets a USING (sha256)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        // Each day: cards made then, and whether its journal has text.
        let mut stmt = self.conn.prepare(
            "SELECT d, sum(made), max(journal) FROM (
               SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, 1 AS made, 0 AS journal FROM idx.cards
                 WHERE kind != 'journal' AND deleted_at IS NULL AND created_at IS NOT NULL
               UNION ALL
               SELECT substr(card_id, 9), 0, 1 FROM idx.cards
                 WHERE kind = 'journal' AND deleted_at IS NULL AND length(trim(text, ' ' || char(9, 10, 13))) > 0)
             GROUP BY d ORDER BY d",
        )?;
        let days = stmt
            .query_map([], |r| Ok(HeatDay { date: r.get(0)?, cards: r.get(1)?, journal: r.get::<_, i64>(2)? == 1 }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let local_files = one("SELECT coalesce(sum(size), 0) FROM assets WHERE local = 1")?;
        let size = |name: &str| std::fs::metadata(self.dir.join(name)).map(|m| m.len() as i64).unwrap_or(0);
        let databases: i64 = ["store.db", "store.db-wal", "store.db-shm", "index.db", "index.db-wal", "index.db-shm"].iter().map(|n| size(n)).sum();
        let backups: i64 = std::fs::read_dir(backup::backups_dir(&self.dir))
            .map(|d| d.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len() as i64).sum())
            .unwrap_or(0);
        Ok(LibraryStats {
            cards,
            words,
            files,
            file_bytes,
            days_recorded: days.len() as i64,
            first_day: days.first().map(|d| d.date.clone()),
            heat: days.into_iter().filter(|d| d.date.as_str() >= from).collect(),
            library_bytes: databases + local_files + backups,
        })
    }
}

#[cfg(test)]
mod tests {
    use folio_core::card::{self, CardKind};
    use folio_core::{DocId, DocKind};
    use loro::LoroValue;

    use crate::{Incoming, Origin, Store};

    fn write(s: &mut Store, id: &DocId, text: &str, at: i64) {
        let text = text.to_owned();
        s.edit(id, DocKind::Card, at, move |doc| {
            card::append_paragraph(doc, &text)?;
            doc.commit();
            Ok(())
        })
        .unwrap();
    }

    fn day(s: &Store, ms: i64) -> String {
        s.conn.query_row("SELECT date(?1 / 1000, 'unixepoch', 'localtime')", [ms], |r| r.get(0)).unwrap()
    }

    #[test]
    fn counts_what_the_library_holds_and_nothing_in_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        const DAY: i64 = 86_400_000;
        let t0 = 1_793_000_000_000; // 2026-10
        let a = s.create_card(CardKind::Note, "标题不算", t0).unwrap();
        write(&mut s, &a, "今天读了 Rust 2024 的书。", t0 + 1);
        let gone = s.create_card(CardKind::Note, "删掉", t0 + 2 * DAY).unwrap();
        write(&mut s, &gone, "很多很多字", t0 + 2 * DAY);
        s.trash_card(&gone, t0 + 3 * DAY).unwrap();
        // A clipped link in the inbox: its site's summary is not the user's writing.
        let clip = card::Clip { url: "https://a.com".into(), site: "A".into(), excerpt: "网站摘要不算".into(), author: String::new() };
        s.create_clip("链接", &clip, "", t0 + 5 * DAY).unwrap();
        // A journal day counts by its own date; an empty one not at all.
        for (d, text) in [(1, "写日记"), (2, "")] {
            let doc = loro::LoroDoc::new();
            card::init_card(&doc, CardKind::Journal, "", 1).unwrap();
            if !text.is_empty() {
                card::append_paragraph(&doc, text).unwrap();
            }
            let id = DocId::journal(2026, 9, d).unwrap();
            s.apply_update(&id, DocKind::Card, &doc.export(loro::ExportMode::all_updates()).unwrap(), Origin::Local, t0).unwrap();
        }
        // One image, used twice; one in a trashed card only.
        let png = |s: &mut Store, bytes: &[u8]| {
            let mut inc = Incoming::create(&s.assets_dir()).unwrap();
            inc.write(bytes).unwrap();
            s.add_asset(inc, "a.png", "image/png", t0).unwrap().sha256
        };
        let (used, unused) = (png(&mut s, b"12345"), png(&mut s, b"123"));
        for (id, sha) in [(&a, &used), (&a, &used), (&gone, &unused)] {
            let sha = sha.clone();
            s.edit(id, DocKind::Card, t0 + 4, move |doc| {
                folio_core::body::add_block(doc, None, "image", &[("asset", LoroValue::from(sha.as_str()))])?;
                doc.commit();
                Ok(())
            })
            .unwrap();
        }

        let st = s.library_stats("2026-09-01").unwrap();
        // The note; the clip waits in the inbox, outside the library.
        assert_eq!(st.cards, 1);
        assert_eq!(st.words, 8 + 3);
        assert_eq!((st.files, st.file_bytes), (1, 5));
        let (d0, d5) = (day(&s, t0), day(&s, t0 + 5 * DAY));
        let mut want = vec![("2026-09-01".to_owned(), 0, true), (d0.clone(), 1, false), (d5.clone(), 1, false)];
        want.sort();
        let heat: Vec<_> = st.heat.iter().map(|h| (h.date.clone(), h.cards, h.journal)).collect();
        assert_eq!(heat, want);
        assert_eq!((st.days_recorded, st.first_day.as_deref()), (3, Some("2026-09-01")));
        assert!(st.library_bytes > 0);
        // The heat map starts where asked; the totals do not.
        let later = s.library_stats(&d5).unwrap();
        assert_eq!((later.heat.len(), later.days_recorded), (1, 3));
    }
}
