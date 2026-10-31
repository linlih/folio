//! What the indexer extracts from a card body (design/ARCHITECTURE.md §4.4,
//! §8 M2): blocks, card links and block references.
//!
//! A *block* is what block references and backlinks point at: an outline
//! item (its text is its first line, other paragraphs it holds are added), or
//! a top-level text block outside lists. Inline nodes (card links, block
//! references, tags, hard breaks, inline math) stay inside their line.

use loro::{LoroDoc, LoroValue};

use crate::card::{CHILDREN, NODE_NAME};

const ATTRIBUTES: &str = "attributes";
const ITEMS: [&str; 2] = ["listItem", "taskItem"];
const LISTS: [&str; 3] = ["bulletList", "orderedList", "taskList"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub bid: String,
    pub parent: Option<String>,
    /// Position among its siblings.
    pub ord: i64,
    /// Node type: listItem, taskItem, paragraph, heading, codeBlock, …
    pub kind: String,
    pub text: String,
    /// A task's state, priority and dates (a `taskItem`).
    pub task: Option<Task>,
}

/// A task as its item holds it (web/src/editor/outliner/tasks.ts).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Task {
    /// todo, doing, done, backlog, review or canceled.
    pub status: String,
    /// high, medium or low.
    pub priority: Option<String>,
    /// `YYYY-MM-DD`
    pub deadline: Option<String>,
    pub scheduled: Option<String>,
}

fn task_of(node: &LoroValue) -> Option<Task> {
    if name(node) != "taskItem" {
        return None;
    }
    let LoroValue::Map(m) = node else { return None };
    let checked = matches!(m.get(ATTRIBUTES), Some(LoroValue::Map(a)) if matches!(a.get("checked"), Some(LoroValue::Bool(true))));
    let status = if checked { "done".to_owned() } else { attr(node, "status").unwrap_or_else(|| "todo".to_owned()) };
    Some(Task { status, priority: attr(node, "priority"), deadline: attr(node, "deadline"), scheduled: attr(node, "scheduled") })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extract {
    pub blocks: Vec<Block>,
    /// (block id holding the link, linked card id)
    pub links: Vec<(String, String)>,
    /// (block id holding the reference, referenced block id)
    pub refs: Vec<(String, String)>,
    /// (block id holding the tag, tag name as written)
    pub tags: Vec<(String, String)>,
    /// The files (images, attachments) the body uses, once each.
    pub assets: Vec<AssetRef>,
}

/// A file a card uses: its hash, and its type as the node records it (a
/// device that has not downloaded the file serves it with this type).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRef {
    pub sha256: String,
    pub mime: Option<String>,
}

fn name(node: &LoroValue) -> &str {
    match node {
        LoroValue::Map(m) => match m.get(NODE_NAME) {
            Some(LoroValue::String(s)) => s.as_str(),
            _ => "",
        },
        _ => "",
    }
}

