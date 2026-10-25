//! The card document layout in Loro (design/ARCHITECTURE.md §4.2, §4.5).
//!
//! A card doc has two root containers:
//! - `meta`: a map with kind, title, editor mode, timestamps and provenance;
//! - `body`: the ProseMirror tree in the layout the (patched) loro-prosemirror
//!   reads: `nodeName`, `attributes`, `children`, where `children` is a
//!   movable list so blocks are moved, not rewritten (layout 2, §4.5 rule 4).
//!   Layout 1 kept the tree under `doc` with plain lists; see `migrate_body`.
//!
//! Containers that two devices may create at the same time are mergeable
//! (§4.5): otherwise a journal day started offline on two devices would keep
//! only one device's text.

use loro::{
    Container, ExpandType, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroResult, LoroText, LoroValue, StyleConfig, StyleConfigMap,
    ValueOrContainer,
};
use serde::{Deserialize, Serialize};

use crate::ids::new_bid;

pub const META: &str = "meta";
pub const BODY_ROOT: &str = "body";
/// The body root of layout 1, before children became movable lists.
pub const LEGACY_BODY_ROOT: &str = "doc";
pub const NODE_NAME: &str = "nodeName";
pub const ATTRIBUTES: &str = "attributes";
pub const CHILDREN: &str = "children";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    Note,
    Journal,
}

impl CardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CardKind::Note => "note",
            CardKind::Journal => "journal",
        }
    }
}

/// Whether a new line starts a paragraph or a list item (§0.2 core model 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    Document,
    Outline,
}

impl EditorMode {
    pub fn as_str(self) -> &'static str {
        match self {
            EditorMode::Document => "document",
            EditorMode::Outline => "outline",
        }
    }
}

/// Writes the initial structure of a card. Safe to run on two devices at once
/// for the same document (journal days): every container is mergeable and the
/// scalar fields converge by last-writer-wins.
pub fn init_card(doc: &LoroDoc, kind: CardKind, title: &str, now_ms: i64) -> LoroResult<()> {
    let meta = doc.get_map(META);
    meta.insert("kind", kind.as_str())?;
    meta.insert("title", title)?;
    let mode = if kind == CardKind::Journal { EditorMode::Outline } else { EditorMode::Document };
    meta.insert("editor_mode", mode.as_str())?;
    meta.insert("created_at", now_ms)?;
    meta.insert("source", "human")?;
    doc.commit();
    Ok(())
}

/// The layout-2 body root (`body` map, movable children): only the layout
/// 1 → 2 migration writes it now; blocks live in a tree (`body.rs`).
pub fn ensure_body(doc: &LoroDoc) -> LoroResult<LoroMovableList> {
    let root = doc.get_map(BODY_ROOT);
    root.insert(NODE_NAME, "doc")?;
    root.ensure_mergeable_map(ATTRIBUTES)?;
    root.ensure_mergeable_movable_list(CHILDREN)
}

/// Appends a paragraph block. Used by importers and tests; the editor writes
/// through loro-prosemirror instead.
pub fn append_paragraph(doc: &LoroDoc, text: &str) -> LoroResult<String> {
    let bid = new_bid();
    let block = crate::body::add_block(doc, None, "paragraph", &[("bid", bid.as_str().into())])?;
    crate::body::push_text(doc, block, text)?;
    doc.commit();
    Ok(bid)
}

/// Moves the card to the trash (`Some(time)`) or back out of it (`None`).
/// Trashed cards keep all their content; only the marker changes.
pub fn set_deleted(doc: &LoroDoc, at: Option<i64>) -> LoroResult<()> {
    let meta = doc.get_map(META);
    match at {
        Some(t) => meta.insert("deleted_at", t)?,
        None => meta.delete("deleted_at")?,
    }
    doc.commit();
    Ok(())
}

