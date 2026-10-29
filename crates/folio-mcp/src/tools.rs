//! The read-only tools (design/ARCHITECTURE.md §0.3): search, read a card
//! or journal day as Markdown, backlinks, recent cards, topics. Answers are text
//! for the model to read; ids are included so it can follow up.

use std::collections::HashSet;

use folio_core::workspace::{topics, Topic};
use folio_core::DocId;
use folio_io::{body_markdown, Links};
use folio_store::{Store, StoreError};
use serde_json::{json, Value};

pub fn list() -> Value {
    json!([
        {
            "name": "search",
            "title": "Search notes",
            "description": "Search card titles and the text of every card and journal day. Returns matching cards and blocks with their card ids.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to find. Works for Chinese and English." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
                },
                "required": ["query"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_card",
            "title": "Read a card",
            "description": "A card's full content as Markdown, by id or exact title. Journal days have ids like journal:2026-10-24.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string", "description": "Exact title, if the id is not known." }
                }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_journal",
            "title": "Read a journal day",
            "description": "One day of the journal as Markdown.",
            "inputSchema": {
                "type": "object",
                "properties": { "date": { "type": "string", "description": "YYYY-MM-DD" } },
                "required": ["date"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_backlinks",
            "title": "Backlinks of a card",
            "description": "Blocks in other cards and journal days that link to this card or reference its blocks.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_tags",
            "title": "Tags",
            "description": "The #tags in use, most recently used first, with how many blocks and cards have each.",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 } }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "find_by_tag",
            "title": "Blocks with a tag",
            "description": "Blocks tagged #tag (matched without regard to case), with their card ids.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tag": { "type": "string", "description": "Tag name, with or without #." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
                },
                "required": ["tag"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_recent_cards",
            "title": "Recently edited cards",
            "description": "Cards (not journal days) by last edit, newest first.",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 } }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_topics",
            "title": "Topics",
            "description": "The topics cards are filed under, with their sub-topics (two levels) and how many cards each has (a topic's count includes its sub-topics', each card once).",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "topic_cards",
            "title": "Cards in a topic",
            "description": "The cards filed under a topic, newest edit first, with ids. By default a topic's sub-topics' cards are included and marked with the sub-topic they are in.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "Topic id, name, or path as “Parent › Name”." },
                    "include_subtopics": { "type": "boolean", "default": true },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
                },
                "required": ["topic"]
            },
            "annotations": { "readOnlyHint": true }
        }
    ])
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_limit(args: &Value, default: u32, max: u32) -> u32 {
    args.get("limit").and_then(Value::as_u64).map(|n| n.clamp(1, max as u64) as u32).unwrap_or(default)
}

fn title_or(title: &str, id: &str) -> String {
    if !title.is_empty() {
        title.to_owned()
    } else if let Some(date) = id.strip_prefix("journal:") {
        format!("Journal {date}")
    } else {
        "Untitled".to_owned()
    }
}

/// A card as Markdown with a short header; None when there is no such card.
fn card_markdown(store: &mut Store, id: &DocId) -> Result<Option<String>, String> {
    let Some(row) = store.live_cards().map_err(|e| e.to_string())?.into_iter().find(|c| c.id == id.as_str()) else {
        return Ok(None);
    };
    let doc = store.doc_copy(id).map_err(|e| e.to_string())?;
    let store = &*store;
    let card_title = |cid: &str| store.titles(&[cid.to_owned()]).ok().and_then(|t| t.into_iter().next()).map(|(_, t)| t);
    let block_text = |bid: &str| store.block_texts(&[bid.to_owned()]).ok().and_then(|b| b.into_iter().next()).map(|b| b.text);
    let body = body_markdown(&doc, &Links { card_title: &card_title, block_text: &block_text, file: &|_, _| None });
    Ok(Some(format!("# {}\n\nid: {}\n\n{}", title_or(&row.title, &row.id), row.id, if body.is_empty() { "(empty)\n".into() } else { body })))
}

