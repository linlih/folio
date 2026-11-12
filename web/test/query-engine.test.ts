import { describe, expect, it } from "vitest";
import type { IndexBlock } from "../src/docs/index";
import { runQuery, type EngineCard } from "../src/query/engine";
import { periodRange, resolveQuery, type QueryContext } from "../src/query/resolve";
import { parse, type Names } from "../src/query/syntax";

const ctx: QueryContext = { cardId: "project", day: null, today: "2026-11-12", firstDay: 1, templates: ["tpl"] };
const names: Names = { cards: (t) => (t === "张三" ? ["zhang"] : []), cardTitle: () => null, topics: (n) => (n === "工作" ? ["work"] : []), topicName: () => null };

const spec = (text: string) => {
  const r = parse(text, names);
  if (!r.ok) throw new Error(r.error.code);
  return r.spec;
};

type B = Partial<IndexBlock> & { bid: string };
const block = (b: B): IndexBlock => ({ parent: null, kind: b.task ? "taskItem" : "listItem", text: "", ...b });
const task = (bid: string, text: string, status = "todo", more: Partial<NonNullable<IndexBlock["task"]>> = {}, parent: string | null = null): IndexBlock =>
  block({ bid, text, parent, task: { status, priority: null, deadline: null, scheduled: null, ...more } });

function card(id: string, over: Partial<EngineCard> & { blocks?: IndexBlock[]; tags?: [string, string][]; links?: [string, string][] } = {}): EngineCard {
  const { blocks = [], tags = [], links = [], ...rest } = over;
  return {
    id,
    kind: id.startsWith("journal:") ? "journal" : "note",
    title: id,
    preview: "",
    createdAt: 0,
    updatedAt: 0,
    inboxAt: null,
    fromInbox: null,
    topics: [],
    index: { blocks, tags, links, refs: [] },
    ...rest,
  };
}

const library = (): EngineCard[] => [
  card("project", {
    title: "项目 A",
    updatedAt: 50,
    createdAt: new Date(2026, 10, 1).getTime(),
    blocks: [block({ bid: "p0", text: "#项目A" }), task("p1", "接口文档", "doing", { scheduled: "2026-11-12" }), task("p2", "评审材料", "todo", { deadline: "2026-11-14", priority: "high" }), task("p3", "上线", "done")],
    tags: [["p0", "项目A"]],
  }),
  card("journal:2026-11-08", {
    updatedAt: 40,
    blocks: [block({ bid: "j0", text: "#项目A" }), task("j1", "确认首页稿", "todo", { deadline: "2026-11-10" }, "j0"), task("j2", "买菜", "todo", { scheduled: "2026-11-12" }), block({ bid: "j3", text: "见了 张三" })],
    tags: [["j0", "项目A"]],
    links: [["j3", "zhang"]],
  }),
  card("journal:2026-11-11", { updatedAt: 60, blocks: [task("k1", "约张三过排期", "todo", { scheduled: "2026-11-13", priority: "urgent" }), task("k2", "写周报", "todo")], links: [["k1", "project"]] }),
  card("tpl", { updatedAt: 70, blocks: [task("t1", "模板里的任务")] }),
  card("inbox-card", { updatedAt: 80, inboxAt: 1, blocks: [task("i1", "收集箱里的任务")] }),
  card("reading", { title: "读书", updatedAt: 30, createdAt: new Date(2026, 9, 1).getTime(), topics: ["work"], blocks: [block({ bid: "r1", text: "三体" })], tags: [["r1", "读书"]] }),
];

const run = (text: string, c: QueryContext = ctx) => runQuery(library(), resolveQuery(spec(text), c));
const taskTexts = (text: string, c?: QueryContext) => run(text, c).tasks.map((t) => t.text);

