import { describe, expect, it } from "vitest";
import type { QuerySpec } from "../src/query/spec";
import { format, namesIn, parse, type Names } from "../src/query/syntax";

const names: Names = {
  cards: (t) => ({ 张三: ["c-zhang"], "Two Words": ["c-two"], 重名: ["a", "b"] })[t] ?? [],
  cardTitle: (id) => ({ "c-zhang": "张三", "c-two": "Two Words" })[id] ?? null,
  topics: (n) => ({ 工作: ["t-work"] })[n] ?? [],
  topicName: (id) => ({ "t-work": "工作" })[id] ?? null,
};

const ok = (src: string) => {
  const r = parse(src, names);
  if (!r.ok) throw new Error(`${src}: ${r.error.code} ${JSON.stringify(r.error.params ?? {})}`);
  return r.spec;
};
const err = (src: string) => {
  const r = parse(src, names);
  if (r.ok) throw new Error(`${src} parsed`);
  return r.error;
};

describe("query text syntax", () => {
  it("reads the design's examples, in either language", () => {
    const zh = ok("任务:未完成 #项目A 到期:<=+7天 排序:到期");
    const en = ok("task:open #projectA due:<=+7d sort:due");
    expect(zh).toEqual({ v: 1, match: "all", where: [{ k: "task", v: ["open"] }, { k: "tag", v: ["项目a"] }, { k: "due", v: { to: "+7d" } }], sort: [{ by: "due" }] });
    expect(en.where[2]).toEqual(zh.where[2]);
    expect(ok("(#工作 OR #副业) 显示:卡片 修改:本周")).toEqual({
      v: 1,
      match: "all",
      where: [{ k: "group", match: "any", where: [{ k: "tag", v: ["工作"] }, { k: "tag", v: ["副业"] }] }, { k: "updated", v: { period: "this-week" } }],
      show: "cards",
    });
  });

  it("reads full-width punctuation from a Chinese input method as ASCII", () => {
    expect(ok("任务：未完成，进行中 （在：本卡 或 链接：本卡） 到期：＜＝＋7天")).toEqual(ok("任务:未完成,进行中 (在:本卡 OR 链接:本卡) 到期:<=+7天"));
    expect(ok("“季度目标” 创建：－7天。。").where).toEqual([{ k: "text", v: "季度目标" }, { k: "created", v: { from: "-7d" } }]);
  });

  it("keeps quoted text as typed, colons and all", () => {
    expect(ok('"任务:" 12:30').where).toEqual([{ k: "text", v: "任务:" }, { k: "text", v: "12:30" }]);
    expect(ok('#"读书 笔记" 标题:"我的 查询"')).toMatchObject({ where: [{ k: "tag", v: ["读书 笔记"] }], title: "我的 查询" });
  });

  it("reads OR looser than spaces, and negation", () => {
    expect(ok("#a #b OR #c")).toEqual({
      v: 1,
      match: "any",
      where: [{ k: "group", match: "all", where: [{ k: "tag", v: ["a"] }, { k: "tag", v: ["b"] }] }, { k: "tag", v: ["c"] }],
    });
    expect(ok("-#归档 -在:日记 -(#a OR #b)").where).toEqual([
      { k: "tag", v: ["归档"], not: true },
      { k: "in", v: "journal", not: true },
      { k: "group", match: "any", where: [{ k: "tag", v: ["a"] }, { k: "tag", v: ["b"] }], not: true },
    ]);
  });

  it("reads dates, periods and ranges", () => {
    const d = (s: string) => ok(`due:${s}`).where[0];
    expect(d("today")).toEqual({ k: "due", v: { from: "today", to: "today" } });
    expect(d("本页")).toEqual({ k: "due", v: { from: "page", to: "page" } });
    expect(d(">2026-1-5")).toEqual({ k: "due", v: { from: "2026-01-05", xfrom: true } });
    expect(d("-7d..+2周")).toEqual({ k: "due", v: { from: "-7d", to: "+2w" } });
    expect(d("已过期")).toEqual({ k: "due", v: { is: "overdue" } });
    expect(d("none")).toEqual({ k: "due", v: { is: "none" } });
    expect(d("上月")).toEqual({ k: "due", v: { period: "last-month" } });
    expect(err("due:2026-02-30").code).toBe("badValue");
    expect(err("created:overdue").code).toBe("badValue");
  });

  it("looks up cards and topics by name, and says when it cannot", () => {
    expect(ok("links:[[张三]] in:topic:工作").where).toEqual([{ k: "links", v: { card: "c-zhang" } }, { k: "in", v: { topic: "t-work" } }]);
    expect(ok('链接:"[[Two Words]]"').where).toEqual([{ k: "links", v: { card: "c-two" } }]);
    expect(err("links:[[没有]]")).toMatchObject({ code: "noCard", params: { name: "没有" } });
    expect(err("links:[[重名]]")).toMatchObject({ code: "manyCards" });
    expect(namesIn("链接:[[张三]] 在：主题：工作")).toEqual({ cards: ["张三"], topics: ["工作"] });
  });

  it("points at mistakes and suggests the keyword meant", () => {
    const e = err("任务:未完成 到其:<=+7天");
    expect(e).toMatchObject({ code: "unknownKeyNear", params: { key: "到其", near: "到期" } });
    expect(e.at).toEqual([7, 15]);
    expect(err("taks:open").code).toBe("unknownKeyNear");
    expect(err("((#a OR #b))").code).toBe("nested");
    expect(err("(#a").code).toBe("unclosed");
    expect(err('"abc').code).toBe("unclosedQuote");
    expect(err("#a OR (#b OR #c) #d").code).toBe("nested");
    expect(err("状态=在读").code).toBe("fieldsLater");
    expect(err("limit:9999").code).toBe("badLimit");
    expect(err("-显示:卡片").code).toBe("negatedSetting");
    // A colon in ordinary text is just text.
    expect(ok("https://example.com").where).toEqual([{ k: "text", v: "https://example.com" }]);
  });

  it("writes every spec back to text that reads as the same spec", () => {
    const specs: QuerySpec[] = [
      ok("任务:未完成 (在:本卡 OR 链接:本卡) 到期:<=+7天 排序:到期,-优先级 分组:日期"),
      ok("显示:卡片 创建:-7天.. 排序:-创建 条数:50 显示为:表格 标题:\"新 卡片\""),
      ok("#a #b OR #c OR -(#d #e)"),
      ok('"任务:" -周报 #"读书 笔记" links:[[Two Words]] in:topic:工作 priority:>=high'),
      ok("day:2026-11-01..2026-11-07 deadline:<today scheduled:none completedless"),
      { v: 1, match: "any", where: [{ k: "group", match: "any", where: [{ k: "tag", v: ["x"] }, { k: "text", v: "y" }] }, { k: "task", v: ["done"] }] },
      { v: 1, match: "all", where: [{ k: "text", v: "OR" }, { k: "text", v: "-dash" }, { k: "text", v: "#not-a-tag" }] },
    ];
    for (const spec of specs)
      for (const lang of ["zh", "en"] as const) {
        const text = format(spec, lang, names);
        const back = parse(text, names);
        expect(back.ok ? back.spec : back.error, `${lang}: ${text}`).toEqual(spec);
      }
  });

  it("writes in the interface's language", () => {
    const spec = ok("task:open,doing due:<=+7d in:this sort:-updated");
    expect(format(spec, "zh")).toBe("任务:未完成,进行中 到期:<=+7天 在:本卡 排序:-修改");
    expect(format(spec, "en")).toBe("task:open,doing due:<=+7d in:this sort:-updated");
  });
});

