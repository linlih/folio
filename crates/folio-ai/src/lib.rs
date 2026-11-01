//! One turn of a chat with the user's model (design/ai.md): the request in
//! the provider's own format, its streamed answer read as it comes, and the
//! answer as text and tool calls. The app runs the tools and calls again
//! until the model is done; it keeps the conversation, this crate keeps
//! nothing.
//!
//! Two protocols cover the providers: Anthropic's Messages API, and the
//! OpenAI-compatible Chat Completions API that OpenAI, DeepSeek, Qwen, Kimi
//! and a local Ollama all speak.

mod anthropic;
mod openai;
mod sse;

use std::io::BufRead;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Anthropic,
    OpenAi,
}

/// Where a turn goes. `key` is None for a provider that needs none (Ollama).
#[derive(Clone, Debug)]
pub struct Provider {
    pub protocol: Protocol,
    /// Up to the version: https://api.anthropic.com/v1, http://localhost:11434/v1.
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
    /// How hard the model thinks: Anthropic's effort (low … max), or a
    /// reasoning model's `reasoning_effort`; None leaves the model's default.
    pub effort: Option<String>,
}

/// The conversation as the app keeps it, the same for every provider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    User {
        text: String,
    },
    Assistant {
        parts: Vec<Part>,
        /// The provider's own content, sent back as it was when the next
        /// turn goes to the same protocol: Anthropic's thinking blocks must
        /// come back unchanged.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Raw>,
    },
    /// The results of the tool calls in the assistant message before.
    Tools {
        results: Vec<ToolResult>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Part {
    Text {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        input: Value,
        /// The arguments as sent when they were not valid JSON; the tool is
        /// not run and the model is told.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invalid: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Raw {
    pub protocol: Protocol,
    pub content: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// A tool the model may call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// What arrives while the answer streams.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Text { text: String },
    /// The model started a tool call.
    Tool { id: String, name: String },
}

/// Why the model stopped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    /// Finished its answer.
    End,
    /// Waits for the results of its tool calls.
    ToolUse,
    /// Ran out of room (`max_tokens`): an unfinished tool call is not run.
    MaxTokens,
    /// Declined (Anthropic's safety classifiers).
    Refusal,
    /// The user stopped it.
    Cancelled,
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub parts: Vec<Part>,
    pub raw: Option<Raw>,
    pub stop: Stop,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    /// The provider answered with an error (a wrong key, an unknown model,
    /// too many requests): its status and message.
    #[error("{status}: {message}")]
    Api { status: u16, message: String },
    /// No answer (offline, a wrong address, a timeout).
    #[error("{0}")]
    Network(String),
    /// An answer this crate cannot read.
    #[error("unexpected answer: {0}")]
    Protocol(String),
}

pub type Result<T> = std::result::Result<T, AiError>;

/// Asks the model for its next message. `events` gets the text as it
/// streams; `cancelled` is asked between pieces, and a stopped turn
/// returns what came so far.
pub fn run_turn(provider: &Provider, system: &str, messages: &[Message], tools: &[Tool], events: &mut dyn FnMut(Event), cancelled: &dyn Fn() -> bool) -> Result<Reply> {
    let messages = answered(messages);
    let (url, headers, body) = match provider.protocol {
        Protocol::Anthropic => anthropic::request(provider, system, &messages, tools),
        Protocol::OpenAi => openai::request(provider, system, &messages, tools),
    };
    let reader = post(&url, &headers, &body)?;
    match provider.protocol {
        Protocol::Anthropic => anthropic::read(reader, events, cancelled),
        Protocol::OpenAi => openai::read(reader, events, cancelled),
    }
}

/// The conversation with every tool call answered: a call left without a
/// result (the turn was stopped, the app closed) gets one saying it did not
/// run, since both protocols refuse a call without its result.
fn answered(messages: &[Message]) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        out.push(m.clone());
        let Message::Assistant { parts, .. } = m else { continue };
        let calls: Vec<&String> = parts.iter().filter_map(|p| if let Part::Tool { id, .. } = p { Some(id) } else { None }).collect();
        if calls.is_empty() {
            continue;
        }
        let given: Vec<String> = match messages.get(i + 1) {
            Some(Message::Tools { results }) => results.iter().map(|r| r.id.clone()).collect(),
            _ => Vec::new(),
        };
        let missing: Vec<ToolResult> = calls
            .into_iter()
            .filter(|id| !given.contains(id))
            .map(|id| ToolResult { id: id.clone(), content: "Not run: the turn was stopped.".into(), is_error: true })
            .collect();
        // Right after the call, before any results that are there: both
        // protocols take tool results in several messages.
        if !missing.is_empty() {
            out.push(Message::Tools { results: missing });
        }
    }
    out
}

fn post(url: &str, headers: &[(&str, String)], body: &Value) -> Result<Box<dyn BufRead + Send>> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        // Between two pieces of the stream: a model can think a while.
        .timeout_read(Duration::from_secs(300))
        .build();
    let mut req = agent.post(url).set("content-type", "application/json");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    match req.send_json(body) {
        Ok(resp) => Ok(Box::new(std::io::BufReader::new(resp.into_reader()))),
        Err(ureq::Error::Status(status, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(AiError::Api { status, message: error_message(&text) })
        }
        Err(e) => Err(AiError::Network(e.to_string())),
    }
}

/// The message in a provider's error body, both protocols' shapes.
fn error_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    v.pointer("/error/message")
        .or_else(|| v.get("message"))
        .or_else(|| v.get("error").filter(|e| e.is_string()))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| body.chars().take(300).collect())
}

/// A tool call's arguments as streamed: an object, or why not.
fn parse_input(json: &str) -> std::result::Result<Value, String> {
    if json.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    match serde_json::from_str::<Value>(json) {
        Ok(v @ Value::Object(_)) => Ok(v),
        _ => Err(json.to_owned()),
    }
}

/// The tool result content sent for a call whose arguments were not JSON.
pub fn invalid_input_result(raw: &str) -> String {
    serde_json::json!({ "INVALID_JSON": raw }).to_string()
}

#[cfg(test)]
mod tests;
