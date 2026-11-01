//! The OpenAI-compatible Chat Completions API, streamed: OpenAI, DeepSeek,
//! Qwen, Kimi, Ollama and others.

use std::io::BufRead;

use serde_json::{json, Value};

use crate::{parse_input, sse, AiError, Event, Message, Part, Provider, Reply, Result, Stop, Tool};

pub fn request(provider: &Provider, system: &str, messages: &[Message], tools: &[Tool]) -> (String, Vec<(&'static str, String)>, Value) {
    let mut out = vec![json!({ "role": "system", "content": system })];
    for m in messages {
        match m {
            Message::User { text } => out.push(json!({ "role": "user", "content": text })),
            Message::Assistant { parts, .. } => {
                let text: String = parts.iter().filter_map(|p| if let Part::Text { text } = p { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("");
                let calls: Vec<Value> = parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::Tool { id, name, input, .. } => Some(json!({ "id": id, "type": "function", "function": { "name": name, "arguments": input.to_string() } })),
                        Part::Text { .. } => None,
                    })
                    .collect();
                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                let mut msg = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) } });
                if !calls.is_empty() {
                    msg["tool_calls"] = Value::Array(calls);
                }
                out.push(msg);
            }
            Message::Tools { results } => {
                out.extend(results.iter().map(|r| json!({ "role": "tool", "tool_call_id": r.id, "content": r.content })));
            }
        }
    }
    let mut body = json!({
        "model": provider.model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": out,
    });
    // Reasoning models' effort; sent only when chosen, as not every
    // compatible provider knows it.
    if let Some(effort) = provider.effort.as_deref().filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = json!(effort);
    }
    if !tools.is_empty() {
        body["tools"] = tools.iter().map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } })).collect();
    }
    let headers = provider.key.iter().map(|k| ("authorization", format!("Bearer {k}"))).collect();
    (format!("{}/chat/completions", provider.base_url.trim_end_matches('/')), headers, body)
}

/// A tool call as it streams in, by its index.
#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

pub fn read(reader: impl BufRead, events: &mut dyn FnMut(Event), cancelled: &dyn Fn() -> bool) -> Result<Reply> {
    let mut text = String::new();
    let mut calls: Vec<Call> = Vec::new();
    let mut finish = None;
    let (mut input_tokens, mut output_tokens) = (0, 0);
    let finished = sse::each(reader, cancelled, |data| {
        if data.trim() == "[DONE]" {
            return Ok(false);
        }
        let v: Value = serde_json::from_str(data).map_err(|e| AiError::Protocol(e.to_string()))?;
        if let Some(e) = v.get("error") {
            let message = e.get("message").and_then(Value::as_str).or(e.as_str()).unwrap_or("error").to_owned();
            return Err(AiError::Api { status: 0, message });
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            input_tokens = u["prompt_tokens"].as_u64().unwrap_or(input_tokens);
            output_tokens = u["completion_tokens"].as_u64().unwrap_or(output_tokens);
        }
        let Some(choice) = v["choices"].get(0) else { return Ok(true) };
        let d = &choice["delta"];
        if let Some(piece) = d["content"].as_str().filter(|s| !s.is_empty()) {
            text.push_str(piece);
            events(Event::Text { text: piece.to_owned() });
        }
        for c in d["tool_calls"].as_array().into_iter().flatten() {
            let i = c["index"].as_u64().map(|i| i as usize).unwrap_or(calls.len());
            while calls.len() <= i {
                calls.push(Call::default());
            }
            let call = &mut calls[i];
            if let Some(id) = c["id"].as_str().filter(|s| !s.is_empty()) {
                call.id = id.to_owned();
            }
            if let Some(name) = c["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                call.name.push_str(name);
                events(Event::Tool { id: call.id.clone(), name: call.name.clone() });
            }
            call.arguments.push_str(c["function"]["arguments"].as_str().unwrap_or(""));
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            finish = Some(f.to_owned());
        }
        Ok(true)
    })?;

    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(Part::Text { text });
    }
    for (i, c) in calls.into_iter().enumerate() {
        let (input, invalid) = match parse_input(&c.arguments) {
            Ok(v) => (v, None),
            Err(bad) => (json!({}), Some(bad)),
        };
        // Some servers leave out the id; the result must name one.
        let id = if c.id.is_empty() { format!("call_{i}") } else { c.id };
        parts.push(Part::Tool { id, name: c.name, input, invalid });
    }
    let has_calls = parts.iter().any(|p| matches!(p, Part::Tool { .. }));
    let stop = if !finished {
        Stop::Cancelled
    } else {
        match finish.as_deref() {
            Some("tool_calls") | Some("function_call") => Stop::ToolUse,
            Some("length") => Stop::MaxTokens,
            Some("content_filter") => Stop::Refusal,
            // Some servers say "stop" after tool calls.
            _ if has_calls => Stop::ToolUse,
            Some("stop") | None => Stop::End,
            Some(other) => Stop::Other(other.to_owned()),
        }
    };
    Ok(Reply { parts, raw: None, stop, input_tokens, output_tokens })
}
