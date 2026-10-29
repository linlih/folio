//! The workspace document (`ws`, design/ARCHITECTURE.md §4.1): read side of
//! the topics (§4.7). The app writes them (`web/src/docs/workspace.ts`);
//! this reads them the same way, for MCP and other readers.

use loro::{Container, LoroDoc, LoroValue, ValueOrContainer};

const TOPICS: &str = "topics";

#[derive(Debug, Clone, PartialEq)]
pub struct Topic {
    pub id: String,
    pub name: String,
    /// The topic it is a sub-topic of, as shown: see `topics`.
    pub parent: Option<String>,
    pub created_at: i64,
}

fn field(m: &loro::LoroMap, key: &str) -> Option<LoroValue> {
    match m.get(key)? {
        ValueOrContainer::Value(v) => Some(v),
        ValueOrContainer::Container(_) => None,
    }
}

fn number(v: Option<LoroValue>) -> Option<i64> {
    match v? {
        LoroValue::I64(n) => Some(n),
        LoroValue::Double(n) => Some(n as i64),
        _ => None,
    }
}

fn string(v: Option<LoroValue>) -> String {
    match v {
        Some(LoroValue::String(s)) => s.to_string(),
        _ => String::new(),
    }
}

/// Topics not deleted, in the order they were made. Two levels: a topic
/// shows under its parent only when that parent is at the top, so a third
/// level or a cycle (moves on two devices at once) and a deleted parent
/// show at the top. The same rule as `readTopics` in the app.
pub fn topics(doc: &LoroDoc) -> Vec<Topic> {
    let all = doc.get_map(TOPICS);
    let mut stored = Vec::new();
    for key in all.keys() {
        let Some(ValueOrContainer::Container(Container::Map(m))) = all.get(&key) else { continue };
        if field(&m, "deleted_at").is_some_and(|v| !matches!(v, LoroValue::Null)) {
            continue;
        }
        let parent = Some(string(field(&m, "parent"))).filter(|p| !p.is_empty());
        stored.push(Topic { id: key.to_string(), name: string(field(&m, "name")), parent, created_at: number(field(&m, "created_at")).unwrap_or(0) });
    }
    let top = |t: &Topic| match &t.parent {
        None => true,
        Some(p) => p == &t.id || !stored.iter().any(|x| &x.id == p),
    };
    let shown: Vec<Option<String>> = stored
        .iter()
        .map(|t| if top(t) { None } else { t.parent.clone().filter(|p| stored.iter().find(|x| &x.id == p).is_some_and(top)) })
        .collect();
    let mut out: Vec<Topic> = stored.iter().zip(shown).map(|(t, parent)| Topic { parent, ..t.clone() }).collect();
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::LoroMap;

    fn topic(doc: &LoroDoc, id: &str, name: &str, at: i64, parent: Option<&str>) {
        let m = doc.get_map(TOPICS).insert_container(id, LoroMap::new()).unwrap();
        m.insert("name", name).unwrap();
        m.insert("created_at", at as f64).unwrap();
        if let Some(p) = parent {
            m.insert("parent", p).unwrap();
        }
    }

    #[test]
    fn reads_two_levels_and_puts_the_rest_at_the_top() {
        let doc = LoroDoc::new();
        topic(&doc, "ai", "AI学习", 1, None);
        topic(&doc, "a", "课程A", 2, Some("ai"));
        topic(&doc, "deep", "第三层", 3, Some("a"));
        topic(&doc, "x", "X", 4, Some("y"));
        topic(&doc, "y", "Y", 5, Some("x"));
        topic(&doc, "gone", "已删", 6, None);
        topic(&doc, "orphan", "孤儿", 7, Some("gone"));
        doc.get_map(TOPICS).get("gone").and_then(|v| v.into_container().ok()).unwrap().into_map().unwrap().insert("deleted_at", 8.0).unwrap();
        let got: Vec<(String, Option<String>)> = topics(&doc).into_iter().map(|t| (t.name, t.parent)).collect();
        let name = |s: &str| s.to_owned();
        assert_eq!(
            got,
            [
                (name("AI学习"), None),
                (name("课程A"), Some(name("ai"))),
                (name("第三层"), None),
                (name("X"), None),
                (name("Y"), None),
                (name("孤儿"), None),
            ]
        );
    }
}