describe("query summary", () => {
  it("says what the query lists in a few words", async () => {
    const { summary } = await import("../src/query/summary");
    const i18n = (await import("../src/i18n")).default;
    await i18n.changeLanguage("zh");
    expect(summary(ok("任务:未完成 (在:本卡 OR 链接:本卡) 到期:<=+7天"), "zh", names)).toBe("未完成任务 · 本卡相关 · 7 天内到期");
    expect(summary(ok("显示:卡片 创建:-7天.. -#归档"), "zh", names)).toBe("卡片 · 最近 7 天新建 · 不含 #归档");
    expect(summary(ok("在:日记 日期:本周 #想法,灵感 周报"), "zh", names)).toBe("块 · 在日记里 · 本周的日记 · #想法 或 #灵感 · 含“周报”");
    expect(summary(ok("链接:[[张三]] 截止:已过期"), "zh", names)).toBe("任务 · 链接到「张三」 · 已过截止日期");
    expect(summary(ok('标题:"我的" #a'), "zh", names)).toBe("我的");
    await i18n.changeLanguage("en");
    expect(summary(ok("task:open due:<=+1d"), "en", names)).toBe("Open tasks · due within 1 day");
    expect(summary(ok("priority:>=high"), "en", names)).toBe("Tasks · priority:>=high");
  });
});