/// The library's topics; none before the first one is made.
fn library_topics(store: &mut Store) -> Result<Vec<Topic>, String> {
    match store.doc_copy(&DocId::workspace()) {
        Ok(doc) => Ok(topics(&doc)),
        Err(StoreError::NotFound(_)) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// "Parent › Name" for a sub-topic, the name for one at the top.
fn topic_path(all: &[Topic], t: &Topic) -> String {
    match t.parent.as_ref().and_then(|p| all.iter().find(|x| &x.id == p)) {
        Some(p) => format!("{} › {}", p.name, t.name),
        None => t.name.clone(),
    }
}

/// A topic by id, path ("›", ">" or "/" between the names) or name.
fn find_topic<'a>(all: &'a [Topic], query: &str) -> Result<&'a Topic, String> {
    if let Some(t) = all.iter().find(|t| t.id == query) {
        return Ok(t);
    }
    let norm = |s: &str| s.split(['›', '>', '/']).map(|p| p.trim().to_lowercase()).collect::<Vec<_>>().join(" › ");
    let q = norm(query);
    if let Some(t) = all.iter().find(|t| norm(&topic_path(all, t)) == q) {
        return Ok(t);
    }
    let named: Vec<&Topic> = all.iter().filter(|t| t.name.to_lowercase() == q).collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("No topic “{query}”. Try list_topics.")),
        many => Err(format!(
            "Several topics are named “{query}”: {}. Give the path or the id.",
            many.iter().map(|t| format!("“{}” (id {})", topic_path(all, t), t.id)).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Runs a tool; Err is shown to the model as a tool error.
pub fn call(store: &mut Store, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "search" => {
            let query = arg_str(args, "query").ok_or("query is required")?;
            let hits = store.search(query, arg_limit(args, 20, 100)).map_err(|e| e.to_string())?;
            if hits.is_empty() {
                return Ok(format!("Nothing found for “{query}”."));
            }
            Ok(hits
                .iter()
                .map(|h| match &h.bid {
                    None => format!("- card “{}” (id {})", title_or(&h.card_title, &h.card_id), h.card_id),
                    Some(_) => format!("- in “{}” (id {}): {}", title_or(&h.card_title, &h.card_id), h.card_id, h.text),
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "read_card" => {
            let id = match (arg_str(args, "id"), arg_str(args, "title")) {
                (Some(id), _) => DocId::parse(id).map_err(|e| e.to_string())?,
                (None, Some(title)) => {
                    let lower = title.to_lowercase();
                    let row = store
                        .live_cards()
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .find(|c| c.title.to_lowercase() == lower)
                        .ok_or_else(|| format!("No card titled “{title}”. Try search."))?;
                    DocId::parse(&row.id).map_err(|e| e.to_string())?
                }
                (None, None) => return Err("id or title is required".into()),
            };
            card_markdown(store, &id)?.ok_or_else(|| format!("No card with id {id}."))
        }
        "read_journal" => {
            let date = arg_str(args, "date").ok_or("date is required")?;
            let id = DocId::parse(&format!("journal:{date}")).map_err(|_| "date must be YYYY-MM-DD".to_owned())?;
            Ok(card_markdown(store, &id)?.unwrap_or_else(|| format!("Nothing written on {date}.")))
        }
        "get_backlinks" => {
            let id = DocId::parse(arg_str(args, "id").ok_or("id is required")?).map_err(|e| e.to_string())?;
            let links = store.backlinks(&id).map_err(|e| e.to_string())?;
            if links.is_empty() {
                return Ok("No backlinks.".into());
            }
            Ok(links
                .iter()
                .map(|b| {
                    let via = if b.via == "ref" { "references a block" } else { "links" };
                    format!("- “{}” (id {}) {via}: {}", title_or(&b.card_title, &b.card_id), b.card_id, b.text)
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_tags" => {
            let tags = store.tags(arg_limit(args, 100, 500)).map_err(|e| e.to_string())?;
            if tags.is_empty() {
                return Ok("No tags yet.".into());
            }
            Ok(tags.iter().map(|t| format!("- #{} ({} blocks in {} cards)", t.name, t.blocks, t.cards)).collect::<Vec<_>>().join("\n"))
        }
        "find_by_tag" => {
            let tag = arg_str(args, "tag").ok_or("tag is required")?.trim_start_matches('#');
            let rows = store.tagged(tag, arg_limit(args, 50, 200)).map_err(|e| e.to_string())?;
            if rows.is_empty() {
                return Ok(format!("Nothing is tagged #{tag}."));
            }
            Ok(rows
                .iter()
                .map(|r| format!("- in “{}” (id {}): {}", title_or(&r.card_title, &r.card_id), r.card_id, r.text))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_recent_cards" => {
            let cards = store.list_cards(arg_limit(args, 20, 200)).map_err(|e| e.to_string())?;
            if cards.is_empty() {
                return Ok("No cards yet.".into());
            }
            Ok(cards
                .iter()
                .map(|c| format!("- “{}” (id {}){}", title_or(&c.title, &c.id), c.id, if c.preview.is_empty() { String::new() } else { format!(": {}", c.preview) }))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_topics" => {
            let all = library_topics(store)?;
            if all.is_empty() {
                return Ok("No topics yet.".into());
            }
            let pairs = store.card_topic_pairs().map_err(|e| e.to_string())?;
            let cards_in = |ids: &[&str]| pairs.iter().filter(|(_, t)| ids.contains(&t.as_str())).map(|(c, _)| c.as_str()).collect::<HashSet<_>>().len();
            let mut lines = Vec::new();
            for top in all.iter().filter(|t| t.parent.is_none()) {
                let subs: Vec<&Topic> = all.iter().filter(|t| t.parent.as_ref() == Some(&top.id)).collect();
                let mut ids = vec![top.id.as_str()];
                ids.extend(subs.iter().map(|t| t.id.as_str()));
                lines.push(format!("- {} (id {}, {} cards)", top.name, top.id, cards_in(&ids)));
                for sub in subs {
                    lines.push(format!("  - {} (id {}, {} cards)", sub.name, sub.id, cards_in(&[sub.id.as_str()])));
                }
            }
            Ok(lines.join("\n"))
        }
        "topic_cards" => {
            let all = library_topics(store)?;
            let topic = find_topic(&all, arg_str(args, "topic").ok_or("topic is required")?)?;
            let with_subs = args.get("include_subtopics").and_then(Value::as_bool).unwrap_or(true);
            let mut sources = vec![(topic, None)];
            if with_subs {
                sources.extend(all.iter().filter(|t| t.parent.as_ref() == Some(&topic.id)).map(|t| (t, Some(t.name.as_str()))));
            }
            let mut rows = Vec::new();
            let mut seen = HashSet::new();
            for (t, sub) in sources {
                for c in store.topic_cards(&t.id).map_err(|e| e.to_string())? {
                    if seen.insert(c.id.clone()) {
                        rows.push((c, sub));
                    }
                }
            }
            let path = topic_path(&all, topic);
            if rows.is_empty() {
                return Ok(format!("No cards in “{path}”."));
            }
            rows.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
            rows.truncate(arg_limit(args, 100, 500) as usize);
            let mut out = vec![format!("Cards in “{path}”{}:", if with_subs { ", sub-topics included" } else { "" })];
            out.extend(rows.iter().map(|(c, sub)| {
                let place = sub.map(|s| format!(" [in {s}]")).unwrap_or_default();
                format!("- “{}” (id {}){place}", title_or(&c.title, &c.id), c.id)
            }));
            Ok(out.join("\n"))
        }
        _ => Err(format!("unknown tool {name}")),
    }
}