/// The card's topics (§4.7): `meta.topics`, a mergeable map from a topic's
/// id (in the workspace document) to when the card was added, so two devices
/// adding different topics at once both keep theirs. Topics are not tags:
/// renaming one changes only the workspace document.
pub const CARD_TOPICS: &str = "topics";

pub fn add_card_topic(doc: &LoroDoc, topic: &str, at: i64) -> LoroResult<()> {
    doc.get_map(META).ensure_mergeable_map(CARD_TOPICS)?.insert(topic, at)?;
    doc.commit();
    Ok(())
}

pub fn remove_card_topic(doc: &LoroDoc, topic: &str) -> LoroResult<()> {
    doc.get_map(META).ensure_mergeable_map(CARD_TOPICS)?.delete(topic)?;
    doc.commit();
    Ok(())
}

/// The ids of the card's topics, sorted.
pub fn card_topics(doc: &LoroDoc) -> Vec<String> {
    let Some(ValueOrContainer::Container(loro::Container::Map(m))) = doc.get_map(META).get(CARD_TOPICS) else { return Vec::new() };
    let mut out = m.keys().map(|k| k.to_string()).collect::<Vec<_>>();
    out.sort();
    out
}

/// Pins a card to the sidebar (`Some(when)`) or unpins it. A meta field,
/// so it syncs like the trash flag.
pub fn set_pinned(doc: &LoroDoc, at: Option<i64>) -> LoroResult<()> {
    let meta = doc.get_map(META);
    match at {
        Some(t) => meta.insert("pinned_at", t)?,
        None => meta.delete("pinned_at")?,
    }
    doc.commit();
    Ok(())
}

/// Moves a layout-1 body (`doc` root, plain lists) into the layout-2 root
/// (`body`, movable lists), keeping every node, attribute (block ids
/// included) and text style, then empties the old root. Returns false when
/// there was nothing to migrate.
///
/// Must not run on two devices for the same document: each would copy the
/// tree and a merge would keep both copies. It runs in `folio-store` on open,
/// before sync exists (M3), so every document is migrated on the one device
/// that holds it.
pub fn migrate_body(doc: &LoroDoc) -> LoroResult<bool> {
    let old = doc.get_map(LEGACY_BODY_ROOT);
    let Some(ValueOrContainer::Container(Container::List(old_children))) = old.get(CHILDREN) else {
        return Ok(false);
    };
    configure_text_styles(doc);
    let new_children = ensure_body(doc)?;
    if !new_children.is_empty() {
        return Ok(false);
    }
    if let Some(ValueOrContainer::Container(Container::Map(attrs))) = old.get(ATTRIBUTES) {
        copy_map(&attrs, &doc.get_map(BODY_ROOT).ensure_mergeable_map(ATTRIBUTES)?)?;
    }
    copy_children(&old_children, &new_children)?;
    old.clear()?;
    doc.commit();
    Ok(true)
}

/// Marks keep their expand behaviour as configured by the editor: links do
/// not grow when typing at their edge, other marks do.
pub(crate) fn configure_text_styles(doc: &LoroDoc) {
    let mut styles = StyleConfigMap::new();
    styles.insert("link".into(), StyleConfig { expand: ExpandType::None });
    doc.config_text_style(styles);
    doc.config_default_text_style(Some(StyleConfig { expand: ExpandType::After }));
}

fn copy_map(from: &LoroMap, to: &LoroMap) -> LoroResult<()> {
    let mut entries = Vec::new();
    from.for_each(|k, v| {
        if let ValueOrContainer::Value(v) = v {
            entries.push((k.to_string(), v));
        }
    });
    for (k, v) in entries {
        to.insert(&k, v)?;
    }
    Ok(())
}

