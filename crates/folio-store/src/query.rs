//! Query blocks (design/query.md §7): a query the frontend has resolved
//! (dates worked out, "this card" as its id) run as one SQL statement over
//! `index.db`, without opening any document. web/src/query/engine.ts runs
//! the same rules in memory; keep the two in step.

use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

use crate::{Backlink, CardRow, Result, Store, TaskRow, like, tag_key};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedQuery {
    /// tasks, blocks or cards.
    pub show: String,
    #[serde(rename = "match")]
    pub match_: String,
    #[serde(rename = "where")]
    pub where_: Vec<ResolvedCond>,
    pub sort: Vec<SortBy>,
    /// Cards never listed (templates).
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Cards still in the inbox are left out unless a condition names it.
    #[serde(default)]
    pub include_inbox: bool,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SortBy {
    pub by: String,
    #[serde(default)]
    pub desc: bool,
}

/// One condition; which fields matter depends on `k` (web/src/bindings/commands.ts).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResolvedCond {
    pub k: String,
    pub not: bool,
    pub v: Vec<String>,
    pub field: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub none: bool,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub card: Option<String>,
    pub block: Option<String>,
    #[serde(rename = "match")]
    pub match_: Option<String>,
    #[serde(rename = "where")]
    pub where_: Vec<ResolvedCond>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRows {
    pub tasks: Vec<TaskRow>,
    pub blocks: Vec<Backlink>,
    pub cards: Vec<CardRow>,
    /// How many rows match in all (the rows stop at the limit).
    pub total: u32,
}

/// Builds the WHERE clause, its arguments and the tag tables it needs.
struct Sql {
    args: Vec<Value>,
    ctes: Vec<String>,
    /// Rows are cards (`c`), not blocks (`b`).
    cards: bool,
}

impl Sql {
    fn arg(&mut self, v: impl Into<Value>) -> String {
        self.args.push(v.into());
        format!("?{}", self.args.len())
    }

    fn list(&mut self, vs: &[String]) -> String {
        if vs.is_empty() {
            return "(NULL)".into();
        }
        let ps: Vec<String> = vs.iter().map(|v| self.arg(v.clone())).collect();
        format!("({})", ps.join(", "))
    }

    fn group(&mut self, conds: &[ResolvedCond], any: bool) -> String {
        if conds.is_empty() {
            return if any { "0".into() } else { "1".into() };
        }
        let parts: Vec<String> = conds.iter().map(|c| self.cond(c)).collect();
        format!("({})", parts.join(if any { " OR " } else { " AND " }))
    }

    fn cond(&mut self, c: &ResolvedCond) -> String {
        let p = self.positive(c);
        // NOT of a comparison with NULL is NULL, not true.
        if c.not { format!("(CASE WHEN {p} THEN 0 ELSE 1 END)") } else { format!("({p})") }
    }

    /// A condition on one block `x`; on a card, some block of it.
    fn on_block(&self, pred: impl Fn(&str) -> String) -> String {
        if self.cards { format!("EXISTS (SELECT 1 FROM idx.blocks x WHERE x.card_id = c.card_id AND {})", pred("x")) } else { pred("b") }
    }

    fn positive(&mut self, c: &ResolvedCond) -> String {
        match c.k.as_str() {
            "group" => self.group(&c.where_, c.match_.as_deref() == Some("any")),
            "tag" => {
                let tags: Vec<String> = c.v.iter().map(|t| tag_key(t)).collect();
                let anywhere = format!("EXISTS (SELECT 1 FROM idx.tags t WHERE t.card_id = c.card_id AND t.tag IN {})", self.list(&tags));
                if self.cards {
                    return anywhere;
                }
                // The tagged blocks and every block under them.
                let name = format!("tagged{}", self.ctes.len());
                let tl = self.list(&tags);
                self.ctes.push(format!(
                    "{name}(card_id, bid) AS (SELECT t.card_id, t.bid FROM idx.tags t WHERE t.tag IN {tl}
                       UNION SELECT x.card_id, x.bid FROM idx.blocks x JOIN {name} k ON x.card_id = k.card_id AND x.parent_bid = k.bid)"
                ));
                // Anywhere in a card counts; in a journal day only above the block.
                format!("(c.kind != 'journal' AND {anywhere}) OR EXISTS (SELECT 1 FROM {name} k WHERE k.card_id = b.card_id AND k.bid = b.bid)")
            }
            "task" => {
                let l = self.list(&c.v);
                self.on_block(|x| format!("{x}.task_status IN {l}"))
            }
            "priority" => {
                let none = c.v.iter().any(|p| p == "none");
                let l = self.list(&c.v);
                self.on_block(|x| format!("{x}.task_status IS NOT NULL AND ({x}.priority IN {l}{})", if none { format!(" OR {x}.priority IS NULL") } else { String::new() }))
            }
            "date" if c.field.as_deref() == Some("day") => {
                if c.none {
                    return "c.kind != 'journal'".into();
                }
                let mut s = "c.kind = 'journal'".to_owned();
                if let Some(f) = &c.from {
                    s += &format!(" AND substr(c.card_id, 9) >= {}", self.arg(f.clone()));
                }
                if let Some(t) = &c.to {
                    s += &format!(" AND substr(c.card_id, 9) <= {}", self.arg(t.clone()));
                }
                s
            }
            "date" => {
                let col = |x: &str| match c.field.as_deref() {
                    Some("deadline") => format!("{x}.deadline"),
                    Some("scheduled") => format!("{x}.scheduled"),
                    _ => format!("COALESCE({x}.deadline, {x}.scheduled)"),
                };
                if c.none {
                    return self.on_block(|x| format!("{x}.task_status IS NOT NULL AND {} IS NULL", col(x)));
                }
                let from = c.from.clone().map(|f| self.arg(f));
                let to = c.to.clone().map(|t| self.arg(t));
                self.on_block(|x| {
                    let e = col(x);
                    let mut s = format!("{x}.task_status IS NOT NULL AND {e} IS NOT NULL");
                    if let Some(f) = &from {
                        s += &format!(" AND {e} >= {f}");
                    }
                    if let Some(t) = &to {
                        s += &format!(" AND {e} <= {t}");
                    }
                    s
                })
            }
            "time" => {
                let col = if c.field.as_deref() == Some("created") { "c.created_at" } else { "c.updated_at" };
                let mut s = format!("{col} IS NOT NULL");
                if let Some(f) = c.from_ms {
                    s += &format!(" AND {col} >= {}", self.arg(f));
                }
                if let Some(t) = c.to_ms {
                    s += &format!(" AND {col} < {}", self.arg(t));
                }
                s
            }
            "text" => {
                let words: Vec<String> = c.v.first().map(|t| t.split_whitespace().map(str::to_owned).collect()).unwrap_or_default();
                let target = if self.cards { "(COALESCE(c.title, '') || char(10) || COALESCE(c.text, ''))" } else { "b.text" };
                let parts: Vec<String> = words.iter().map(|w| format!("{target} LIKE {} ESCAPE '\\'", self.arg(like(w)))).collect();
                if parts.is_empty() { "1".into() } else { parts.join(" AND ") }
            }
            "in" => match c.v.first().map(String::as_str) {
                Some("cards") => "c.kind != 'journal'".into(),
                Some("journal") => "c.kind = 'journal'".into(),
                Some("inbox") => "c.inbox_at IS NOT NULL".into(),
                Some("card") => format!("c.card_id = {}", self.arg(c.v.get(1).cloned().unwrap_or_default())),
                Some("topic") => format!("EXISTS (SELECT 1 FROM idx.card_topics ct WHERE ct.card_id = c.card_id AND ct.topic = {})", self.arg(c.v.get(1).cloned().unwrap_or_default())),
                _ => "0".into(),
            },
            "links" => {
                if let Some(bid) = &c.block {
                    let p = self.arg(bid.clone());
                    self.on_block(|x| format!("EXISTS (SELECT 1 FROM idx.refs r WHERE r.from_card = {x}.card_id AND r.from_bid = {x}.bid AND r.to_bid = {p})"))
                } else {
                    let p = self.arg(c.card.clone().unwrap_or_default());
                    self.on_block(|x| format!("EXISTS (SELECT 1 FROM idx.links l WHERE l.from_card = {x}.card_id AND l.from_bid = {x}.bid AND l.to_card = {p})"))
                }
            }
            // A condition this version does not know matches nothing (the
            // frontend shows such a query as needing an update instead).
            _ => "0".into(),
        }
    }

    /// ORDER BY for the asked order, empty values last, then the card
    /// edited last and document order (as the memory engine).
    fn order(&self, sort: &[SortBy]) -> String {
        let mut keys: Vec<String> = Vec::new();
        for s in sort {
            let e = match (s.by.as_str(), self.cards) {
                ("due", false) => "COALESCE(b.deadline, b.scheduled)",
                ("priority", false) => {
                    "CASE WHEN b.task_status IS NULL THEN NULL WHEN b.priority = 'urgent' THEN 0 WHEN b.priority = 'high' THEN 1
                          WHEN b.priority = 'medium' THEN 2 WHEN b.priority = 'low' THEN 3 ELSE 4 END"
                }
                ("created", _) => "c.created_at",
                ("updated", _) => "c.updated_at",
                ("day", _) => "CASE WHEN c.kind = 'journal' THEN substr(c.card_id, 9) ELSE date(c.updated_at / 1000, 'unixepoch', 'localtime') END",
                ("title", _) => "lower(c.title)",
                _ => continue,
            };
            keys.push(format!("({e}) IS NULL, ({e}){}", if s.desc { " DESC" } else { "" }));
        }
        keys.push("c.updated_at DESC, c.card_id".into());
        if !self.cards {
            keys.push("b.rowid".into());
        }
        keys.join(", ")
    }
}