describe("query: resolving", () => {
  it("works out weeks and months from the locale's first day", () => {
    expect(periodRange("this-week", ctx)).toEqual(["2026-11-09", "2026-11-15"]);
    expect(periodRange("last-week", { ...ctx, firstDay: 7 })).toEqual(["2026-11-01", "2026-11-07"]);
    expect(periodRange("next-month", ctx)).toEqual(["2026-12-01", "2026-12-31"]);
    expect(periodRange("last-month", { ...ctx, today: "2026-03-31" })).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("turns relative days, this card and the page's day into values", () => {
    const q = resolveQuery(spec("due:<=+7d in:this created:-7d.. day:page"), { ...ctx, day: "2026-11-03" });
    expect(q.where).toEqual([
      { k: "date", not: false, field: "due", from: null, to: "2026-11-19", none: false },
      { k: "in", not: false, v: ["card", "project"] },
      { k: "time", not: false, field: "created", fromMs: new Date(2026, 10, 5).getTime(), toMs: null },
      { k: "date", not: false, field: "day", from: "2026-11-03", to: "2026-11-03", none: false },
    ]);
    expect(q.show).toBe("tasks");
    expect(q.exclude).toEqual(["tpl"]);
    expect(resolveQuery(spec("task:open priority:>=high"), ctx).where).toEqual([
      { k: "task", not: false, v: ["backlog", "todo", "doing", "review"] },
      { k: "priority", not: false, v: ["urgent", "high"] },
    ]);
  });
});

describe("query: running in memory", () => {
  it("lists open tasks about this card, soonest first, never from templates or the inbox", () => {
    expect(taskTexts("task:open (in:this OR links:this)")).toEqual(["接口文档", "约张三过排期", "评审材料"]);
    expect(taskTexts("task:any")).not.toContain("模板里的任务");
    expect(taskTexts("task:any")).not.toContain("收集箱里的任务");
    expect(taskTexts("task:any in:inbox")).toEqual(["收集箱里的任务"]);
  });

  it("counts a tag on the line above, and anywhere in a card, but not anywhere in a journal day", () => {
    // In the card: tagged at its top. In the journal: under the tagged line only.
    expect(taskTexts("#项目A task:open")).toEqual(["确认首页稿", "接口文档", "评审材料"]);
    expect(run("show:cards #读书").cards.map((c) => c.id)).toEqual(["reading"]);
    expect(run("show:blocks #读书").blocks.map((b) => b.text)).toEqual(["三体"]);
  });

  it("filters by dates, overdue and none", () => {
    expect(taskTexts("due:<=+7d task:open")).toEqual(["确认首页稿", "接口文档", "买菜", "约张三过排期", "评审材料"]);
    expect(taskTexts("due:overdue")).toEqual(["确认首页稿"]);
    expect(taskTexts("due:none task:open")).toEqual(["写周报"]);
    expect(taskTexts("deadline:this-week")).toEqual(["确认首页稿", "评审材料"]);
  });

  it("finds blocks by journal day, link and text, with what is under them", () => {
    const r = run("show:blocks in:journal day:2026-11-08 links:[[张三]]");
    expect(r.blocks.map((b) => b.text)).toEqual(["见了 张三"]);
    expect(run("show:blocks #项目A in:journal").blocks[0].children).toEqual([{ bid: "j1", depth: 1, text: "确认首页稿" }]);
    expect(run("show:blocks 周报").blocks.map((b) => b.bid)).toEqual(["k2"]);
  });

  it("lists cards by time, topic and text, newest first", () => {
    expect(run("show:cards created:this-month").cards.map((c) => c.id)).toEqual(["project"]);
    expect(run("show:cards in:topic:工作").cards.map((c) => c.id)).toEqual(["reading"]);
    expect(run("show:cards").cards.map((c) => c.id)).toEqual(["project", "reading"]);
    expect(run("show:cards 三体").cards.map((c) => c.id)).toEqual(["reading"]);
  });

  it("sorts as asked, stops at the limit and says how many in all", () => {
    expect(taskTexts("task:open sort:priority,-due")).toEqual(["约张三过排期", "评审材料", "接口文档", "买菜", "确认首页稿", "写周报"]);
    const r = run("task:open limit:2");
    expect(r.tasks).toHaveLength(2);
    expect(r.total).toBe(6);
  });

  it("negates conditions and groups", () => {
    expect(taskTexts("task:open -in:journal")).toEqual(["接口文档", "评审材料"]);
    expect(taskTexts("task:open -(#项目A OR due:none)")).toEqual(["买菜", "约张三过排期"]);
  });
});
