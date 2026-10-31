//! Documents written by the real editor (web/test/fixtures.test.ts) must be
//! read correctly by the indexer: same layout on both sides (§4.2, §4.5).

use loro::LoroDoc;
use folio_core::body::migrate_to_tree;
use folio_core::card::summarize;

fn load(bytes: &[u8]) -> LoroDoc {
    let doc = LoroDoc::new();
    doc.import(bytes).unwrap();
    doc
}

#[test]
fn journal_written_in_the_editor() {
    let s = summarize(&load(include_bytes!("fixtures/journal-from-editor.loro")));
    assert_eq!(s.kind, "journal");
    assert_eq!(s.editor_mode, "outline");
    assert_eq!(s.text, "parent bold\n\tchild\n中文条目");
}

/// Documents the editor wrote in layout 2 read the same after migrating.
#[test]
fn layout_2_editor_documents_migrate_to_the_tree() {
    let journal = load(include_bytes!("fixtures/journal-layout2.loro"));
    assert!(migrate_to_tree(&journal).unwrap());
    assert_eq!(summarize(&journal).text, "parent bold\n\tchild\n中文条目");

    let old = load(include_bytes!("fixtures/card-rich-layout2.loro"));
    let new = load(include_bytes!("../../folio-io/tests/fixtures/card-rich.loro"));
    assert!(migrate_to_tree(&old).unwrap());
    assert_eq!(summarize(&old).text, summarize(&new).text);
}

/// The journal's read-only days draw links from the lines: as the editor
/// stores card links, block references and web links.
#[test]
fn lines_find_the_links_the_editor_wrote() {
    use folio_core::body::{lines, Part};
    let doc = load(include_bytes!("../../folio-io/tests/fixtures/card-rich.loro"));
    let all = lines(&doc);
    let link = &all[1].parts;
    assert!(link.contains(&Part { text: "link".into(), href: Some("https://example.com".into()), ..Default::default() }), "{link:?}");
    // Bold, italic and code are not drawn: one plain part around them.
    assert_eq!(link[0], Part { text: "Some bold and italic text, code, a ".into(), ..Default::default() });
    let refs = &all[2].parts;
    assert!(refs.contains(&Part { text: "Other card".into(), card: Some("card-2".into()), ..Default::default() }), "{refs:?}");
    assert!(refs.contains(&Part { block: Some("blk-9".into()), ..Default::default() }), "{refs:?}");
    let text: Vec<String> = all.iter().map(|l| format!("{}{}", "\t".repeat(l.depth), l.parts.iter().map(|p| p.text.as_str()).collect::<String>())).collect();
    assert_eq!(text.join("\n"), summarize(&doc).text, "same lines as the text");
}

/// Tasks as the editor writes them: done is `checked`, other states
/// `status`, with priority and dates beside them.
#[test]
fn tasks_are_read_as_the_editor_wrote_them() {
    use folio_core::index::{extract, Task};
    let doc = load(include_bytes!("../../folio-io/tests/fixtures/card-rich.loro"));
    let tasks: Vec<(String, Task)> = extract(&doc).blocks.into_iter().filter_map(|b| b.task.map(|t| (b.text, t))).collect();
    let task = |status: &str| Task { status: status.into(), ..Default::default() };
    assert_eq!(
        tasks,
        vec![
            ("todo".into(), task("todo")),
            ("doing".into(), Task { priority: Some("high".into()), deadline: Some("2026-11-01".into()), ..task("doing") }),
            ("done".into(), task("done")),
            ("canceled".into(), task("canceled")),
        ]
    );
}
