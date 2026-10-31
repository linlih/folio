//! A card's body, layout 3 (design/ARCHITECTURE.md §4.5 rule 4): its blocks
//! are nodes of a LoroTree (root `blocks`). A node's metadata map holds
//! `nodeName` and mergeable `attributes`; a text block (paragraph, heading,
//! code block) also holds a mergeable movable list `children` with its inline
//! content (texts and inline nodes). Container blocks (lists, items, quotes)
//! have the tree's children. The editor binding writes the same layout
//! (web/src/vendor/loro-prosemirror/tree.ts).

use loro::{
    Container, LoroDoc, LoroMap, LoroMovableList, LoroResult, LoroText, LoroTree, LoroValue, TreeID, TreeParentId,
    ValueOrContainer,
};

use serde::{Deserialize, Serialize};

use crate::card::{configure_text_styles, ATTRIBUTES, BODY_ROOT, CHILDREN, NODE_NAME};

/// The root container of layout 3.
pub const TREE_ROOT: &str = "blocks";

/// Blocks with inline content.
pub const TEXTBLOCKS: [&str; 3] = ["paragraph", "heading", "codeBlock"];

pub fn tree(doc: &LoroDoc) -> LoroTree {
    doc.get_tree(TREE_ROOT)
}

fn children(tree: &LoroTree, parent: Option<TreeID>) -> Vec<TreeID> {
    let parent: TreeParentId = parent.into();
    tree.children(parent).unwrap_or_default()
}

/// One node's value `{nodeName, attributes, children}`: a text block's
/// children are its inline content, a container's its child blocks.
fn node_value(tree: &LoroTree, id: TreeID) -> LoroValue {
    let meta = tree.get_meta(id).map(|m| m.get_deep_value()).unwrap_or(LoroValue::Null);
    let LoroValue::Map(meta) = meta else { return LoroValue::Null };
    let mut out = std::collections::HashMap::new();
    out.insert(NODE_NAME.to_owned(), meta.get(NODE_NAME).cloned().unwrap_or(LoroValue::Null));
    out.insert(ATTRIBUTES.to_owned(), meta.get(ATTRIBUTES).cloned().unwrap_or_else(|| LoroValue::Map(Default::default())));
    let kids = match meta.get(CHILDREN) {
        Some(LoroValue::List(inline)) => LoroValue::List(inline.clone()),
        _ => LoroValue::List(children(tree, Some(id)).into_iter().map(|c| node_value(tree, c)).collect::<Vec<_>>().into()),
    };
    out.insert(CHILDREN.to_owned(), kids);
    LoroValue::Map(out.into())
}

/// The whole body as one value tree `{nodeName: "doc", attributes,
/// children}`, the shape layout 2 stored, for readers that walk values.
pub fn body_value(doc: &LoroDoc) -> LoroValue {
    let tree = tree(doc);
    let mut out = std::collections::HashMap::new();
    out.insert(NODE_NAME.to_owned(), LoroValue::String("doc".into()));
    out.insert(ATTRIBUTES.to_owned(), LoroValue::Map(Default::default()));
    out.insert(CHILDREN.to_owned(), LoroValue::List(children(&tree, None).into_iter().map(|c| node_value(&tree, c)).collect::<Vec<_>>().into()));
    LoroValue::Map(out.into())
}

/// A line of a body as a read-only view draws it (the journal's days without
/// an editor): its outline depth, as in `summarize(..).text`, and its parts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub depth: usize,
    pub parts: Vec<Part>,
}

/// Text, or an inline node: a card link (`card`, the title it was made
/// with), a block reference (`block`), a #tag (`tag`), or text linked to a
/// web address (`href`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

const LISTS: [&str; 3] = ["bulletList", "orderedList", "taskList"];

/// The body's lines with their links: one per text block, as
/// `summarize(..).text` has them (a line holding only a block reference,
/// empty there, is kept here).
pub fn lines(doc: &LoroDoc) -> Vec<Line> {
    fn walk(tree: &LoroTree, parent: Option<TreeID>, lists: usize, out: &mut Vec<Line>) {
        for id in children(tree, parent) {
            let Ok(meta) = tree.get_meta(id) else { continue };
            let name = match meta.get(NODE_NAME) {
                Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
                _ => String::new(),
            };
            if name == "table" {
                // A line per row, its cells side by side.
                for row in children(tree, Some(id)) {
                    let mut parts: Vec<Part> = Vec::new();
                    for (i, cell) in children(tree, Some(row)).into_iter().enumerate() {
                        if i > 0 {
                            parts.push(Part { text: " | ".into(), ..Default::default() });
                        }
                        let mut lines = Vec::new();
                        walk(tree, Some(cell), 1, &mut lines);
                        for (j, line) in lines.into_iter().enumerate() {
                            if j > 0 {
                                parts.push(Part { text: " ".into(), ..Default::default() });
                            }
                            parts.extend(line.parts);
                        }
                    }
                    if parts.iter().any(|p| !p.text.trim_matches([' ', '|']).is_empty() || p.block.is_some() || p.card.is_some()) {
                        out.push(Line { depth: lists.saturating_sub(1), parts });
                    }
                }
                continue;
            }
            match meta.get(CHILDREN) {
                Some(ValueOrContainer::Container(Container::MovableList(inline))) => {
                    let parts = inline_parts(&inline);
                    if parts.iter().any(|p| !p.text.is_empty() || p.block.is_some()) {
                        out.push(Line { depth: lists.saturating_sub(1), parts });
                    }
                }
                _ => walk(tree, Some(id), lists + usize::from(LISTS.contains(&name.as_str())), out),
            }
        }
    }
    let mut out = Vec::new();
    walk(&tree(doc), None, 0, &mut out);
    out
}

