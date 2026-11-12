//! A query block's conditions as text (design/query.md §8), for Markdown:
//! the same words as the app's text syntax (web/src/query/syntax.ts
//! `format`), so Folio reads them back and people can read them anywhere.

use serde_json::Value;

/// What names stand for ids, and which language's keywords to write.
pub struct QueryNames<'a> {
    pub zh: bool,
    pub card_title: &'a dyn Fn(&str) -> Option<String>,
    pub topic_name: &'a dyn Fn(&str) -> Option<String>,
}

fn say<'a>(table: &[(&str, &'a str, &'a str)], k: &'a str, zh: bool) -> &'a str {
    table.iter().find(|(key, _, _)| *key == k).map(|(_, en, cn)| if zh { *cn } else { *en }).unwrap_or(k)
}

const KEYS: &[(&str, &str, &str)] = &[
    ("task", "task", "任务"),
    ("priority", "priority", "优先级"),
    ("due", "due", "到期"),
    ("deadline", "deadline", "截止"),
    ("scheduled", "scheduled", "计划"),
    ("created", "created", "创建"),
    ("updated", "updated", "修改"),
    ("day", "day", "日期"),
    ("in", "in", "在"),
    ("links", "links", "链接"),
    ("show", "show", "显示"),
    ("view", "view", "显示为"),
    ("sort", "sort", "排序"),
    ("group", "group", "分组"),
    ("limit", "limit", "条数"),
    ("title", "title", "标题"),
];
const STATES: &[(&str, &str, &str)] = &[
    ("open", "open", "未完成"),
    ("done", "done", "已完成"),
    ("canceled", "canceled", "已取消"),
    ("backlog", "backlog", "待规划"),
    ("todo", "todo", "待办"),
    ("doing", "doing", "进行中"),
    ("review", "review", "审核中"),
    ("any", "any", "全部"),
];
const PRIOS: &[(&str, &str, &str)] = &[("none", "none", "无"), ("low", "low", "低"), ("medium", "medium", "中"), ("high", "high", "高"), ("urgent", "urgent", "紧急")];
const SHOWS: &[(&str, &str, &str)] = &[("tasks", "tasks", "任务"), ("blocks", "blocks", "块"), ("cards", "cards", "卡片")];
const VIEWS: &[(&str, &str, &str)] = &[("list", "list", "列表"), ("table", "table", "表格"), ("board", "board", "看板")];
const PLACES: &[(&str, &str, &str)] = &[("cards", "cards", "卡片"), ("journal", "journal", "日记"), ("inbox", "inbox", "收集箱"), ("this", "this", "本卡")];
const SORTS: &[(&str, &str, &str)] = &[
    ("due", "due", "到期"),
    ("priority", "priority", "优先级"),
    ("created", "created", "创建"),
    ("updated", "updated", "修改"),
    ("day", "day", "日期"),
    ("title", "title", "标题"),
];
const GROUPS: &[(&str, &str, &str)] = &[("card", "card", "卡片"), ("day", "day", "日期"), ("status", "status", "状态")];
const DAYS: &[(&str, &str, &str)] = &[("today", "today", "今天"), ("yesterday", "yesterday", "昨天"), ("tomorrow", "tomorrow", "明天"), ("page", "page", "本页")];
const PERIODS: &[(&str, &str, &str)] = &[
    ("this-week", "this-week", "本周"),
    ("last-week", "last-week", "上周"),
    ("next-week", "next-week", "下周"),
    ("this-month", "this-month", "本月"),
    ("last-month", "last-month", "上月"),
    ("next-month", "next-month", "下月"),
];
const SPECIAL: &[(&str, &str, &str)] = &[("overdue", "overdue", "已过期"), ("none", "none", "无")];

fn strip_quotes(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '"' | '“' | '”' | '＂')).collect()
}

fn is_or(s: &str) -> bool {
    s.eq_ignore_ascii_case("or") || s == "或"
}

/// Quotes a value that would not read back as one word.
fn q(s: &str) -> String {
    let plain = !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || matches!(c, '(' | ')' | '"' | '“' | '”' | '＂' | '（' | '）'));
    if plain && !is_or(s) { s.to_owned() } else { format!("\"{}\"", strip_quotes(s)) }
}