fn copy_children(from: &LoroList, to: &LoroMovableList) -> LoroResult<()> {
    for i in 0..from.len() {
        match from.get(i) {
            Some(ValueOrContainer::Container(Container::Map(node))) => {
                let copy = to.insert_container(to.len(), LoroMap::new())?;
                if let Some(ValueOrContainer::Value(name)) = node.get(NODE_NAME) {
                    copy.insert(NODE_NAME, name)?;
                }
                let attrs = copy.ensure_mergeable_map(ATTRIBUTES)?;
                if let Some(ValueOrContainer::Container(Container::Map(a))) = node.get(ATTRIBUTES) {
                    copy_map(&a, &attrs)?;
                }
                let kids = copy.ensure_mergeable_movable_list(CHILDREN)?;
                if let Some(ValueOrContainer::Container(Container::List(k))) = node.get(CHILDREN) {
                    copy_children(&k, &kids)?;
                }
            }
            Some(ValueOrContainer::Container(Container::Text(text))) => {
                let copy = to.insert_container(to.len(), LoroText::new())?;
                copy.apply_delta(&text.to_delta())?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// What the index needs from a card (`index.db` `cards` table).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CardSummary {
    pub kind: String,
    pub title: String,
    pub editor_mode: String,
    pub created_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub pinned_at: Option<i64>,
    /// The first characters of the body text, for lists and search results.
    pub preview: String,
    /// All body text, one line per block.
    pub text: String,
}

const PREVIEW_CHARS: usize = 160;

pub fn summarize(doc: &LoroDoc) -> CardSummary {
    let meta = doc.get_map(META);
    let string = |k: &str| match meta.get(k) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    };
    let int = |k: &str| match meta.get(k) {
        Some(ValueOrContainer::Value(LoroValue::I64(n))) => Some(n),
        Some(ValueOrContainer::Value(LoroValue::Double(n))) => Some(n as i64),
        _ => None,
    };
    let mut lines = Vec::new();
    collect_blocks(&crate::body::body_value(doc), 0, &mut lines);
    let text = lines.join("\n");
    let preview: String = lines.iter().map(|l| l.trim_start()).collect::<Vec<_>>().join(" ").chars().take(PREVIEW_CHARS).collect();
    CardSummary {
        kind: string("kind"),
        title: string("title"),
        editor_mode: string("editor_mode"),
        created_at: int("created_at"),
        deleted_at: int("deleted_at"),
        pinned_at: int("pinned_at"),
        preview,
        text,
    }
}

/// Walks the deep value of the body tree; a text container's deep value is a
/// string, so each textblock contributes one line. A line inside nested lists
/// is indented with one tab per level below the outermost list, so outlines
/// keep their shape in previews.
fn collect_blocks(v: &LoroValue, lists: usize, out: &mut Vec<String>) {
    let LoroValue::Map(node) = v else { return };
    let Some(LoroValue::List(children)) = node.get(CHILDREN) else { return };
    let indent = "\t".repeat(lists.saturating_sub(1));
    let mut own = String::new();
    for child in children.iter() {
        match child {
            LoroValue::String(s) => own.push_str(s),
            LoroValue::Map(m) => {
                let name = match m.get(NODE_NAME) {
                    Some(LoroValue::String(n)) => n.to_string(),
                    _ => String::new(),
                };
                // Inline nodes stay in their line: a card link reads as its title.
                if let Some(text) = inline_text(m, &name) {
                    own.push_str(&text);
                    continue;
                }
                if !own.is_empty() {
                    out.push(format!("{indent}{}", std::mem::take(&mut own)));
                }
                collect_blocks(child, lists + usize::from(LISTS.contains(&name.as_str())), out);
            }
            _ => {}
        }
    }
    if !own.is_empty() {
        out.push(format!("{indent}{own}"));
    }
}

const LISTS: [&str; 3] = ["bulletList", "orderedList", "taskList"];

/// The text an inline node contributes to its line; None for block nodes.
fn inline_text(node: &loro::LoroMapValue, name: &str) -> Option<String> {
    let attr = |k: &str| match node.get(ATTRIBUTES) {
        Some(LoroValue::Map(a)) => match a.get(k) {
            Some(LoroValue::String(s)) => s.to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    };
    match name {
        "cardLink" => Some(attr("title")),
        "blockRef" => Some(String::new()),
        "tag" => Some(format!("#{}", attr("name"))),
        "hardBreak" => Some(" ".into()),
        "inlineMath" => Some(attr("latex")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::{ExportMode, TreeParentId};

    fn sync(a: &LoroDoc, b: &LoroDoc) {
        b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap()).unwrap();
        a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap()).unwrap();
    }

    #[test]
    fn new_card_summarizes() {
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Note, "卡片要独立可读", 1_000).unwrap();
        append_paragraph(&doc, "先写结论，再写理由。").unwrap();
        append_paragraph(&doc, "Then the reasons.").unwrap();
        let s = summarize(&doc);
        assert_eq!(s.title, "卡片要独立可读");
        assert_eq!(s.kind, "note");
        assert_eq!(s.editor_mode, "document");
        assert_eq!(s.created_at, Some(1_000));
        assert_eq!(s.text, "先写结论，再写理由。\nThen the reasons.");
    }

    /// Regression for the review finding in §4.5: two devices start the same
    /// journal day offline; both devices' text must survive the merge.
    #[test]
    fn same_journal_day_started_on_two_devices_keeps_both() {
        let phone = LoroDoc::new();
        let laptop = LoroDoc::new();
        init_card(&phone, CardKind::Journal, "2026-10-23", 1).unwrap();
        init_card(&laptop, CardKind::Journal, "2026-10-23", 2).unwrap();
        append_paragraph(&phone, "手机上写的").unwrap();
        append_paragraph(&laptop, "电脑上写的").unwrap();
        sync(&phone, &laptop);
        let text = summarize(&phone).text;
        assert!(text.contains("手机上写的"), "{text}");
        assert!(text.contains("电脑上写的"), "{text}");
        assert_eq!(summarize(&phone), summarize(&laptop));
        assert_eq!(summarize(&phone).editor_mode, "outline");
    }

    #[test]
    fn outline_text_keeps_nesting() {
        use crate::body::{add_block, push_text};
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Journal, "", 1).unwrap();
        let line = |parent, t: &str| {
            let p = add_block(&doc, Some(parent), "paragraph", &[]).unwrap();
            push_text(&doc, p, t).unwrap();
        };
        let list = add_block(&doc, None, "bulletList", &[]).unwrap();
        let item = add_block(&doc, Some(list), "listItem", &[]).unwrap();
        line(item, "parent");
        let nested = add_block(&doc, Some(item), "bulletList", &[]).unwrap();
        line(add_block(&doc, Some(nested), "listItem", &[]).unwrap(), "child");
        line(add_block(&doc, Some(list), "listItem", &[]).unwrap(), "sibling");
        doc.commit();
        let s = summarize(&doc);
        assert_eq!(s.text, "parent\n\tchild\nsibling");
        assert_eq!(s.preview, "parent child sibling");
    }

    /// A layout-2 body (as the editor wrote it before layout 3) moves into
    /// the tree with its nesting, block ids and text styles.
    #[test]
    fn layout_2_bodies_move_into_the_tree() {
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Journal, "", 1).unwrap();
        configure_text_styles(&doc);
        let node = |children: &LoroMovableList, name: &str, bid: Option<&str>| {
            let n = children.insert_container(children.len(), LoroMap::new()).unwrap();
            n.insert(NODE_NAME, name).unwrap();
            let a = n.ensure_mergeable_map(ATTRIBUTES).unwrap();
            if let Some(bid) = bid {
                a.insert("bid", bid).unwrap();
            }
            n.ensure_mergeable_movable_list(CHILDREN).unwrap()
        };
        let body = ensure_body(&doc).unwrap();
        let list = node(&body, "bulletList", None);
        let item = node(&list, "listItem", Some("i1"));
        let p = node(&item, "paragraph", Some("p1"));
        let t = p.insert_container(0, LoroText::new()).unwrap();
        t.insert(0, "bold text").unwrap();
        t.mark(0..4, "bold", true).unwrap();
        let link = p.insert_container(1, LoroMap::new()).unwrap();
        link.insert(NODE_NAME, "cardLink").unwrap();
        link.ensure_mergeable_map(ATTRIBUTES).unwrap().insert("title", "Other").unwrap();
        doc.commit();
        assert_eq!(summarize(&doc).text, "");

        assert!(crate::body::migrate_to_tree(&doc).unwrap());
        assert_eq!(summarize(&doc).text, "bold textOther");
        let tree = crate::body::tree(&doc);
        let roots = tree.roots();
        let items = tree.children(TreeParentId::Node(roots[0])).unwrap();
        let item_meta = tree.get_meta(items[0]).unwrap();
        assert_eq!(item_meta.get(NODE_NAME).and_then(|v| v.into_value().ok()), Some(LoroValue::String("listItem".into())));
        let para = tree.children(TreeParentId::Node(items[0])).unwrap()[0];
        let inline = crate::body::inline(&doc, para).unwrap();
        let Some(ValueOrContainer::Container(Container::Text(text))) = inline.get(0) else { panic!() };
        assert_eq!(text.to_delta().len(), 2, "bold kept as its own run");
        // Once only.
        assert!(!crate::body::migrate_to_tree(&doc).unwrap());
    }

    /// An editor of layout 3 opened the card before the migration ran: it
    /// showed it empty, added a starter line, and the user wrote more. The
    /// migration keeps all of it: old blocks first, then the new writing;
    /// blank starter lines go.
    #[test]
    fn migration_keeps_what_was_written_in_the_tree_before_it_ran() {
        use crate::body::{add_block, push_text};
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Note, "t", 1).unwrap();
        let body = ensure_body(&doc).unwrap();
        let p = body.insert_container(0, LoroMap::new()).unwrap();
        p.insert(NODE_NAME, "paragraph").unwrap();
        p.ensure_mergeable_map(ATTRIBUTES).unwrap().insert("bid", "old").unwrap();
        p.ensure_mergeable_movable_list(CHILDREN).unwrap().insert_container(0, LoroText::new()).unwrap().insert(0, "old text").unwrap();
        // The starter line, then what the user typed into the "empty" card.
        add_block(&doc, None, "paragraph", &[("bid", "starter".into())]).unwrap();
        let new = add_block(&doc, None, "paragraph", &[("bid", "new".into())]).unwrap();
        push_text(&doc, new, "written since").unwrap();
        doc.commit();

        assert!(crate::body::migrate_to_tree(&doc).unwrap());
        assert_eq!(summarize(&doc).text, "old text\nwritten since");
        assert_eq!(crate::body::tree(&doc).roots().len(), 2, "the blank starter line is gone");
        assert!(doc.get_map(BODY_ROOT).is_empty());
    }

    #[test]
    fn trash_marker_round_trips() {
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Note, "t", 1).unwrap();
        set_deleted(&doc, Some(5)).unwrap();
        assert_eq!(summarize(&doc).deleted_at, Some(5));
        set_deleted(&doc, None).unwrap();
        assert_eq!(summarize(&doc).deleted_at, None);
        set_pinned(&doc, Some(7)).unwrap();
        assert_eq!(summarize(&doc).pinned_at, Some(7));
        set_pinned(&doc, None).unwrap();
        assert_eq!(summarize(&doc).pinned_at, None);
        add_card_topic(&doc, "t2", 1).unwrap();
        add_card_topic(&doc, "t1", 2).unwrap();
        add_card_topic(&doc, "t2", 3).unwrap();
        assert_eq!(card_topics(&doc), ["t1", "t2"]);
        remove_card_topic(&doc, "t2").unwrap();
        assert_eq!(card_topics(&doc), ["t1"]);
    }
}
