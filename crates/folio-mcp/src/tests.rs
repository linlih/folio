use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use loro::{ExportMode, LoroDoc};
use folio_core::card::{append_paragraph, CardKind};
use folio_core::{DocId, DocKind};
use folio_store::{Origin, Store};
use serde_json::{json, Value};

use super::*;

struct TestHost {
    store: Mutex<Store>,
    allowed: bool,
    asked: Mutex<Vec<String>>,
}

impl Host for TestHost {
    fn with_store(&self, f: &mut dyn FnMut(&mut Store)) {
        f(&mut self.store.lock().unwrap());
    }
    fn approve(&self, client: &str) -> bool {
        self.asked.lock().unwrap().push(client.to_owned());
        self.allowed
    }
}

fn library(allowed: bool) -> (tempfile::TempDir, Arc<TestHost>, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let id = store.create_card(CardKind::Note, "Rust 笔记", 1).unwrap();
    let doc = LoroDoc::new();
    doc.import(&store.doc_snapshot(&id).unwrap()).unwrap();
    let v = doc.oplog_vv();
    append_paragraph(&doc, "所有权和借用").unwrap();
    store.apply_update(&id, DocKind::Card, &doc.export(ExportMode::updates(&v)).unwrap(), Origin::Local, 2).unwrap();
    (dir, Arc::new(TestHost { store: Mutex::new(store), allowed, asked: Mutex::default() }), id.to_string())
}

fn init() -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "Claude Code" }, "capabilities": {} } })
}

#[test]
fn an_approved_client_gets_a_session_and_reads_notes() {
    let (_dir, host, id) = library(true);
    let mut sessions = Vec::new();
    let mut open = |c: &str| {
        sessions.push(c.to_owned());
        "s1".to_owned()
    };
    let (reply, session) = handle(&*host, &init(), None, &mut open);
    assert_eq!(session.as_deref(), Some("s1"));
    let Reply::Json(v) = reply else { panic!() };
    assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(*host.asked.lock().unwrap(), vec!["Claude Code"]);

    let mut never = |_: &str| -> String { panic!("no new session") };
    let call = |name: &str, args: Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let text = |reply: Reply| match reply {
        Reply::Json(v) => v["result"]["content"][0]["text"].as_str().unwrap().to_owned(),
        r => panic!("{r:?}"),
    };
    let (list, _) = handle(&*host, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }), Some("s1"), &mut never);
    let Reply::Json(list) = list else { panic!() };
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 9);

    let found = text(handle(&*host, &call("search", json!({ "query": "借用" })), Some("s1"), &mut never).0);
    assert!(found.contains(&id), "{found}");
    let card = text(handle(&*host, &call("read_card", json!({ "title": "rust 笔记" })), Some("s1"), &mut never).0);
    assert!(card.starts_with("# Rust 笔记"), "{card}");
    assert!(card.contains("所有权和借用"));
    let missing = handle(&*host, &call("read_card", json!({ "id": "nope" })), Some("s1"), &mut never).0;
    let Reply::Json(missing) = missing else { panic!() };
    assert_eq!(missing["result"]["isError"], true);
}

#[test]
fn without_approval_or_a_session_nothing_is_read() {
    let (_dir, host, _) = library(false);
    let mut open = |_: &str| -> String { panic!("declined clients get no session") };
    let (reply, session) = handle(&*host, &init(), None, &mut open);
    assert!(session.is_none());
    let Reply::Json(v) = reply else { panic!() };
    assert_eq!(v["error"]["code"], -32001);
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_recent_cards" } });
    assert_eq!(handle(&*host, &call, None, &mut open).0, Reply::UnknownSession);
}

/// One raw HTTP request; returns (status, headers, body).
fn http(port: u16, headers: &[(&str, &str)], body: &str) -> (u16, String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap_or((&out, ""));
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head.to_owned(), body.to_owned())
}

#[test]
fn http_needs_the_token_a_local_origin_and_a_session() {
    let (_dir, host, _) = library(true);
    let server = server::Server::start(0, "secret".into(), host).unwrap();
    let port = server.port();
    let auth = ("Authorization", "Bearer secret");
    let init = init().to_string();
    assert_eq!(http(port, &[], &init).0, 401);
    assert_eq!(http(port, &[("Authorization", "Bearer wrong")], &init).0, 401);
    assert_eq!(http(port, &[auth, ("Origin", "https://evil.example")], &init).0, 403);

    let (status, head, body) = http(port, &[auth, ("Origin", "http://localhost:3000")], &init);
    assert_eq!(status, 200, "{body}");
    let session = head.lines().find_map(|l| l.strip_prefix("Mcp-Session-Id: ").or_else(|| l.strip_prefix("mcp-session-id: "))).unwrap().trim().to_owned();

    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();
    assert_eq!(http(port, &[auth], &list).0, 400, "no session header");
    assert_eq!(http(port, &[auth, ("Mcp-Session-Id", "made-up")], &list).0, 404);
    let (status, _, body) = http(port, &[auth, ("Mcp-Session-Id", &session)], &list);
    assert_eq!(status, 200);
    assert!(body.contains("read_card"));
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
    assert_eq!(http(port, &[auth, ("Mcp-Session-Id", &session)], &note).0, 202);
    server.stop();
}

#[test]
fn topics_list_with_their_sub_topics_and_cards() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    // Topics as the app writes them into the workspace document.
    let ws = LoroDoc::new();
    let topic = |id: &str, name: &str, at: f64, parent: Option<&str>| {
        let m = ws.get_map("topics").insert_container(id, loro::LoroMap::new()).unwrap();
        m.insert("name", name).unwrap();
        m.insert("created_at", at).unwrap();
        if let Some(p) = parent {
            m.insert("parent", p).unwrap();
        }
    };
    topic("ai", "AI学习", 1.0, None);
    topic("a", "课程A", 2.0, Some("ai"));
    topic("b", "课程B", 3.0, Some("ai"));
    ws.commit();
    store.apply_update(&DocId::workspace(), DocKind::Workspace, &ws.export(ExportMode::all_updates()).unwrap(), Origin::Local, 1).unwrap();
    let road = store.create_card(CardKind::Note, "学习路线", 2).unwrap();
    let lesson = store.create_card(CardKind::Note, "第1讲", 3).unwrap();
    store.set_card_topic(&road, "ai", true, 4).unwrap();
    store.set_card_topic(&lesson, "a", true, 4).unwrap();
    store.set_card_topic(&lesson, "b", true, 4).unwrap();

    let list = tools::call(&mut store, "list_topics", &json!({})).unwrap();
    assert_eq!(list, "- AI学习 (id ai, 2 cards)\n  - 课程A (id a, 1 cards)\n  - 课程B (id b, 1 cards)");
    let all = tools::call(&mut store, "topic_cards", &json!({ "topic": "AI学习" })).unwrap();
    assert!(all.contains("“学习路线”") && all.contains("“第1讲”") && all.contains("[in 课程A]"), "{all}");
    let here = tools::call(&mut store, "topic_cards", &json!({ "topic": "ai学习", "include_subtopics": false })).unwrap();
    assert!(!here.contains("第1讲"), "{here}");
    let sub = tools::call(&mut store, "topic_cards", &json!({ "topic": "AI学习 / 课程B" })).unwrap();
    assert!(sub.starts_with("Cards in “AI学习 › 课程B”"), "{sub}");
    assert!(tools::call(&mut store, "topic_cards", &json!({ "topic": "投资" })).is_err());
}
