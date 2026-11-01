use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use serde_json::{json, Value};

use super::*;

/// A server for one request: answers `status` with `body` as an event
/// stream and hands back the request it got (headers, then the body).
fn serve(status: u16, body: String) -> (String, mpsc::Receiver<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(n) = line.to_lowercase().strip_prefix("content-length:") {
                length = n.trim().parse().unwrap();
            }
            head.push_str(&line);
        }
        let mut buf = vec![0; length];
        reader.read_exact(&mut buf).unwrap();
        let _ = tx.send((head, serde_json::from_slice(&buf).unwrap_or(Value::Null)));
        let kind = if status == 200 && !body.starts_with('{') { "text/event-stream" } else { "application/json" };
        write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    (url, rx)
}

fn events(list: &[Value]) -> String {
    list.iter().map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap_or("x"))).collect()
}

fn provider(protocol: Protocol, url: String) -> Provider {
    Provider { protocol, base_url: url, model: "m".into(), key: Some("k-123".into()), effort: Some("medium".into()) }
}

fn tools() -> Vec<Tool> {
    vec![Tool { name: "search".into(), description: "Search notes".into(), schema: json!({ "type": "object", "properties": { "query": { "type": "string" } } }) }]
}

#[test]
fn anthropic_streams_text_and_tool_calls_and_keeps_its_blocks() {
    let body = events(&[
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 10, "cache_read_input_tokens": 5 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "Let me " } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "look." } }),
        json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "t1", "name": "search", "input": {} } }),
        json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"query\": \"ru" } }),
        json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "st\"}" } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 7 } }),
        json!({ "type": "message_stop" }),
    ]);
    let (url, got) = serve(200, body);
    let mut seen = Vec::new();
    let history = vec![Message::User { text: "Rust notes?".into() }];
    let reply = run_turn(&provider(Protocol::Anthropic, url), "Be brief.", &history, &tools(), &mut |e| seen.push(e), &|| false).unwrap();

    assert_eq!(reply.stop, Stop::ToolUse);
    assert_eq!(reply.parts, vec![Part::Text { text: "Let me look.".into() }, Part::Tool { id: "t1".into(), name: "search".into(), input: json!({ "query": "rust" }), invalid: None }]);
    assert_eq!((reply.input_tokens, reply.output_tokens), (15, 7));
    assert_eq!(seen[0], Event::Text { text: "Let me ".into() });
    assert_eq!(seen[2], Event::Tool { id: "t1".into(), name: "search".into() });
    // The thinking block with its signature is kept, to go back as it was.
    let raw = reply.raw.unwrap();
    assert_eq!(raw.content[0], json!({ "type": "thinking", "thinking": "", "signature": "sig" }));
    assert_eq!(raw.content[2]["input"], json!({ "query": "rust" }));

    let (head, sent) = got.recv().unwrap();
    assert!(head.starts_with("POST /v1/messages "), "{head}");
    assert!(head.contains("x-api-key: k-123") && head.contains("anthropic-version: 2026-10-21"), "{head}");
    assert!(!head.contains("anthropic-beta"), "no fallbacks away from Anthropic's own API");
    assert_eq!(sent["stream"], json!(true));
    assert_eq!(sent["system"], json!("Be brief."));
    assert_eq!(sent["output_config"], json!({ "effort": "medium" }));
    assert_eq!(sent["tools"][0]["input_schema"]["type"], json!("object"));
    assert_eq!(sent["tools"][0]["eager_input_streaming"], json!(true));
    assert!(sent.get("temperature").is_none());
}

