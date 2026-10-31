import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import type { TagCard } from "../src/bindings/commands";
import { appendTag, bodyFacts, readProps, setProp } from "../src/docs/card";
import { addField, addOption, boardField, deleteField, groupRows, readDatabase, renameField, restoreField, setView, sortRows, toRow, DEFAULT_VIEW } from "../src/docs/database";
import { memoryBackend } from "../src/platform/memory";

const peer = (n: bigint) => {
  const d = new LoroDoc();
  d.setPeerId(n);
  return d;
};
const sync = (a: LoroDoc, b: LoroDoc) => {
  a.import(b.export({ mode: "update" }));
  b.import(a.export({ mode: "update" }));
};

describe("a tag's database", () => {
  it("has fields in order, choices, and a view", () => {
    const ws = new LoroDoc();
    // Only a mark so far: every block with it.
    expect(readDatabase(ws, "书")).toEqual({ fields: [], view: { ...DEFAULT_VIEW, mode: "blocks" } });
    setView(ws, "书", { sortBy: "title" });
    expect(readDatabase(ws, "书").view.mode).toBe("blocks");
    setView(ws, "书", { sortBy: "created" });
    const status = addField(ws, "书", "状态", "select", 1);
    // With fields, the table; and a view once chosen stays.
    expect(readDatabase(ws, "书").view.mode).toBe("table");
    setView(ws, "书", { mode: "blocks" });
    expect(readDatabase(ws, "书").view.mode).toBe("blocks");
    setView(ws, "书", { mode: "table" });
    const rating = addField(ws, "书", " 评分 ", "number", 2);
    const want = addOption(ws, "书", status, "想读", 3)!;
    const reading = addOption(ws, "书", status, "在读", 4)!;
    expect(addOption(ws, "书", status, "  ")).toBeNull();
    // The tag in another case is the same database.
    const db = readDatabase(ws, "书".toUpperCase());
    expect(db.fields.map((f) => [f.name, f.type])).toEqual([
      ["状态", "select"],
      ["评分", "number"],
    ]);
    expect(db.fields[0].options.map((o) => [o.id, o.name])).toEqual([
      [want, "想读"],
      [reading, "在读"],
    ]);
    expect(new Set(db.fields[0].options.map((o) => o.color)).size).toBe(2);
    renameField(ws, "书", rating, "打分");
    setView(ws, "书", { mode: "board", groupBy: status, sortBy: rating, sortDesc: false });
    expect(readDatabase(ws, "书").view).toEqual({ mode: "board", groupBy: status, sortBy: rating, sortDesc: false });
    deleteField(ws, "书", rating);
    expect(readDatabase(ws, "书").fields.map((f) => f.name)).toEqual(["状态"]);
    restoreField(ws, "书", rating);
    expect(readDatabase(ws, "书").fields.map((f) => f.name)).toEqual(["状态", "打分"]);
    expect(readDatabase(ws, "other").fields).toEqual([]);
  });

  it("keeps fields two devices add at once", () => {
    const a = peer(1n);
    const b = peer(2n);
    addField(a, "项目", "状态", "select", 1);
    addField(b, "项目", "截止", "date", 2);
    sync(a, b);
    expect(readDatabase(a, "项目").fields.map((f) => f.name).sort()).toEqual(["截止", "状态"]);
    expect(readDatabase(b, "项目")).toEqual(readDatabase(a, "项目"));
    // Choices added to the same field on both.
    const id = readDatabase(a, "项目").fields.find((f) => f.type === "select")!.id;
    addOption(a, "项目", id, "进行中", 3);
    addOption(b, "项目", id, "完成", 4);
    sync(a, b);
    expect(readDatabase(a, "项目").fields.find((f) => f.id === id)!.options.map((o) => o.name).sort()).toEqual(["完成", "进行中"]);
  });

  it("sorts rows with empty values last, and groups them by a choice", () => {
    const ws = new LoroDoc();
    const status = addField(ws, "书", "状态", "select", 1);
    const rating = addField(ws, "书", "评分", "number", 2);
    const [todo, doing] = ["想读", "在读"].map((n, i) => addOption(ws, "书", status, n, 3 + i)!);
    const db = readDatabase(ws, "书");
    const card = (id: string, title: string, updatedAt: number, props: object): TagCard => ({ id, title, preview: "", createdAt: updatedAt, updatedAt, url: null, props: JSON.stringify(props) });
    const rows = [
      card("a", "Alpha", 1, { [rating]: 3, [status]: doing }),
      card("b", "beta", 2, { [rating]: 10 }),
      card("c", "", 3, { [status]: todo }),
      card("d", "Delta", 4, { [status]: "gone-option" }),
    ].map(toRow);
    const ids = (r: { id: string }[]) => r.map((x) => x.id);
    expect(ids(sortRows(rows, db.fields, { sortBy: rating, sortDesc: true }, "en"))).toEqual(["b", "a", "c", "d"]);
    expect(ids(sortRows(rows, db.fields, { sortBy: rating, sortDesc: false }, "en"))).toEqual(["a", "b", "c", "d"]);
    expect(ids(sortRows(rows, db.fields, DEFAULT_VIEW, "en"))).toEqual(["a", "b", "c", "d"]);
    expect(ids(sortRows(rows, db.fields, { sortBy: "title", sortDesc: false }, "en"))).toEqual(["a", "b", "d", "c"]);
    expect(ids(sortRows(rows, db.fields, { sortBy: "updated", sortDesc: true }, "en"))).toEqual(["d", "c", "b", "a"]);
    // A select field sorts by its choices' order, not their names.
    expect(ids(sortRows(rows, db.fields, { sortBy: status, sortDesc: false }, "en")).slice(0, 2)).toEqual(["c", "a"]);
    const columns = groupRows(rows, boardField(db)!);
    expect(columns.map((c) => [c.option?.name ?? null, ids(c.rows)])).toEqual([
      ["想读", ["c"]],
      ["在读", ["a"]],
      [null, ["b", "d"]],
    ]);
    expect(toRow({ ...rows[0], props: "not json" } as unknown as TagCard).values).toEqual({});
  });
});

describe("cards of a database", () => {
  it("are the cards with the tag, with their values", async () => {
    let t = 1000;
    const b = memoryBackend(() => t++);
    const id = await b.createCard("三体");
    const doc = new LoroDoc();
    doc.import((await b.docSnapshot(id))!);
    const v = doc.oplogVersion();
    appendTag(doc, "书");
    doc.commit();
    setProp(doc, "f1", "x");
    expect(bodyFacts(doc).tags).toEqual(["书"]);
    await b.applyUpdate(id, "card", doc.export({ mode: "update", from: v }));
    await b.createCard("没有标签");
    const rows = await b.tagCards("书");
    expect(rows.map((r) => [r.id, JSON.parse(r.props)])).toEqual([[id, { f1: "x" }]]);
    expect(readProps(doc)).toEqual({ f1: "x" });
    await b.trashCard(id);
    expect(await b.tagCards("书")).toEqual([]);
  });
});