fn inline_parts(inline: &LoroMovableList) -> Vec<Part> {
    let mut parts: Vec<Part> = Vec::new();
    let mut push = |part: Part| match parts.last_mut() {
        // Runs differing only in styles the view does not draw are one part.
        Some(last) if part.card.is_none() && part.block.is_none() && part.tag.is_none() && last.card.is_none()
            && last.block.is_none() && last.tag.is_none() && last.href == part.href =>
        {
            last.text.push_str(&part.text)
        }
        _ => parts.push(part),
    };
    for i in 0..inline.len() {
        match inline.get(i) {
            Some(ValueOrContainer::Container(Container::Text(text))) => {
                for d in text.to_delta() {
                    let loro::TextDelta::Insert { insert, attributes } = d else { continue };
                    let href = attributes.as_ref().and_then(|a| match a.get("link") {
                        Some(LoroValue::Map(m)) => match m.get("href") {
                            Some(LoroValue::String(h)) if !h.is_empty() => Some(h.to_string()),
                            _ => None,
                        },
                        _ => None,
                    });
                    push(Part { text: insert, href, ..Default::default() });
                }
            }
            Some(ValueOrContainer::Value(LoroValue::String(s))) => push(Part { text: s.to_string(), ..Default::default() }),
            Some(ValueOrContainer::Container(Container::Map(node))) => {
                let LoroValue::Map(v) = node.get_deep_value() else { continue };
                let attr = |k: &str| match v.get(ATTRIBUTES) {
                    Some(LoroValue::Map(a)) => match a.get(k) {
                        Some(LoroValue::String(s)) => s.to_string(),
                        _ => String::new(),
                    },
                    _ => String::new(),
                };
                let name = match v.get(NODE_NAME) {
                    Some(LoroValue::String(s)) => s.to_string(),
                    _ => String::new(),
                };
                match name.as_str() {
                    "cardLink" => push(Part { text: attr("title"), card: Some(attr("cardId")), ..Default::default() }),
                    "blockRef" => push(Part { block: Some(attr("bid")), ..Default::default() }),
                    "tag" => {
                        let tag = attr("name");
                        push(Part { text: format!("#{tag}"), tag: Some(tag), ..Default::default() })
                    }
                    "hardBreak" => push(Part { text: " ".into(), ..Default::default() }),
                    "inlineMath" => push(Part { text: attr("latex"), ..Default::default() }),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    parts
}

/// Adds a block at the end of `parent`'s children (the top level for None).
pub fn add_block(doc: &LoroDoc, parent: Option<TreeID>, name: &str, attrs: &[(&str, LoroValue)]) -> LoroResult<TreeID> {
    let tree = tree(doc);
    let parent: TreeParentId = parent.into();
    let id = tree.create(parent)?;
    let meta = tree.get_meta(id)?;
    meta.insert(NODE_NAME, name)?;
    let a = meta.ensure_mergeable_map(ATTRIBUTES)?;
    for (k, v) in attrs {
        a.insert(k, v.clone())?;
    }
    if TEXTBLOCKS.contains(&name) {
        meta.ensure_mergeable_movable_list(CHILDREN)?;
    }
    Ok(id)
}

/// A text block's inline content.
pub fn inline(doc: &LoroDoc, block: TreeID) -> LoroResult<LoroMovableList> {
    tree(doc).get_meta(block)?.ensure_mergeable_movable_list(CHILDREN)
}

/// Appends text to a text block.
pub fn push_text(doc: &LoroDoc, block: TreeID, text: &str) -> LoroResult<()> {
    let list = inline(doc, block)?;
    list.insert_container(list.len(), LoroText::new())?.insert(0, text)?;
    Ok(())
}

/// Appends an inline node (card link, tag, …) to a text block.
pub fn push_inline(doc: &LoroDoc, block: TreeID, name: &str, attrs: &[(&str, &str)]) -> LoroResult<()> {
    let list = inline(doc, block)?;
    let node = list.insert_container(list.len(), LoroMap::new())?;
    node.insert(NODE_NAME, name)?;
    let a = node.ensure_mergeable_map(ATTRIBUTES)?;
    for (k, v) in attrs {
        a.insert(k, *v)?;
    }
    node.ensure_mergeable_movable_list(CHILDREN)?;
    Ok(())
}

// ---- migration from layout 2 ----

/// A layout-2 node's children, plain or movable list.
fn legacy_children(node: &LoroMap) -> Vec<ValueOrContainer> {
    match node.get(CHILDREN) {
        Some(ValueOrContainer::Container(Container::MovableList(l))) => (0..l.len()).filter_map(|i| l.get(i)).collect(),
        Some(ValueOrContainer::Container(Container::List(l))) => (0..l.len()).filter_map(|i| l.get(i)).collect(),
        _ => Vec::new(),
    }
}

fn map_entries(map: &LoroMap) -> Vec<(String, LoroValue)> {
    let mut out = Vec::new();
    map.for_each(|k, v| {
        if let ValueOrContainer::Value(v) = v {
            out.push((k.to_string(), v));
        }
    });
    out
}

fn copy_attributes(from: &LoroMap, to: &LoroMap) -> LoroResult<()> {
    if let Some(ValueOrContainer::Container(Container::Map(a))) = from.get(ATTRIBUTES) {
        let dest = to.ensure_mergeable_map(ATTRIBUTES)?;
        for (k, v) in map_entries(&a) {
            dest.insert(&k, v)?;
        }
    } else {
        to.ensure_mergeable_map(ATTRIBUTES)?;
    }
    Ok(())
}

/// Copies a layout-2 inline item (a text or an inline node) to `list`.
fn copy_inline(item: &ValueOrContainer, list: &LoroMovableList) -> LoroResult<()> {
    match item {
        ValueOrContainer::Container(Container::Text(t)) => {
            list.insert_container(list.len(), LoroText::new())?.apply_delta(&t.to_delta())?;
        }
        ValueOrContainer::Container(Container::Map(m)) => {
            let node = list.insert_container(list.len(), LoroMap::new())?;
            if let Some(ValueOrContainer::Value(name)) = m.get(NODE_NAME) {
                node.insert(NODE_NAME, name)?;
            }
            copy_attributes(m, &node)?;
            let kids = node.ensure_mergeable_movable_list(CHILDREN)?;
            for k in legacy_children(m) {
                copy_inline(&k, &kids)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Copies a layout-2 block into the tree, at `index` among `parent`'s
/// children (the end for None).
fn copy_block(tree: &LoroTree, node: &LoroMap, parent: Option<TreeID>, index: Option<usize>) -> LoroResult<()> {
    let name = match node.get(NODE_NAME) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => return Ok(()),
    };
    let parent_id: TreeParentId = parent.into();
    let id = match index {
        Some(i) => tree.create_at(parent_id, i)?,
        None => tree.create(parent_id)?,
    };
    let meta = tree.get_meta(id)?;
    meta.insert(NODE_NAME, name.as_str())?;
    copy_attributes(node, &meta)?;
    if TEXTBLOCKS.contains(&name.as_str()) {
        let list = meta.ensure_mergeable_movable_list(CHILDREN)?;
        for item in legacy_children(node) {
            copy_inline(&item, &list)?;
        }
    } else {
        for item in legacy_children(node) {
            if let ValueOrContainer::Container(Container::Map(child)) = item {
                copy_block(tree, &child, Some(id), None)?;
            }
        }
    }
    Ok(())
}

/// True for a block with nothing in it: no text, no image or rule, no
/// inline node (an editor's starter line).
fn is_blank(value: &LoroValue) -> bool {
    match value {
        LoroValue::String(s) => s.trim().is_empty(),
        LoroValue::List(items) => items.iter().all(is_blank),
        LoroValue::Map(m) => {
            let name = match m.get(NODE_NAME) {
                Some(LoroValue::String(n)) => n.to_string(),
                _ => String::new(),
            };
            let structural = TEXTBLOCKS.contains(&name.as_str()) || ["bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote"].contains(&name.as_str());
            structural && m.get(CHILDREN).is_none_or(is_blank)
        }
        _ => true,
    }
}

/// Moves a layout-2 body (the `body` map) into the layout-3 tree, keeping
/// every block, attribute (block ids included), text and text style, then
/// empties the old root. False when there was nothing to migrate.
///
/// Blocks already in the tree stay, after the migrated ones: an editor of
/// layout 3 may have written there before the migration ran (it showed the
/// old card as empty). Blank starter lines it added are dropped.
///
/// Like the layout 1 → 2 migration, it must not run on two devices for the
/// same document (each would copy the blocks); it runs in `folio-store` on
/// open, before sync exists (M3).
pub fn migrate_to_tree(doc: &LoroDoc) -> LoroResult<bool> {
    let old = doc.get_map(BODY_ROOT);
    let blocks = legacy_children(&old);
    if blocks.is_empty() {
        return Ok(false);
    }
    configure_text_styles(doc);
    let tree = tree(doc);
    for root in children(&tree, None) {
        if is_blank(&node_value(&tree, root)) {
            tree.delete(root)?;
        }
    }
    let mut at = 0;
    for b in &blocks {
        if let ValueOrContainer::Container(Container::Map(node)) = b {
            copy_block(&tree, node, None, Some(at))?;
            at += 1;
        }
    }
    old.clear()?;
    doc.commit();
    Ok(true)
}
