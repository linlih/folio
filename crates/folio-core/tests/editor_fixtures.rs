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