#[test]
fn anthropic_sends_its_blocks_back_and_answers_unanswered_calls() {
    let raw = json!([{ "type": "thinking", "thinking": "", "signature": "s" }, { "type": "tool_use", "id": "t1", "name": "search", "input": {} }]);
    let history = vec![
        Message::User { text: "hi".into() },
        Message::Assistant { parts: vec![Part::Tool { id: "t1".into(), name: "search".into(), input: json!({}), invalid: None }], raw: Some(Raw { protocol: Protocol::Anthropic, content: raw.clone() }) },
        // The turn was stopped before the tool ran.
        Message::User { text: "never mind".into() },
    ];
    let (url, got) = serve(200, events(&[json!({ "type": "message_stop" })]));
    let reply = run_turn(&provider(Protocol::Anthropic, url), "", &history, &[], &mut |_| {}, &|| false).unwrap();
    assert_eq!(reply.stop, Stop::End);
    let (_, sent) = got.recv().unwrap();
    let m = sent["messages"].as_array().unwrap();
    assert_eq!(m[1], json!({ "role": "assistant", "content": raw }));
    assert_eq!(m[2]["content"][0]["tool_use_id"], json!("t1"));
    assert_eq!(m[2]["content"][0]["is_error"], json!(true));
    assert_eq!(m[3], json!({ "role": "user", "content": "never mind" }));
    assert!(sent.get("tools").is_none());
}

#[test]
fn anthropic_turns_on_fallbacks_for_its_own_api() {
    let p = Provider { protocol: Protocol::Anthropic, base_url: "https://api.anthropic.com/v1".into(), model: "claude-opus-5-5".into(), key: Some("k".into()), effort: None };
    let (url, headers, body) = anthropic::request(&p, "", &[], &[]);
    assert_eq!(url, "https://api.anthropic.com/v1/messages");
    assert!(headers.contains(&("anthropic-beta", "server-side-fallback-2026-07-01".to_owned())));
    assert_eq!(body["fallbacks"], json!("default"));
    assert!(body.get("output_config").is_none());
}

#[test]
fn errors_carry_the_providers_message() {
    let (url, _) = serve(401, json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }).to_string());
    let err = run_turn(&provider(Protocol::Anthropic, url), "", &[Message::User { text: "hi".into() }], &[], &mut |_| {}, &|| false).unwrap_err();
    assert!(matches!(&err, AiError::Api { status: 401, message } if message == "invalid x-api-key"), "{err}");

    let (url, _) = serve(404, json!({ "error": { "message": "model not found" } }).to_string());
    let err = run_turn(&provider(Protocol::OpenAi, url), "", &[Message::User { text: "hi".into() }], &[], &mut |_| {}, &|| false).unwrap_err();
    assert_eq!(err.to_string(), "404: model not found");
}

#[test]
fn a_stopped_turn_keeps_what_came_and_sends_no_blocks_back() {
    let body = events(&[
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Half" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": " more" } }),
    ]);
    let (url, _) = serve(200, body);
    let n = std::cell::Cell::new(0);
    let reply = run_turn(
        &provider(Protocol::Anthropic, url),
        "",
        &[Message::User { text: "hi".into() }],
        &[],
        &mut |_| n.set(n.get() + 1),
        &|| n.get() >= 1,
    )
    .unwrap();
    assert_eq!(reply.stop, Stop::Cancelled);
    assert_eq!(reply.parts, vec![Part::Text { text: "Half".into() }]);
    assert!(reply.raw.is_none());
}

#[test]
fn invalid_tool_arguments_are_kept_aside() {
    let body = events(&[
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "t1", "name": "search", "input": {} } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"query\": \"a\"b\"}" } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" } }),
        json!({ "type": "message_stop" }),
    ]);
    let (url, _) = serve(200, body);
    let reply = run_turn(&provider(Protocol::Anthropic, url), "", &[Message::User { text: "x".into() }], &tools(), &mut |_| {}, &|| false).unwrap();
    let Part::Tool { input, invalid, .. } = &reply.parts[0] else { panic!() };
    assert_eq!(input, &json!({}));
    assert_eq!(invalid.as_deref(), Some("{\"query\": \"a\"b\"}"));
    assert_eq!(invalid_input_result("x\"y"), r#"{"INVALID_JSON":"x\"y"}"#);
}

