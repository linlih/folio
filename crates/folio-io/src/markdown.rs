//! A card body as Markdown (design/ARCHITECTURE.md §5.5): for export, and
//! for the MCP server's `read_card`. Written for people and for other
//! Markdown apps (Obsidian, Logseq), so links are `[[Title]]` and tasks use
//! the common checkbox forms.
//!
//! Reads the Loro containers directly (not plain values), so text keeps its
//! marks: blocks from the body tree (layout 3), inline content from each
//! text block's `children` list.

use loro::{Container, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree, LoroValue, TextDelta, TreeID, TreeParentId, ValueOrContainer};
use folio_core::card::{ATTRIBUTES, CHILDREN, NODE_NAME};

/// What links point at, looked up at render time so they show what cards and
/// blocks say now.
pub struct Links<'a> {
    /// A card's current title.
    pub card_title: &'a dyn Fn(&str) -> Option<String>,
    /// A block's current text.
    pub block_text: &'a dyn Fn(&str) -> Option<String>,
    /// Where an image or attachment (hash, name) is linked from, already
    /// URL-safe; None writes its name alone.
    pub file: &'a dyn Fn(&str, &str) -> Option<String>,
}

impl Links<'_> {
    /// Links shown as their stored text (tests, no index at hand).
    pub const STORED: Links<'static> = Links { card_title: &|_| None, block_text: &|_| None, file: &|_, _| None };
}

/// A path as a Markdown link target: characters that would end or confuse
/// the link are percent-encoded.
pub fn link_target(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c => out.push(c),
        }
    }
    out
}

/// One child of a node: a nested node, or a run of text.
enum Child {
    Node(LoroMap),
    Text(LoroText),
}

/// A text block's (or inline node's) inline content.
fn children(node: &LoroMap) -> Vec<Child> {
    let Some(ValueOrContainer::Container(Container::MovableList(list))) = node.get(CHILDREN) else { return Vec::new() };
    list_children(&list)
}

fn list_children(list: &LoroMovableList) -> Vec<Child> {
    (0..list.len())
        .filter_map(|i| match list.get(i) {
            Some(ValueOrContainer::Container(Container::Map(m))) => Some(Child::Node(m)),
            Some(ValueOrContainer::Container(Container::Text(t))) => Some(Child::Text(t)),
            _ => None,
        })
        .collect()
}

/// A block: its tree node and metadata map.
type Block = (TreeID, LoroMap);

/// The child blocks of `parent` (the top level for None), in order.
fn block_children(tree: &LoroTree, parent: Option<TreeID>) -> Vec<Block> {
    let parent: TreeParentId = parent.into();
    tree.children(parent)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|id| tree.get_meta(id).ok().map(|m| (id, m)))
        .collect()
}

fn name(node: &LoroMap) -> String {
    match node.get(NODE_NAME) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    }
}

fn attr(node: &LoroMap, key: &str) -> Option<LoroValue> {
    let Some(ValueOrContainer::Container(Container::Map(attrs))) = node.get(ATTRIBUTES) else { return None };
    match attrs.get(key) {
        Some(ValueOrContainer::Value(LoroValue::Null)) | None => None,
        Some(ValueOrContainer::Value(v)) => Some(v),
        _ => None,
    }
}

fn attr_str(node: &LoroMap, key: &str) -> Option<String> {
    match attr(node, key)? {
        LoroValue::String(s) if !s.is_empty() => Some(s.to_string()),
        LoroValue::I64(n) => Some(n.to_string()),
        LoroValue::Double(n) => Some(n.to_string()),
        _ => None,
    }
}

fn attr_bool(node: &LoroMap, key: &str) -> bool {
    matches!(attr(node, key), Some(LoroValue::Bool(true)))
}

const LISTS: [&str; 3] = ["bulletList", "orderedList", "taskList"];
const ITEMS: [&str; 2] = ["listItem", "taskItem"];

/// Characters Markdown would read as syntax at the start of a line or
/// around text.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Text with its marks, as Markdown.
fn text_markdown(text: &LoroText) -> String {
    let mut out = String::new();
    for delta in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = delta else { continue };
        let attrs = attributes.unwrap_or_default();
        let has = |k: &str| attrs.get(k).is_some_and(|v| !matches!(v, LoroValue::Null | LoroValue::Bool(false)));
        if has("code") {
            let fence = if insert.contains('`') { "``" } else { "`" };
            let mut s = format!("{fence}{insert}{fence}");
            if let Some(LoroValue::Map(link)) = attrs.get("link") {
                if let Some(LoroValue::String(href)) = link.get("href") {
                    s = format!("[{s}]({})", href.as_str());
                }
            }
            out.push_str(&s);
            continue;
        }
        // Marks wrap the text, not the spaces around it.
        let core = insert.trim();
        if core.is_empty() {
            out.push_str(&insert);
            continue;
        }
        let lead = &insert[..insert.len() - insert.trim_start().len()];
        let trail = &insert[insert.trim_end().len()..];
        let mut s = escape(core);
        if has("bold") {
            s = format!("**{s}**");
        }
        if has("italic") {
            s = format!("*{s}*");
        }
        if has("strike") {
            s = format!("~~{s}~~");
        }
        if has("underline") {
            s = format!("<u>{s}</u>");
        }
        if let Some(LoroValue::Map(link)) = attrs.get("link") {
            if let Some(LoroValue::String(href)) = link.get("href") {
                s = format!("[{s}]({})", href.as_str());
            }
        }
        out.push_str(lead);
        out.push_str(&s);
        out.push_str(trail);
    }
    out
}