fn key(k: &str, zh: bool) -> String {
    format!("{}:", say(KEYS, k, zh))
}

fn day_word(d: &str, zh: bool) -> String {
    if DAYS.iter().any(|(k, _, _)| *k == d) {
        return say(DAYS, d, zh).to_owned();
    }
    if zh {
        let bytes = d.as_bytes();
        if d.len() >= 3 && matches!(bytes[0], b'+' | b'-') && d[1..d.len() - 1].chars().all(|c| c.is_ascii_digit()) {
            let unit = if d.ends_with('w') { "周" } else if d.ends_with('d') { "天" } else { "" };
            if !unit.is_empty() {
                return format!("{}{unit}", &d[..d.len() - 1]);
            }
        }
    }
    d.to_owned()
}

fn date_word(v: &Value, zh: bool) -> String {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if let Some(p) = s("period") {
        return say(PERIODS, p, zh).to_owned();
    }
    if let Some(is) = s("is") {
        return say(SPECIAL, is, zh).to_owned();
    }
    match (s("from"), s("to")) {
        (Some(f), Some(t)) if f == t && !b("xfrom") && !b("xto") => day_word(f, zh),
        (Some(f), Some(t)) => format!("{}..{}", day_word(f, zh), day_word(t, zh)),
        (None, Some(t)) => format!("{}{}", if b("xto") { "<" } else { "<=" }, day_word(t, zh)),
        (Some(f), None) => format!("{}{}", if b("xfrom") { ">" } else { ">=" }, day_word(f, zh)),
        (None, None) => "..".to_owned(),
    }
}