#[test]
fn openai_compatible_streams_text_and_tool_calls() {
    let chunks = [
        json!({ "choices": [{ "delta": { "role": "assistant", "content": "Look" } }] }),
        json!({ "choices": [{ "delta": { "content": "ing." } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "c1", "type": "function", "function": { "name": "search", "arguments": "" } }] } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"query\":" } }] } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "\"rust\"}" } }] } }] }),
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        json!({ "choices": [], "usage": { "prompt_tokens": 20, "completion_tokens": 4 } }),
    ];
    let mut body: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    let (url, got) = serve(200, body);
    let history = vec![
        Message::User { text: "first".into() },
        Message::Assistant { parts: vec![Part::Text { text: "a".into() }, Part::Tool { id: "c0".into(), name: "search".into(), input: json!({ "query": "x" }), invalid: None }], raw: None },
        Message::Tools { results: vec![ToolResult { id: "c0".into(), content: "found".into(), is_error: false }] },
        Message::User { text: "again".into() },
    ];
    let mut seen = Vec::new();
    let reply = run_turn(&provider(Protocol::OpenAi, url), "Sys", &history, &tools(), &mut |e| seen.push(e), &|| false).unwrap();
    assert_eq!(reply.stop, Stop::ToolUse);
    assert_eq!(reply.parts, vec![Part::Text { text: "Looking.".into() }, Part::Tool { id: "c1".into(), name: "search".into(), input: json!({ "query": "rust" }), invalid: None }]);
    assert_eq!((reply.input_tokens, reply.output_tokens), (20, 4));
    assert!(seen.contains(&Event::Tool { id: "c1".into(), name: "search".into() }));

    let (head, sent) = got.recv().unwrap();
    assert!(head.starts_with("POST /v1/chat/completions "), "{head}");
    assert!(head.to_lowercase().contains("authorization: bearer k-123"), "{head}");
    let m = sent["messages"].as_array().unwrap();
    assert_eq!(m[0], json!({ "role": "system", "content": "Sys" }));
    assert_eq!(m[2]["tool_calls"][0]["function"], json!({ "name": "search", "arguments": "{\"query\":\"x\"}" }));
    assert_eq!(m[3], json!({ "role": "tool", "tool_call_id": "c0", "content": "found" }));
    assert_eq!(sent["tools"][0]["function"]["parameters"]["type"], json!("object"));
    assert_eq!(sent["reasoning_effort"], json!("medium"));
}

#[test]
fn messages_keep_their_shape_as_json() {
    let m = Message::Assistant { parts: vec![Part::Text { text: "hi".into() }], raw: None };
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v, json!({ "role": "assistant", "parts": [{ "type": "text", "text": "hi" }] }));
    let back: Message = serde_json::from_value(json!({ "role": "tools", "results": [{ "id": "a", "content": "x" }] })).unwrap();
    assert_eq!(back, Message::Tools { results: vec![ToolResult { id: "a".into(), content: "x".into(), is_error: false }] });
}

#[test]
fn models_are_listed_with_the_protocols_own_key_header_and_their_thinking_levels() {
    let opus = json!({ "id": "claude-opus-5-5", "capabilities": { "effort": { "supported": true, "low": { "supported": true }, "medium": { "supported": true }, "high": { "supported": true }, "xhigh": { "supported": true }, "max": { "supported": true } } } });
    let haiku = json!({ "id": "claude-haiku-4-5", "capabilities": { "effort": { "supported": false } } });
    let (url, rx) = serve(200, json!({ "data": [opus, haiku, { "id": "claude-x" }], "has_more": false }).to_string());
    let models = list_models(Protocol::Anthropic, &url, Some("k-1")).unwrap();
    assert_eq!(models[0], ModelInfo { id: "claude-opus-5-5".into(), efforts: Some(vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()]) });
    assert_eq!(models[1].efforts, Some(vec![]));
    assert_eq!(models[2].efforts, None);
    let (head, _) = rx.recv().unwrap();
    assert!(head.starts_with("GET /v1/models?limit=1000"));
    assert!(head.contains("x-api-key: k-1"));

    let (url, rx) = serve(200, json!({ "object": "list", "data": [{ "id": "qwen3" }, { "id": "deepseek-chat" }] }).to_string());
    let ids: Vec<String> = list_models(Protocol::OpenAi, &url, Some("k-2")).unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(ids, ["deepseek-chat", "qwen3"]);
    assert!(rx.recv().unwrap().0.contains("authorization: Bearer k-2"));

    let (url, _) = serve(401, json!({ "error": { "message": "invalid x-api-key" } }).to_string());
    let err = list_models(Protocol::Anthropic, &url, Some("bad")).unwrap_err();
    assert_eq!(err.to_string(), "401: invalid x-api-key");
}
