//! Anthropic's Messages API, streamed.

use std::io::BufRead;

use serde_json::{json, Map, Value};

use crate::{parse_input, sse, AiError, Event, Message, Part, Protocol, Provider, Raw, Reply, Result, Stop, Tool};

pub const VERSION: &str = "2026-10-21";

/// Models that take the server-side fallback on a refusal (`fallbacks`),
/// on Anthropic's own API.
fn takes_fallbacks(provider: &Provider) -> bool {
    provider.base_url.contains("api.anthropic.com")
        && ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"].contains(&provider.model.as_str())
}

pub fn request(provider: &Provider, system: &str, messages: &[Message], tools: &[Tool]) -> (String, Vec<(&'static str, String)>, Value) {
    let mut body = json!({
        "model": provider.model,
        "max_tokens": 64000,
        "stream": true,
        "system": system,
        "messages": messages.iter().filter_map(message).collect::<Vec<_>>(),
        // The conversation so far is read from the cache on the next turn.
        "cache_control": { "type": "ephemeral" },
    });
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema, "eager_input_streaming": true }))
            .collect();
    }
    if let Some(effort) = provider.effort.as_deref().filter(|e| !e.is_empty()) {
        body["output_config"] = json!({ "effort": effort });
    }
    let mut headers = vec![("anthropic-version", VERSION.to_owned())];
    if let Some(key) = &provider.key {
        headers.push(("x-api-key", key.clone()));
    }
    if takes_fallbacks(provider) {
        headers.push(("anthropic-beta", "server-side-fallback-2026-07-01".to_owned()));
        body["fallbacks"] = json!("default");
    }
    (format!("{}/messages", provider.base_url.trim_end_matches('/')), headers, body)
}

fn message(m: &Message) -> Option<Value> {
    match m {
        Message::User { text } => Some(json!({ "role": "user", "content": text })),
        Message::Assistant { raw: Some(Raw { protocol: Protocol::Anthropic, content }), .. } if content.as_array().is_some_and(|a| !a.is_empty()) => {
            Some(json!({ "role": "assistant", "content": content }))
        }
        Message::Assistant { parts, .. } => {
            let content: Vec<Value> = parts
                .iter()
                .filter_map(|p| match p {
                    Part::Text { text } if text.is_empty() => None,
                    Part::Text { text } => Some(json!({ "type": "text", "text": text })),
                    Part::Tool { id, name, input, .. } => Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input })),
                })
                .collect();
            (!content.is_empty()).then(|| json!({ "role": "assistant", "content": content }))
        }
        Message::Tools { results } => Some(json!({
            "role": "user",
            "content": results.iter().map(|r| json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error })).collect::<Vec<_>>(),
        })),
    }
}

/// A content block as it streams in.
struct Block {
    value: Map<String, Value>,
    /// A tool call's arguments, in pieces.
    json: String,
}

pub fn read(reader: impl BufRead, events: &mut dyn FnMut(Event), cancelled: &dyn Fn() -> bool) -> Result<Reply> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut stop = None;
    let (mut input_tokens, mut output_tokens) = (0, 0);
    let finished = sse::each(reader, cancelled, |data| {
        let v: Value = serde_json::from_str(data).map_err(|e| AiError::Protocol(e.to_string()))?;
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                let usage = &v["message"]["usage"];
                input_tokens = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].iter().filter_map(|k| usage[k].as_u64()).sum();
            }
            "content_block_start" => {
                let value = v["content_block"].as_object().cloned().unwrap_or_default();
                if value.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let (id, name) = (value["id"].as_str().unwrap_or("").to_owned(), value["name"].as_str().unwrap_or("").to_owned());
                    events(Event::Tool { id, name });
                }
                blocks.push(Block { value, json: String::new() });
            }
            "content_block_delta" => {
                let at = v["index"].as_u64().map(|i| i as usize).unwrap_or(blocks.len().saturating_sub(1));
                let Some(block) = blocks.get_mut(at) else { return Ok(true) };
                let d = &v["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let piece = d["text"].as_str().unwrap_or("");
                        append(&mut block.value, "text", piece);
                        events(Event::Text { text: piece.to_owned() });
                    }
                    "input_json_delta" => block.json.push_str(d["partial_json"].as_str().unwrap_or("")),
                    "thinking_delta" => append(&mut block.value, "thinking", d["thinking"].as_str().unwrap_or("")),
                    "signature_delta" => {
                        block.value.insert("signature".into(), d["signature"].clone());
                    }
                    "citations_delta" => {
                        if let Some(list) = block.value.entry("citations").or_insert_with(|| json!([])).as_array_mut() {
                            list.push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    stop = Some(s.to_owned());
                }
                if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                    output_tokens = n;
                }
            }
            "message_stop" => return Ok(false),
            "error" => {
                return Err(AiError::Api { status: 0, message: v.pointer("/error/message").and_then(Value::as_str).unwrap_or("error").to_owned() });
            }
            _ => {}
        }
        Ok(true)
    })?;

    let mut parts = Vec::new();
    let mut raw = Vec::new();
    for Block { mut value, json } in blocks {
        match value.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(Part::Text { text: value["text"].as_str().unwrap_or("").to_owned() }),
            Some("tool_use") => {
                let (input, invalid) = match parse_input(&json) {
                    Ok(v) => (v, None),
                    Err(bad) => (json!({}), Some(bad)),
                };
                value.insert("input".into(), input.clone());
                parts.push(Part::Tool { id: value["id"].as_str().unwrap_or("").to_owned(), name: value["name"].as_str().unwrap_or("").to_owned(), input, invalid });
            }
            _ => {}
        }
        raw.push(Value::Object(value));
    }
    let stop = if !finished {
        Stop::Cancelled
    } else {
        match stop.as_deref() {
            Some("end_turn") | Some("stop_sequence") | None => Stop::End,
            Some("tool_use") => Stop::ToolUse,
            Some("max_tokens") => Stop::MaxTokens,
            Some("refusal") => Stop::Refusal,
            Some(other) => Stop::Other(other.to_owned()),
        }
    };
    // A stopped turn's blocks may be cut short; they are not sent back.
    let raw = (stop != Stop::Cancelled).then(|| Raw { protocol: Protocol::Anthropic, content: Value::Array(raw) });
    Ok(Reply { parts, raw, stop, input_tokens, output_tokens })
}

fn append(block: &mut Map<String, Value>, key: &str, piece: &str) {
    let mut s = block.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    s.push_str(piece);
    block.insert(key.into(), Value::String(s));
}