fn strings(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

fn cond_word(c: &Value, n: &QueryNames) -> String {
    let zh = n.zh;
    let neg = if c.get("not").and_then(Value::as_bool).unwrap_or(false) { "-" } else { "" };
    let k = c.get("k").and_then(Value::as_str).unwrap_or("");
    let v = c.get("v");
    let body = match k {
        "tag" => format!("#{}", strings(v).iter().map(|t| q(t)).collect::<Vec<_>>().join(",")),
        "task" => key("task", zh) + &strings(v).iter().map(|s| say(STATES, s, zh)).collect::<Vec<_>>().join(","),
        "priority" => {
            let min = if c.get("min").and_then(Value::as_bool).unwrap_or(false) { ">=" } else { "" };
            key("priority", zh) + min + &strings(v).iter().map(|p| say(PRIOS, p, zh)).collect::<Vec<_>>().join(",")
        }
        "text" => {
            let t = v.and_then(Value::as_str).unwrap_or("");
            if t.chars().any(|c| matches!(c, ':' | '：' | '#' | '=' | '<' | '>')) || t.starts_with('-') || is_or(t) {
                format!("\"{}\"", strip_quotes(t))
            } else {
                q(t)
            }
        }
        "in" => {
            let place = match v {
                Some(Value::String(p)) => say(PLACES, p, zh).to_owned(),
                Some(o) => {
                    let id = o.get("topic").and_then(Value::as_str).unwrap_or("");
                    format!("{}:{}", if zh { "主题" } else { "topic" }, q(&(n.topic_name)(id).unwrap_or_else(|| id.to_owned())))
                }
                None => String::new(),
            };
            key("in", zh) + &place
        }
        "links" => {
            let target = match (v.and_then(|v| v.get("card")).and_then(Value::as_str), v.and_then(|v| v.get("block")).and_then(Value::as_str)) {
                (_, Some(b)) => format!("(({b}))"),
                (Some("this"), _) => if zh { "本卡" } else { "this" }.to_owned(),
                (Some(id), _) => format!("[[{}]]", (n.card_title)(id).unwrap_or_else(|| id.to_owned())),
                _ => String::new(),
            };
            key("links", zh) + &target
        }
        "group" => {
            let any = c.get("match").and_then(Value::as_str) == Some("any");
            let inner: Vec<String> = c.get("where").and_then(Value::as_array).into_iter().flatten().map(|x| cond_word(x, n)).collect();
            format!("({})", inner.join(if any { " OR " } else { " " }))
        }
        _ => key(k, zh) + &date_word(v.unwrap_or(&Value::Null), zh),
    };
    format!("{neg}{body}")
}

/// A query block's spec (JSON) as text; None when it is not one.
pub fn query_text(spec: &str, n: &QueryNames) -> Option<String> {
    let spec: Value = serde_json::from_str(spec).ok()?;
    let zh = n.zh;
    let empty = Vec::new();
    let where_ = spec.get("where").and_then(Value::as_array).unwrap_or(&empty);
    let mut words: Vec<String> = Vec::new();
    if spec.get("match").and_then(Value::as_str) == Some("any") {
        let branches: Vec<String> = where_
            .iter()
            .map(|c| {
                let all_group = c.get("k").and_then(Value::as_str) == Some("group")
                    && c.get("match").and_then(Value::as_str) != Some("any")
                    && !c.get("not").and_then(Value::as_bool).unwrap_or(false);
                if all_group {
                    c.get("where").and_then(Value::as_array).into_iter().flatten().map(|x| cond_word(x, n)).collect::<Vec<_>>().join(" ")
                } else {
                    cond_word(c, n)
                }
            })
            .collect();
        words.push(branches.join(" OR "));
    } else {
        words.extend(where_.iter().map(|c| cond_word(c, n)));
    }
    let view = spec.get("view");
    if let Some(s) = spec.get("show").and_then(Value::as_str) {
        words.push(key("show", zh) + say(SHOWS, s, zh));
    }
    if let Some(m) = view.and_then(|v| v.get("mode")).and_then(Value::as_str) {
        words.push(key("view", zh) + say(VIEWS, m, zh));
    }
    if let Some(sorts) = spec.get("sort").and_then(Value::as_array).filter(|s| !s.is_empty()) {
        let list: Vec<String> = sorts
            .iter()
            .map(|s| {
                let desc = if s.get("desc").and_then(Value::as_bool).unwrap_or(false) { "-" } else { "" };
                format!("{desc}{}", say(SORTS, s.get("by").and_then(Value::as_str).unwrap_or(""), zh))
            })
            .collect();
        words.push(key("sort", zh) + &list.join(","));
    }
    if let Some(g) = spec.get("group").and_then(Value::as_str) {
        words.push(key("group", zh) + say(GROUPS, g, zh));
    }
    if let Some(l) = view.and_then(|v| v.get("limit")).and_then(Value::as_u64) {
        words.push(format!("{}{l}", key("limit", zh)));
    }
    if let Some(t) = spec.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        words.push(format!("{}\"{}\"", key("title", zh), strip_quotes(t)));
    }
    Some(words.into_iter().filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_reads_as_the_app_writes_it() {
        let titles = |id: &str| (id == "c1").then(|| "张三".to_owned());
        let topics = |id: &str| (id == "t1").then(|| "工作".to_owned());
        let names = |zh| QueryNames { zh, card_title: &titles, topic_name: &topics };
        let spec = r#"{"v":1,"match":"all","where":[{"k":"task","v":["open"]},{"k":"group","match":"any","where":[{"k":"in","v":"this"},{"k":"links","v":{"card":"this"}}]},{"k":"due","v":{"to":"+7d"}},{"k":"tag","v":["项目a"],"not":true}],"sort":[{"by":"due"},{"by":"priority","desc":true}]}"#;
        assert_eq!(query_text(spec, &names(true)).unwrap(), "任务:未完成 (在:本卡 OR 链接:本卡) 到期:<=+7天 -#项目a 排序:到期,-优先级");
        assert_eq!(query_text(spec, &names(false)).unwrap(), "task:open (in:this OR links:this) due:<=+7d -#项目a sort:due,-priority");
        let other = r#"{"v":1,"match":"all","where":[{"k":"links","v":{"card":"c1"}},{"k":"in","v":{"topic":"t1"}},{"k":"text","v":"a: b"},{"k":"created","v":{"period":"this-week"}}],"show":"cards","view":{"limit":5},"title":"看看"}"#;
        assert_eq!(query_text(other, &names(false)).unwrap(), r#"links:[[张三]] in:topic:工作 "a: b" created:this-week show:cards limit:5 title:"看看""#);
        assert_eq!(query_text("nope", &names(false)), None);
    }
}
