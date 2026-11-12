import { describe, expect, it } from "vitest";
import { bodyJson, initCard, renameTagIn, renameTagInSpec } from "../src/docs/card";
import { extractIndex } from "../src/docs/index";
import { readSpec } from "../src/query/spec";
import { format, type Names } from "../src/query/syntax";
import { bind, device, settle, sync } from "./helpers";

const spec = {
  v: 1,
  match: "all",
  where: [
    { k: "task", v: ["open"] },
    { k: "group", match: "any", where: [{ k: "in", v: "this" }, { k: "links", v: { card: "this" } }] },
    { k: "due", v: { to: "+7d" } },
    { k: "tag", v: ["项目a"], not: true },
  ],
  sort: [{ by: "due" }, { by: "priority", desc: true }],
};
const raw = JSON.stringify(spec);
const html = (s: string) => `<p>上面</p><div data-type="query" data-spec="${s.replace(/"/g, "&quot;")}"></div><p>下面</p>`;

describe("the query block", () => {
  it("is kept in the card and reaches another device as it was", async () => {
    const a = device(1n);
    initCard(a, "note", "", 1);
    const { editor } = await bind(a);
    editor.commands.setContent(html(raw));
    await settle();
    const node = (bodyJson(a) as { children: { nodeName: string; attributes: Record<string, unknown> }[] }).children.find((n) => n.nodeName === "query");
    expect(node?.attributes.spec).toBe(raw);
    expect(typeof node?.attributes.bid).toBe("string");
    const b = device(2n);
    sync(a, b);
    const other = await bind(b);
    await settle();
    expect(other.editor.getJSON().content?.map((n) => n.type)).toEqual(["paragraph", "query", "paragraph"]);
    expect(readSpec(other.editor.getJSON().content?.[1].attrs?.spec).spec?.where).toHaveLength(4);
    // Copied as text: its conditions, as written.
    expect(other.editor.getText({ blockSeparator: "|" })).toContain("-#项目a");
    editor.destroy();
    other.editor.destroy();
  });

  it("names the tags it asks for, and a rename renames them", async () => {
    const doc = device(3n);
    initCard(doc, "note", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent(html(raw));
    await settle();
    expect(extractIndex(doc).queryTags?.map(([, t]) => t)).toEqual(["项目a"]);
    expect(renameTagIn(doc, "项目A", "项目B")).toBe(1);
    await settle();
    expect(extractIndex(doc).queryTags?.map(([, t]) => t)).toEqual(["项目b"]);
    // A case change only: the spec keeps the lower-case name.
    expect(renameTagIn(doc, "项目b", "项目B")).toBe(0);
    editor.destroy();
  });

  it("merges a renamed tag into one already asked for, keeping what it does not know", () => {
    const merged = renameTagInSpec(JSON.stringify({ v: 1, match: "all", where: [{ k: "group", match: "any", where: [{ k: "tag", v: ["a", "b"] }] }], extra: 1 }), "a", "b");
    expect(JSON.parse(merged!.spec)).toEqual({ v: 1, match: "all", where: [{ k: "group", match: "any", where: [{ k: "tag", v: ["b"] }] }], extra: 1 });
    expect(renameTagInSpec(raw, "other", "x")).toBeNull();
    expect(renameTagInSpec("not json", "a", "b")).toBeNull();
  });

  it("reads as the Markdown export writes it (folio-io's query_text)", () => {
    const names: Names = { cards: () => [], cardTitle: (id) => (id === "c1" ? "张三" : null), topics: () => [], topicName: (id) => (id === "t1" ? "工作" : null) };
    const s = readSpec(raw).spec!;
    expect(format(s, "zh", names)).toBe("任务:未完成 (在:本卡 OR 链接:本卡) 到期:<=+7天 -#项目a 排序:到期,-优先级");
    expect(format(s, "en", names)).toBe("task:open (in:this OR links:this) due:<=+7d -#项目a sort:due,-priority");
    const other = readSpec(
      JSON.stringify({
        v: 1,
        match: "all",
        where: [
          { k: "links", v: { card: "c1" } },
          { k: "in", v: { topic: "t1" } },
          { k: "text", v: "a: b" },
          { k: "created", v: { period: "this-week" } },
        ],
        show: "cards",
        view: { limit: 5 },
        title: "看看",
      }),
    ).spec!;
    expect(format(other, "en", names)).toBe('links:[[张三]] in:topic:工作 "a: b" created:this-week show:cards limit:5 title:"看看"');
  });
});
