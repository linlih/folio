//! Search and indexing speed with 5000 cards (design/ARCHITECTURE.md §8, M2
//! exit criterion: search < 100 ms, including two-character Chinese
//! queries). Slow to set up, so ignored by default:
//!
//!     cargo test --release -p folio-store --test search_bench -- --ignored --nocapture

use std::time::{Duration, Instant};

use loro::{ExportMode, LoroDoc};
use folio_core::card::{append_paragraph, CardKind};
use folio_core::DocKind;
use folio_store::{Origin, Store};

const CARDS: usize = 5000;
const PARAGRAPHS: usize = 15;

const ZH: [&str; 24] = [
    "学习", "知识", "管理", "笔记", "卡片", "白板", "项目", "计划", "阅读", "写作", "思考", "记录", "复盘", "目标", "习惯", "时间", "工具", "方法",
    "数据库", "同步", "设计", "产品", "用户", "体验",
];
const EN: [&str; 16] = ["rust", "loro", "sqlite", "tauri", "react", "outline", "journal", "search", "index", "crdt", "editor", "block", "link", "query", "sync", "design"];

/// Deterministic pseudo-random numbers (no extra dependency).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 as usize
    }
}

fn sentence(rng: &mut Rng) -> String {
    let mut s = String::new();
    for i in 0..(8 + rng.next() % 10) {
        if rng.next() % 4 == 0 {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(EN[rng.next() % EN.len()]);
            s.push(' ');
        } else {
            s.push_str(ZH[rng.next() % ZH.len()]);
        }
    }
    s.push('。');
    s
}

fn add_paragraph(store: &mut Store, id: &folio_core::DocId, text: &str, now: i64) {
    let doc = LoroDoc::new();
    doc.import(&store.doc_snapshot(id).unwrap()).unwrap();
    let v = doc.oplog_vv();
    append_paragraph(&doc, text).unwrap();
    store.apply_update(id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, now).unwrap();
}

fn time<T>(runs: usize, mut f: impl FnMut() -> T) -> (Duration, Duration, T) {
    let mut times = Vec::new();
    let mut last = None;
    for _ in 0..runs {
        let t = Instant::now();
        last = Some(f());
        times.push(t.elapsed());
    }
    times.sort();
    (times[runs / 2], times[runs - 1], last.unwrap())
}

#[test]
#[ignore]
fn search_with_5000_cards() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let setup = Instant::now();
    let mut ids = Vec::new();
    for i in 0..CARDS {
        let title = format!("{}{} {}", ZH[rng.next() % ZH.len()], ZH[rng.next() % ZH.len()], i);
        let id = store.create_card(CardKind::Note, &title, i as i64).unwrap();
        // One update with all paragraphs, as an editing session saves them.
        let doc = LoroDoc::new();
        doc.import(&store.doc_snapshot(&id).unwrap()).unwrap();
        let v = doc.oplog_vv();
        for _ in 0..PARAGRAPHS {
            append_paragraph(&doc, &sentence(&mut rng)).unwrap();
        }
        store.apply_update(&id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, i as i64).unwrap();
        ids.push(id);
    }
    println!("setup: {CARDS} cards x {PARAGRAPHS} paragraphs in {:?}", setup.elapsed());

    for q in ["学习", "复盘", "知识管理", "数据库同步", "rust", "sqlite tauri", "学习 rust", "知识 管理 方法", "不存在的词"] {
        let (median, max, hits) = time(15, || store.search(q, 40).unwrap().len());
        println!("search {q:<12} median {median:>10.2?}  max {max:>10.2?}  hits {hits}");
    }
    let target = &ids[CARDS / 2];
    let (median, max, n) = time(15, || store.unlinked_references(target, 50).unwrap().len());
    println!("unlinked refs        median {median:>10.2?}  max {max:>10.2?}  hits {n}");
    let (median, max, n) = time(15, || store.backlinks(target).unwrap().len());
    println!("backlinks            median {median:>10.2?}  max {max:>10.2?}  hits {n}");
    let (median, max, n) = time(15, || store.list_cards(5000).unwrap().len());
    println!("list 5000 cards      median {median:>10.2?}  max {max:>10.2?}  rows {n}");
    let mut now = CARDS as i64;
    let (median, max, _) = time(15, || {
        now += 1;
        add_paragraph(&mut store, target, "保存一次：一个新段落", now)
    });
    println!("save one card        median {median:>10.2?}  max {max:>10.2?}");
}
