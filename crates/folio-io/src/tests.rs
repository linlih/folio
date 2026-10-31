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
    assert_eq!(body_markdown(&rich(), &Links { card_title: &titles, block_text: &blocks, file: &|_, _| None }), RICH);
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
    let summary = export_markdown(dir.path(), &cards, &|_| None, &|_| None, "Untitled").unwrap();
    assert_eq!(summary, ExportSummary { cards: 2, journals: 1, files: 0 });
    let rich_md = std::fs::read_to_string(dir.path().join("cards/Rich.md")).unwrap();
    assert!(rich_md.contains("[[Other card]]"), "{rich_md}");
    assert!(dir.path().join("cards/Other card.md").exists());
    assert!(dir.path().join("journals/2026-10-24.md").exists());
}

/// A card with two images of the same file, a web image, an attachment
/// named like the image, and an attachment this device does not have.
fn card_with_files(shot: &str, doc_file: &str, missing: &str) -> LoroDoc {
    use folio_core::body::add_block;
    use loro::LoroValue;
    let doc = LoroDoc::new();
    init_card(&doc, CardKind::Note, "Files", 1).unwrap();
    let file = |name: &str, sha: &str| vec![("asset", LoroValue::from(sha)), ("name", LoroValue::from(name))];
    add_block(&doc, None, "image", &file("My shot.png", shot)).unwrap();
    add_block(&doc, None, "image", &[("src", LoroValue::from("https://example.com/a.png")), ("alt", LoroValue::from("web"))]).unwrap();
    let list = add_block(&doc, None, "bulletList", &[]).unwrap();
    let item = add_block(&doc, Some(list), "listItem", &[]).unwrap();
    add_block(&doc, Some(item), "paragraph", &[]).unwrap();
    add_block(&doc, Some(item), "image", &file("My shot.png", shot)).unwrap();
    add_block(&doc, None, "file", &file("my shot.PNG", doc_file)).unwrap();
    add_block(&doc, None, "file", &file("gone (1).pdf", missing)).unwrap();
    doc.commit();
    doc
}

#[test]
fn images_and_attachments_are_copied_once_and_linked() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let (shot, other, missing) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    std::fs::write(src.path().join(&shot), b"png").unwrap();
    std::fs::write(src.path().join(&other), b"other").unwrap();
    let source = |sha: &str| Some(src.path().join(sha)).filter(|p| p.is_file());
    let cards = vec![ExportCard { id: "f".into(), title: "Files".into(), journal_date: None, doc: card_with_files(&shot, &other, &missing) }];
    let summary = export_markdown(out.path(), &cards, &|_| None, &source, "Untitled").unwrap();
    assert_eq!(summary.files, 2);
    let md = std::fs::read_to_string(out.path().join("cards/Files.md")).unwrap();
    // The same file twice: one copy, one name.
    assert_eq!(md.matches("![My shot.png](../assets/My%20shot.png)").count(), 2, "{md}");
    assert!(md.contains("![web](https://example.com/a.png)"), "{md}");
    // Another file with the same name but for case gets its own.
    assert!(md.contains("[my shot.PNG](../assets/my%20shot%20%282%29.PNG)"), "{md}");
    // Not on this device: linked by name, nothing copied.
    assert!(md.contains("[gone (1).pdf](gone%20%281%29.pdf)"), "{md}");
    let mut copied: Vec<_> = std::fs::read_dir(out.path().join("assets")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    copied.sort();
    assert_eq!(copied, ["My shot.png", "my shot (2).PNG"]);
    assert_eq!(std::fs::read(out.path().join("assets/my shot (2).PNG")).unwrap(), b"other");
}

#[test]
fn without_a_place_for_files_they_are_named() {
    let md = body_markdown(&card_with_files(&"a".repeat(64), &"b".repeat(64), &"c".repeat(64)), &Links::STORED);
    assert!(md.starts_with("![My shot.png](My%20shot.png)"), "{md}");
    assert!(md.contains("[my shot.PNG](my%20shot.PNG)"), "{md}");
}

/// Tables as the editor writes them (web/test/fixtures.test.ts), as GitHub
/// tables: a header row, `|` escaped, a cell's lines joined by `<br>`; one
/// under a list item stays in the item, after a blank line.
#[test]
fn tables_as_github_tables() {
    let doc = LoroDoc::new();
    doc.import(include_bytes!("../tests/fixtures/card-table.loro")).unwrap();
    let md = body_markdown(&doc, &Links::STORED);
    assert_eq!(
        md,
        "Before\n\n| Name | **Note** |\n| --- | --- |\n| [[Other card]] | a\\|b<br>second line |\n| #x |  |\n\n- item\n\n  | k | v |\n  | --- | --- |\n  | 1 | 2 |\n"
    );
}
