use loro::LoroDoc;
use folio_core::card::{ensure_body, init_card};
use folio_core::CardKind;

use super::*;

fn rich() -> LoroDoc {
    let doc = LoroDoc::new();
    doc.import(include_bytes!("../tests/fixtures/card-rich.loro")).unwrap();
    doc
}

const RICH: &str = "## Plan

Some **bold** and *italic* text, `code`, a [link](https://example.com).

See [[Renamed card]] and “a referenced block”, math $e^{i\\pi}$.

- parent
  - child
- [ ] todo
- [/] doing ⏫ 📅 2026-11-01
- [x] done
- [-] canceled

1. first
2. second

> quoted

```rust
fn main() {}
```

中文段落 \\*not emphasis\\*
";

#[test]
fn a_card_written_in_the_editor_as_markdown() {
    let titles = |id: &str| (id == "card-2").then(|| "Renamed card".to_owned());
    let blocks = |bid: &str| (bid == "blk-9").then(|| "a referenced block".to_owned());
    assert_eq!(body_markdown(&rich(), &Links { card_title: &titles, block_text: &blocks }), RICH);
}

#[test]
fn links_fall_back_to_what_the_document_stored() {
    let md = body_markdown(&rich(), &Links::STORED);
    assert!(md.contains("[[Other card]]"));
    assert!(md.contains("((blk-9))"));
}

#[test]
fn file_names_are_safe_and_unique() {
    assert_eq!(file_stem("a/b: c?"), "a-b- c-");
    assert_eq!(file_stem("  ..hidden.  "), "hidden");
    let card = |id: &str, title: &str, date: Option<&str>| ExportCard {
        id: id.into(),
        title: title.into(),
        journal_date: date.map(Into::into),
        doc: LoroDoc::new(),
    };
    let cards = [card("1", "Idea", None), card("2", "idea", None), card("3", "", None), card("4", "", Some("2026-10-24"))];
    let n = names(&cards, "Untitled");
    assert_eq!(n["1"], ("cards", "Idea".to_owned()));
    assert_eq!(n["2"], ("cards", "idea (2)".to_owned()));
    assert_eq!(n["3"], ("cards", "Untitled".to_owned()));
    assert_eq!(n["4"], ("journals", "2026-10-24".to_owned()));
}

#[test]
fn exports_cards_and_journals_with_links_to_file_names() {
    let dir = tempfile::tempdir().unwrap();
    let journal = LoroDoc::new();
    init_card(&journal, CardKind::Journal, "", 1).unwrap();
    ensure_body(&journal).unwrap();
    journal.commit();
    let cards = vec![
        ExportCard { id: "card-2".into(), title: "Other card".into(), journal_date: None, doc: LoroDoc::new() },
        ExportCard { id: "rich".into(), title: "Rich".into(), journal_date: None, doc: rich() },
        ExportCard { id: "j".into(), title: String::new(), journal_date: Some("2026-10-24".into()), doc: journal },
    ];
    let summary = export_markdown(dir.path(), &cards, &|_| None, "Untitled").unwrap();
    assert_eq!(summary, ExportSummary { cards: 2, journals: 1 });
    let rich_md = std::fs::read_to_string(dir.path().join("cards/Rich.md")).unwrap();
    assert!(rich_md.contains("[[Other card]]"), "{rich_md}");
    assert!(dir.path().join("cards/Other card.md").exists());
    assert!(dir.path().join("journals/2026-10-24.md").exists());
}