/// A text block's inline content: text runs and inline nodes.
fn inline_markdown(node: &LoroMap, links: &Links) -> String {
    let mut out = String::new();
    for child in children(node) {
        match child {
            Child::Text(t) => out.push_str(&text_markdown(&t)),
            Child::Node(n) => match name(&n).as_str() {
                "cardLink" => {
                    let id = attr_str(&n, "cardId").unwrap_or_default();
                    let title = (links.card_title)(&id).or_else(|| attr_str(&n, "title")).unwrap_or(id);
                    out.push_str(&format!("[[{title}]]"));
                }
                "blockRef" => {
                    let bid = attr_str(&n, "bid").unwrap_or_default();
                    match (links.block_text)(&bid) {
                        Some(text) => out.push_str(&format!("“{}”", escape(&text))),
                        None => out.push_str(&format!("(({bid}))")),
                    }
                }
                // Logseq and Obsidian read #tag; a name with spaces needs #[[…]].
                "tag" => {
                    let name = attr_str(&n, "name").unwrap_or_default();
                    if name.contains(char::is_whitespace) {
                        out.push_str(&format!("#[[{name}]]"));
                    } else if !name.is_empty() {
                        out.push_str(&format!("#{name}"));
                    }
                }
                "hardBreak" => out.push_str("<br>"),
                "inlineMath" => out.push_str(&format!("${}$", attr_str(&n, "latex").unwrap_or_default())),
                "image" => out.push_str(&image(&n, links)),
                _ => out.push_str(&inline_markdown(&n, links)),
            },
        }
    }
    out
}

/// An image: its web address, or the library file it shows.
fn image(node: &LoroMap, links: &Links) -> String {
    let alt = attr_str(node, "alt").unwrap_or_default();
    match attr_str(node, "asset") {
        Some(sha256) => {
            let name = attr_str(node, "name").unwrap_or_default();
            let target = (links.file)(&sha256, &name).unwrap_or_else(|| link_target(&name));
            format!("![{}]({target})", escape(if alt.is_empty() { &name } else { &alt }))
        }
        None => format!("![{}]({})", escape(&alt), attr_str(node, "src").unwrap_or_default()),
    }
}

/// An attachment: a link to the file.
fn file(node: &LoroMap, links: &Links) -> String {
    let name = attr_str(node, "name").unwrap_or_default();
    let target = attr_str(node, "asset").and_then(|sha256| (links.file)(&sha256, &name)).unwrap_or_else(|| link_target(&name));
    format!("[{}]({target})", escape(&name))
}

/// Plain text of a code block (marks don't apply inside code).
fn plain_text(node: &LoroMap) -> String {
    children(node)
        .into_iter()
        .map(|c| match c {
            Child::Text(t) => t.to_string(),
            Child::Node(n) if name(&n) == "hardBreak" => "\n".to_owned(),
            Child::Node(n) => plain_text(&n),
        })
        .collect()
}

/// A task's checkbox, as Obsidian (and its Tasks plugin) read it.
fn checkbox(item: &LoroMap) -> &'static str {
    if attr_bool(item, "checked") {
        return "[x] ";
    }
    match attr_str(item, "status").as_deref() {
        Some("doing") => "[/] ",
        Some("canceled") => "[-] ",
        _ => "[ ] ",
    }
}

/// Priority and dates after a block's text (Obsidian Tasks' emoji form).
fn properties(item: &LoroMap) -> String {
    let mut out = String::new();
    match attr_str(item, "priority").as_deref() {
        Some("high") => out.push_str(" ⏫"),
        Some("medium") => out.push_str(" 🔼"),
        Some("low") => out.push_str(" 🔽"),
        _ => {}
    }
    if let Some(d) = attr_str(item, "scheduled") {
        out.push_str(&format!(" ⏳ {d}"));
    }
    if let Some(d) = attr_str(item, "deadline") {
        out.push_str(&format!(" 📅 {d}"));
    }
    out
}