impl Store {
    /// A query block's rows (design/query.md §7).
    pub fn query(&self, q: &ResolvedQuery) -> Result<QueryRows> {
        let cards = q.show == "cards";
        let mut sql = Sql { args: Vec::new(), ctes: Vec::new(), cards };
        let mut filter = String::from("c.deleted_at IS NULL");
        if cards {
            filter += " AND c.kind != 'journal'";
        } else if q.show == "tasks" {
            filter += " AND b.task_status IS NOT NULL";
        }
        if !q.include_inbox {
            filter += " AND c.inbox_at IS NULL";
        }
        if !q.exclude.is_empty() {
            filter += &format!(" AND c.card_id NOT IN {}", sql.list(&q.exclude));
        }
        let cond = if q.where_.is_empty() { "1".to_owned() } else { sql.group(&q.where_, q.match_ == "any") };
        let order = sql.order(&q.sort);
        let with = if sql.ctes.is_empty() { String::new() } else { format!("WITH RECURSIVE {} ", sql.ctes.join(", ")) };
        let from = if cards { "idx.cards c" } else { "idx.blocks b JOIN idx.cards c ON c.card_id = b.card_id" };
        let body = format!("FROM {from} WHERE {filter} AND {cond}");

        let total: u32 = self.conn.query_row(&format!("{with}SELECT COUNT(*) {body}"), rusqlite::params_from_iter(sql.args.iter()), |r| r.get(0))?;
        let limit = sql.arg(i64::from(q.limit.min(500)));
        let mut out = QueryRows { total, ..Default::default() };
        let args = rusqlite::params_from_iter(sql.args.iter());
        if cards {
            out.cards = self.query_cards(
                &format!("{with}SELECT c.card_id, c.kind, c.title, c.preview, c.created_at, c.updated_at, c.inbox_from {body} ORDER BY {order} LIMIT {limit}"),
                args,
            )?;
            return Ok(out);
        }
        let mut stmt = self.conn.prepare(&format!(
            "{with}SELECT b.card_id, c.title, c.kind, b.bid, b.text, b.task_status, b.priority, b.deadline, b.scheduled, c.updated_at {body} ORDER BY {order} LIMIT {limit}"
        ))?;
        let rows = stmt.query_map(args, |r| {
            Ok(TaskRow {
                card_id: r.get(0)?,
                card_title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                card_kind: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                bid: r.get(3)?,
                text: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                status: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                priority: r.get(6)?,
                deadline: r.get(7)?,
                scheduled: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        let rows: Vec<TaskRow> = rows.collect::<std::result::Result<_, _>>()?;
        if q.show == "tasks" {
            out.tasks = rows;
        } else {
            for t in rows {
                let children = self.child_blocks(&t.card_id, &t.bid)?;
                out.blocks.push(Backlink { card_id: t.card_id, card_title: t.card_title, card_kind: t.card_kind, bid: t.bid, text: t.text, via: "query".into(), children });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Origin;
    use folio_core::body::{add_block, push_inline, push_text};
    use folio_core::card::{self, CardKind};
    use folio_core::{DocId, DocKind};
    use loro::{ExportMode, LoroDoc, LoroValue, TreeID};

    /// Noon (UTC) of a day in 2026, in ms: the same day in any time zone.
    fn at(month: u32, day: u32) -> i64 {
        // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
        let (y, m, d) = (2026i64, i64::from(month), i64::from(day));
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
        days * 86_400_000 + 12 * 3_600_000
    }

    /// An outline item: (bid, text, task (status, priority, deadline, scheduled), tag, link).
    struct Item<'a> {
        bid: &'a str,
        text: &'a str,
        task: Option<(&'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>)>,
        tag: Option<&'a str>,
        link: Option<&'a str>,
        under: Vec<Item<'a>>,
    }

    fn item<'a>(bid: &'a str, text: &'a str) -> Item<'a> {
        Item { bid, text, task: None, tag: None, link: None, under: Vec::new() }
    }
    fn task<'a>(bid: &'a str, text: &'a str, status: &'a str, prio: Option<&'a str>, deadline: Option<&'a str>, scheduled: Option<&'a str>) -> Item<'a> {
        Item { task: Some((status, prio, deadline, scheduled)), ..item(bid, text) }
    }

    fn write(doc: &LoroDoc, parent: Option<TreeID>, items: &[Item]) -> loro::LoroResult<()> {
        let list = add_block(doc, parent, "bulletList", &[])?;
        for it in items {
            let mut attrs = vec![("bid", LoroValue::from(it.bid))];
            if let Some((status, prio, deadline, scheduled)) = it.task {
                attrs.push(("checked", LoroValue::from(status == "done")));
                if status != "done" && status != "todo" {
                    attrs.push(("status", LoroValue::from(status)));
                }
                for (k, v) in [("priority", prio), ("deadline", deadline), ("scheduled", scheduled)] {
                    if let Some(v) = v {
                        attrs.push((k, LoroValue::from(v)));
                    }
                }
            }
            let node = add_block(doc, Some(list), if it.task.is_some() { "taskItem" } else { "listItem" }, &attrs)?;
            let p = add_block(doc, Some(node), "paragraph", &[])?;
            push_text(doc, p, it.text)?;
            if let Some(tag) = it.tag {
                push_inline(doc, p, "tag", &[("name", tag)])?;
            }
            if let Some(to) = it.link {
                push_inline(doc, p, "cardLink", &[("cardId", to), ("title", "")])?;
            }
            if !it.under.is_empty() {
                write(doc, Some(node), &it.under)?;
            }
        }
        Ok(())
    }

    fn note(s: &mut Store, title: &str, created: i64, edited: i64, items: Vec<Item>) -> DocId {
        let id = s.create_card(CardKind::Note, title, created).unwrap();
        s.edit(&id, DocKind::Card, edited, |doc| write(doc, None, &items)).unwrap();
        id
    }

    fn journal(s: &mut Store, day: u32, edited: i64, items: Vec<Item>) -> DocId {
        let id = DocId::journal(2026, 11, day).unwrap();
        let doc = LoroDoc::new();
        card::init_card(&doc, CardKind::Journal, "", edited).unwrap();
        write(&doc, None, &items).unwrap();
        s.apply_update(&id, DocKind::Card, &doc.export(ExportMode::all_updates()).unwrap(), Origin::Local, edited).unwrap();
        id
    }

    fn cond(k: &str, v: &[&str]) -> ResolvedCond {
        ResolvedCond { k: k.into(), v: v.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }
    fn date(field: &str, from: Option<&str>, to: Option<&str>) -> ResolvedCond {
        ResolvedCond { k: "date".into(), field: Some(field.into()), from: from.map(Into::into), to: to.map(Into::into), ..Default::default() }
    }
    fn group(any: bool, where_: Vec<ResolvedCond>) -> ResolvedCond {
        ResolvedCond { k: "group".into(), match_: Some(if any { "any" } else { "all" }.into()), where_, ..Default::default() }
    }
    fn not(mut c: ResolvedCond) -> ResolvedCond {
        c.not = true;
        c
    }
    const OPEN: [&str; 4] = ["backlog", "todo", "doing", "review"];

    fn query(show: &str, where_: Vec<ResolvedCond>, sort: &[(&str, bool)], exclude: &[&DocId]) -> ResolvedQuery {
        ResolvedQuery {
            show: show.into(),
            match_: "all".into(),
            where_,
            sort: sort.iter().map(|(by, desc)| SortBy { by: by.to_string(), desc: *desc }).collect(),
            exclude: exclude.iter().map(|d| d.to_string()).collect(),
            include_inbox: false,
            limit: 20,
        }
    }

    #[test]
    fn query_blocks_list_what_their_conditions_ask_for() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let project = note(
            &mut s,
            "项目 A",
            at(11, 1),
            at(11, 1) + 50,
            vec![
                Item { tag: Some("项目A"), ..item("p0", "") },
                task("p1", "接口文档", "doing", None, None, Some("2026-11-12")),
                task("p2", "评审材料", "todo", Some("high"), Some("2026-11-14"), None),
                task("p3", "上线", "done", None, None, None),
            ],
        );
        let p = project.to_string();
        let j8 = journal(
            &mut s,
            8,
            at(11, 8) + 40,
            vec![
                Item { tag: Some("项目A"), under: vec![task("j1", "确认首页稿", "todo", None, Some("2026-11-10"), None)], ..item("j0", "") },
                task("j2", "买菜", "todo", None, None, Some("2026-11-12")),
                Item { link: Some("zhang"), ..item("j3", "见了 张三") },
            ],
        );
        journal(
            &mut s,
            11,
            at(11, 11) + 60,
            vec![Item { link: Some(&p), ..task("k1", "约张三过排期", "todo", Some("urgent"), None, Some("2026-11-13")) }, task("k2", "写周报", "todo", None, None, None)],
        );
        let tpl = note(&mut s, "模板", at(11, 12), at(11, 12), vec![task("t1", "模板里的任务", "todo", None, None, None)]);
        let inbox = note(&mut s, "收集", at(11, 12), at(11, 12), vec![task("i1", "收集箱里的任务", "todo", None, None, None)]);
        s.set_inbox(&inbox, true, at(11, 12)).unwrap();
        let reading = note(&mut s, "读书", at(10, 1), at(10, 1) + 30, vec![Item { tag: Some("读书"), ..item("r1", "三体") }]);
        s.set_card_topic(&reading, "work", true, at(10, 1) + 30).unwrap();

        let tasks = |q: ResolvedQuery| s.query(&q).unwrap().tasks.into_iter().map(|t| t.text).collect::<Vec<_>>();
        let by_due = [("due", false), ("priority", false)];

        // Open tasks about this card, soonest first; never templates or the inbox.
        let about = group(true, vec![cond("in", &["card", &p]), ResolvedCond { k: "links".into(), card: Some(p.clone()), ..Default::default() }]);
        assert_eq!(tasks(query("tasks", vec![cond("task", &OPEN), about], &by_due, &[&tpl])), ["接口文档", "约张三过排期", "评审材料"]);
        let all = tasks(query("tasks", vec![], &by_due, &[&tpl]));
        assert!(!all.contains(&"模板里的任务".to_owned()) && !all.contains(&"收集箱里的任务".to_owned()));
        let mut q = query("tasks", vec![cond("in", &["inbox"])], &by_due, &[]);
        q.include_inbox = true;
        assert_eq!(tasks(q), ["收集箱里的任务"]);

        // A tag anywhere in a card; in a journal day only on the line above.
        assert_eq!(tasks(query("tasks", vec![cond("tag", &["项目a"]), cond("task", &OPEN)], &by_due, &[])), ["确认首页稿", "接口文档", "评审材料"]);

        // Dates.
        assert_eq!(tasks(query("tasks", vec![date("due", None, Some("2026-11-11"))], &by_due, &[])), ["确认首页稿"]);
        let none = ResolvedCond { none: true, ..date("due", None, None) };
        assert_eq!(tasks(query("tasks", vec![none.clone(), cond("task", &OPEN)], &by_due, &[&tpl, &inbox])), ["写周报"]);

        // Blocks: by journal day and link, with what is under them; by text.
        let blocks = |q: ResolvedQuery| s.query(&q).unwrap().blocks;
        let day = date("day", Some("2026-11-08"), Some("2026-11-08"));
        let link = ResolvedCond { k: "links".into(), card: Some("zhang".into()), ..Default::default() };
        assert_eq!(blocks(query("blocks", vec![cond("in", &["journal"]), day, link], &[("day", true)], &[])).iter().map(|b| b.text.as_str()).collect::<Vec<_>>(), ["见了 张三"]);
        let tagged = blocks(query("blocks", vec![cond("tag", &["项目a"]), cond("in", &["journal"])], &[("day", true)], &[]));
        assert_eq!(tagged[0].bid, "j0");
        assert_eq!(tagged[0].children.iter().map(|c| (c.bid.as_str(), c.depth)).collect::<Vec<_>>(), [("j1", 1)]);
        assert_eq!(blocks(query("blocks", vec![cond("text", &["周报"])], &[], &[])).iter().map(|b| b.bid.as_str()).collect::<Vec<_>>(), ["k2"]);

        // Cards: by time, topic and text, newest first.
        let cards = |q: ResolvedQuery| s.query(&q).unwrap().cards.into_iter().map(|c| c.id).collect::<Vec<_>>();
        let new = ResolvedCond { k: "time".into(), field: Some("created".into()), from_ms: Some(at(11, 1)), to_ms: Some(at(12, 1)), ..Default::default() };
        assert_eq!(cards(query("cards", vec![new], &[("updated", true)], &[&tpl])), [p.clone()]);
        assert_eq!(cards(query("cards", vec![cond("in", &["topic", "work"])], &[], &[])), [reading.to_string()]);
        assert_eq!(cards(query("cards", vec![cond("tag", &["读书"])], &[], &[])), [reading.to_string()]);
        assert_eq!(cards(query("cards", vec![], &[("updated", true)], &[&tpl])), [p.clone(), reading.to_string()]);

        // Order as asked (ties: the card edited last, then document order), limit and total.
        let open = || cond("task", &OPEN);
        assert_eq!(tasks(query("tasks", vec![open()], &[("priority", false), ("due", true)], &[&tpl])), ["约张三过排期", "评审材料", "买菜", "接口文档", "确认首页稿", "写周报"]);
        let mut q = query("tasks", vec![open()], &by_due, &[&tpl]);
        q.limit = 2;
        let r = s.query(&q).unwrap();
        assert_eq!((r.tasks.len(), r.total), (2, 6));

        // Negation, of a condition and of a group.
        assert_eq!(tasks(query("tasks", vec![open(), not(cond("in", &["journal"]))], &by_due, &[&tpl])), ["接口文档", "评审材料"]);
        assert_eq!(tasks(query("tasks", vec![open(), not(group(true, vec![cond("tag", &["项目a"]), none]))], &by_due, &[&tpl])), ["买菜", "约张三过排期"]);
        let _ = j8;
    }
}