fn attr(node: &LoroValue, key: &str) -> Option<String> {
    let LoroValue::Map(m) = node else { return None };
    let Some(LoroValue::Map(a)) = m.get(ATTRIBUTES) else { return None };
    match a.get(key) {
        Some(LoroValue::String(s)) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

fn children(node: &LoroValue) -> Vec<LoroValue> {
    match node {
        LoroValue::Map(m) => match m.get(CHILDREN) {
            Some(LoroValue::List(l)) => l.iter().cloned().collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// The text of a text block, with inline nodes inline; card links and block
/// references found are reported against `block`.
fn inline_text(node: &LoroValue, block: &str, out: &mut Extract) -> String {
    let mut s = String::new();
    for child in children(node) {
        match &child {
            LoroValue::String(t) => s.push_str(t),
            LoroValue::Map(_) => match name(&child) {
                "cardLink" => {
                    if let Some(id) = attr(&child, "cardId") {
                        out.links.push((block.to_owned(), id));
                    }
                    s.push_str(&attr(&child, "title").unwrap_or_default());
                }
                "blockRef" => {
                    if let Some(bid) = attr(&child, "bid") {
                        out.refs.push((block.to_owned(), bid));
                    }
                }
                "tag" => {
                    if let Some(name) = attr(&child, "name") {
                        s.push('#');
                        s.push_str(&name);
                        out.tags.push((block.to_owned(), name));
                    }
                }
                "hardBreak" => s.push(' '),
                "inlineMath" => s.push_str(&attr(&child, "latex").unwrap_or_default()),
                _ => s.push_str(&inline_text(&child, block, out)),
            },
            _ => {}
        }
    }
    s
}

fn is_textblock(n: &str) -> bool {
    matches!(n, "paragraph" | "heading" | "codeBlock")
}

/// Walks a list of block-level nodes under `parent` (an item's bid, or None
/// at the top level).
fn walk(nodes: &[LoroValue], parent: Option<&str>, out: &mut Extract) {
    let mut ord = 0;
    for node in nodes {
        let kind = name(node);
        if LISTS.contains(&kind) {
            walk(&children(node), parent, out);
        } else if ITEMS.contains(&kind) {
            let bid = attr(node, "bid").unwrap_or_default();
            let mut text = String::new();
            let mut nested = Vec::new();
            for child in children(node) {
                let n = name(&child);
                if LISTS.contains(&n) || n == "table" {
                    nested.push(child);
                } else if is_textblock(n) || n == "blockquote" {
                    let t = inline_text(&child, &bid, out);
                    if !t.is_empty() {
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(&t);
                    }
                }
            }
            if !bid.is_empty() {
                out.blocks.push(Block { bid: bid.clone(), parent: parent.map(str::to_owned), ord, kind: kind.to_owned(), text, task: task_of(node) });
                ord += 1;
            }
            walk(&nested, if bid.is_empty() { parent } else { Some(&bid) }, out);
        } else if is_textblock(kind) {
            let bid = attr(node, "bid").unwrap_or_default();
            let text = inline_text(node, &bid, out);
            if !bid.is_empty() {
                out.blocks.push(Block { bid, parent: parent.map(str::to_owned), ord, kind: kind.to_owned(), text, task: None });
                ord += 1;
            }
        } else if kind == "blockquote" {
            walk(&children(node), parent, out);
        } else if kind == "table" {
            // One block: its cells' text, `|` between cells and a line per
            // row; links and tags in a cell belong to the table.
            let bid = attr(node, "bid").unwrap_or_default();
            let text = table_text(node, &bid, out);
            if !bid.is_empty() {
                out.blocks.push(Block { bid, parent: parent.map(str::to_owned), ord, kind: kind.to_owned(), text, task: None });
                ord += 1;
            }
        }
    }
}

/// A table's text: rows on lines of their own, cells joined by ` | `.
fn table_text(table: &LoroValue, bid: &str, out: &mut Extract) -> String {
    let rows: Vec<String> = children(table)
        .iter()
        .map(|row| {
            let cells: Vec<String> = children(row)
                .iter()
                .map(|cell| children(cell).iter().filter(|p| is_textblock(name(p))).map(|p| inline_text(p, bid, out)).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" "))
                .collect();
            cells.join(" | ")
        })
        .collect();
    rows.join("\n")
}

/// The files image and file blocks point at, wherever they sit.
fn collect_assets(node: &LoroValue, out: &mut Vec<AssetRef>) {
    if matches!(name(node), "image" | "file") {
        if let Some(sha256) = attr(node, "asset") {
            if !out.iter().any(|a| a.sha256 == sha256) {
                out.push(AssetRef { sha256, mime: attr(node, "mime") });
            }
        }
    }
    for child in children(node) {
        collect_assets(&child, out);
    }
}

/// Blocks, links, references and files of a card body.
pub fn extract(doc: &LoroDoc) -> Extract {
    let mut out = Extract::default();
    let root = crate::body::body_value(doc);
    walk(&children(&root), None, &mut out);
    collect_assets(&root, &mut out.assets);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{add_block, push_inline, push_text};
    use crate::card::{init_card, CardKind};

    #[test]
    fn blocks_links_and_refs() {
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Journal, "", 1).unwrap();
        let bid = |b: &str| [("bid", LoroValue::from(b))];
        let p = add_block(&doc, None, "paragraph", &bid("p1")).unwrap();
        push_text(&doc, p, "intro ").unwrap();
        push_inline(&doc, p, "cardLink", &[("cardId", "c2"), ("title", "Card Two")]).unwrap();
        push_text(&doc, p, " end").unwrap();
        let list = add_block(&doc, None, "bulletList", &[]).unwrap();
        let item = add_block(&doc, Some(list), "listItem", &bid("i1")).unwrap();
        let line = add_block(&doc, Some(item), "paragraph", &bid("i1p")).unwrap();
        push_text(&doc, line, "see ").unwrap();
        push_inline(&doc, line, "blockRef", &[("bid", "p1")]).unwrap();
        let nested = add_block(&doc, Some(item), "bulletList", &[]).unwrap();
        let child = add_block(&doc, Some(nested), "taskItem", &bid("i2")).unwrap();
        let todo = add_block(&doc, Some(child), "paragraph", &bid("i2p")).unwrap();
        push_text(&doc, todo, "todo ").unwrap();
        push_inline(&doc, todo, "tag", &[("name", "会议")]).unwrap();
        doc.commit();

        let x = extract(&doc);
        let blocks: Vec<_> = x.blocks.iter().map(|b| (b.bid.as_str(), b.parent.as_deref(), b.kind.as_str(), b.text.as_str())).collect();
        assert_eq!(
            blocks,
            vec![
                ("p1", None, "paragraph", "intro Card Two end"),
                ("i1", None, "listItem", "see "),
                ("i2", Some("i1"), "taskItem", "todo #会议"),
            ]
        );
        assert_eq!(x.links, vec![("p1".to_owned(), "c2".to_owned())]);
        assert_eq!(x.refs, vec![("i1".to_owned(), "p1".to_owned())]);
        assert_eq!(x.tags, vec![("i2".to_owned(), "会议".to_owned())]);
        assert!(x.assets.is_empty());
    }

    #[test]
    fn files_anywhere_in_the_body() {
        let doc = LoroDoc::new();
        init_card(&doc, CardKind::Note, "", 1).unwrap();
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        add_block(&doc, None, "image", &[("asset", LoroValue::from(a.as_str())), ("mime", LoroValue::from("image/png"))]).unwrap();
        add_block(&doc, None, "image", &[("src", LoroValue::from("https://example.com/x.png"))]).unwrap();
        let list = add_block(&doc, None, "bulletList", &[]).unwrap();
        let item = add_block(&doc, Some(list), "listItem", &[("bid", LoroValue::from("i1"))]).unwrap();
        add_block(&doc, Some(item), "paragraph", &[]).unwrap();
        add_block(&doc, Some(item), "file", &[("asset", LoroValue::from(b.as_str()))]).unwrap();
        add_block(&doc, Some(item), "image", &[("asset", LoroValue::from(a.as_str()))]).unwrap();
        doc.commit();
        let refs = extract(&doc).assets;
        assert_eq!(refs, vec![AssetRef { sha256: a, mime: Some("image/png".into()) }, AssetRef { sha256: b, mime: None }]);
    }
}