/// Renders block-level nodes, each followed by a blank line at the top level
/// and kept tight inside lists.
fn blocks(tree: &LoroTree, nodes: &[Block], links: &Links, out: &mut Vec<String>) {
    for (id, node) in nodes {
        let kind = name(node);
        match kind.as_str() {
            "paragraph" => out.push(inline_markdown(node, links)),
            "heading" => {
                let level = attr_str(node, "level").and_then(|l| l.parse::<usize>().ok()).unwrap_or(1).clamp(1, 6);
                out.push(format!("{} {}", "#".repeat(level), inline_markdown(node, links)));
            }
            "codeBlock" => {
                let lang = attr_str(node, "language").unwrap_or_default();
                let code = plain_text(node);
                let fence = if code.contains("```") { "````" } else { "```" };
                out.push(format!("{fence}{lang}\n{code}\n{fence}"));
            }
            "blockquote" => {
                let mut inner = Vec::new();
                blocks(tree, &block_children(tree, Some(*id)), links, &mut inner);
                let quoted: Vec<String> = inner.join("\n\n").lines().map(|l| if l.is_empty() { ">".to_owned() } else { format!("> {l}") }).collect();
                out.push(quoted.join("\n"));
            }
            "horizontalRule" => out.push("---".to_owned()),
            "image" => out.push(image(node, links)),
            "file" => out.push(file(node, links)),
            "blockMath" => out.push(format!("$$\n{}\n$$", attr_str(node, "latex").unwrap_or_default())),
            "table" => out.push(table(tree, *id, links)),
            k if LISTS.contains(&k) => out.push(list(tree, *id, node, links)),
            _ => {
                let mut inner = Vec::new();
                blocks(tree, &block_children(tree, Some(*id)), links, &mut inner);
                out.extend(inner);
            }
        }
    }
}

/// A table, as a GitHub (GFM) table: the first row is its header, a cell's
/// lines are joined by `<br>`, and `|` in a cell is escaped.
fn table(tree: &LoroTree, id: TreeID, links: &Links) -> String {
    let rows: Vec<Vec<String>> = block_children(tree, Some(id))
        .into_iter()
        .map(|(row, _)| {
            block_children(tree, Some(row))
                .into_iter()
                .map(|(cell, _)| {
                    let lines: Vec<String> = block_children(tree, Some(cell)).iter().map(|(_, p)| inline_markdown(p, links).replace('\n', "<br>")).collect();
                    lines.join("<br>").replace('|', "\\|")
                })
                .collect()
        })
        .collect();
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let line = |cells: &[String]| {
        let padded: Vec<&str> = (0..cols).map(|i| cells.get(i).map_or("", String::as_str)).collect();
        format!("| {} |", padded.join(" | "))
    };
    let mut out = vec![line(rows.first().map_or(&[][..], Vec::as_slice)), format!("|{}", " --- |".repeat(cols))];
    out.extend(rows.iter().skip(1).map(|r| line(r)));
    out.join("\n")
}

/// A list, with nested lists indented under their item.
fn list(tree: &LoroTree, id: TreeID, node: &LoroMap, links: &Links) -> String {
    let ordered = name(node) == "orderedList";
    let mut lines = Vec::new();
    let mut n = 1;
    for (item_id, item) in block_children(tree, Some(id)) {
        let kind = name(&item);
        if !ITEMS.contains(&kind.as_str()) {
            continue;
        }
        let marker = if ordered { format!("{n}. ") } else { "- ".to_owned() };
        n += 1;
        let indent = " ".repeat(marker.len());
        let task = if kind == "taskItem" { checkbox(&item) } else { "" };
        let mut first = true;
        for part in block_children(tree, Some(item_id)) {
            // A table starts a block of its own: a blank line before it.
            if !first && name(&part.1) == "table" {
                lines.push(String::new());
            }
            let rendered = if LISTS.contains(&name(&part.1).as_str()) {
                list(tree, part.0, &part.1, links)
            } else {
                let mut one = Vec::new();
                blocks(tree, std::slice::from_ref(&part), links, &mut one);
                one.join("\n\n")
            };
            for (i, line) in rendered.lines().enumerate() {
                if first && i == 0 {
                    lines.push(format!("{marker}{task}{line}{}", properties(&item)));
                } else if line.is_empty() {
                    lines.push(String::new());
                } else {
                    lines.push(format!("{indent}{line}"));
                }
            }
            if first && rendered.is_empty() {
                lines.push(format!("{marker}{task}{}", properties(&item).trim_start()).trim_end().to_owned());
            }
            first = false;
        }
        if first {
            lines.push(format!("{marker}{task}").trim_end().to_owned());
        }
    }
    lines.join("\n")
}

/// The body of a card document as Markdown, ending with one newline (empty
/// for an empty body).
pub fn body_markdown(doc: &LoroDoc, links: &Links) -> String {
    let tree = folio_core::body::tree(doc);
    let mut out = Vec::new();
    blocks(&tree, &block_children(&tree, None), links, &mut out);
    let text = out.into_iter().filter(|b| !b.is_empty()).collect::<Vec<_>>().join("\n\n");
    if text.is_empty() {
        text
    } else {
        text + "\n"
    }
}
