//! Engine-independent JSON used to compare Rust and JS replicas.
//!
//! Card: `{"type", "attrs" (null values dropped, keys sorted), "content"}`;
//! text runs are `{"text", "marks": [sorted mark names]}` with adjacent runs
//! that carry the same marks merged. The JS side (`web/src/interop/canonical.ts`)
//! implements the same rules.

use serde_json::{Map, Value, json};

pub fn element(node: &str, attrs: Map<String, Value>, content: Vec<Value>) -> Value {
    let attrs: Map<String, Value> = attrs.into_iter().filter(|(_, v)| !v.is_null()).collect();
    let mut sorted = Map::new();
    let mut keys: Vec<_> = attrs.keys().cloned().collect();
    keys.sort();
    for k in keys {
        sorted.insert(k.clone(), attrs[&k].clone());
    }
    json!({ "type": node, "attrs": sorted, "content": merge_text(content) })
}

pub fn text(s: &str, mut marks: Vec<String>) -> Value {
    marks.sort();
    marks.dedup();
    json!({ "text": s, "marks": marks })
}

fn merge_text(content: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for v in content {
        if let (Some(last), Some(t)) = (out.last_mut(), v.get("text")) {
            if last.get("text").is_some() && last["marks"] == v["marks"] {
                let joined = format!("{}{}", last["text"].as_str().unwrap(), t.as_str().unwrap());
                last["text"] = Value::String(joined);
                continue;
            }
        }
        if v.get("text").map(|t| t.as_str() == Some("")).unwrap_or(false) {
            continue;
        }
        out.push(v);
    }
    out
}
