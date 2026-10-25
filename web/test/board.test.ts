import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  addEdge,
  addItem,
  boardId,
  insideSection,
  itemsOfCards,
  placeItems,
  readEdges,
  readItems,
  removeItems,
  freeSpot,
  sectionAround,
  align,
  duplicateItems,
  setEdgeLook,
  setItemFlags,
  tidyUp,
  setColor,
  setEdgeLabel,
  toJsonCanvas,
} from "../src/docs/board";
import { DocHub } from "../src/docs/hub";
import { createBoard, deleteBoard, readBoards, renameBoard } from "../src/docs/workspace";
import { memoryBackend, MEMORY_FRONTEND_PEER } from "../src/platform/memory";

const device = (peer: bigint) => {
  const d = new LoroDoc();
  d.setPeerId(peer);
  return d;
};
const sync = (a: LoroDoc, b: LoroDoc) => {
  a.import(b.export({ mode: "update" }));
  b.import(a.export({ mode: "update" }));
};

describe("whiteboard document (§4.3)", () => {
  it("places cards, texts and sections with sizes and drawing order", () => {
    const doc = device(1n);
    const card = addItem(doc, { kind: "card", cardId: "c1", x: 10.4, y: 20 });
    const text = addItem(doc, { kind: "text", text: "想法", x: 400, y: 20 });
    const section = addItem(doc, { kind: "section", text: "基础", x: 0, y: 0 });
    const items = readItems(doc);
    // Sections draw first, under everything.
    expect(items.map((i) => i.id)).toEqual([section, card, text]);
    expect(items[1]).toMatchObject({ kind: "card", cardId: "c1", x: 10, y: 20, w: 280, h: 200 });
    placeItems(doc, [{ id: card, x: 50, w: 300 }]);
    expect(readItems(doc).find((i) => i.id === card)).toMatchObject({ x: 50, y: 20, w: 300 });
  });

  it("removing an item removes the lines to it", () => {
    const doc = device(1n);
    const a = addItem(doc, { kind: "text", text: "a", x: 0, y: 0 });
    const b = addItem(doc, { kind: "text", text: "b", x: 300, y: 0 });
    const e = addEdge(doc, { from: a, to: b, fromSide: "right", toSide: "left" })!;
    setEdgeLabel(doc, e, "导致");
    expect(readEdges(doc)).toMatchObject([{ from: a, to: b, label: "导致" }]);
    expect(addEdge(doc, { from: a, to: a })).toBeNull();
    removeItems(doc, [b]);
    expect(readEdges(doc)).toEqual([]);
  });

  it("merges a move on one device with a colour on another; a delete wins over a move", () => {
    const one = device(1n);
    const card = addItem(one, { kind: "card", cardId: "c1", x: 0, y: 0 });
    const other = addItem(one, { kind: "text", text: "t", x: 0, y: 300 });
    const two = device(2n);
    sync(one, two);
    placeItems(one, [{ id: card, x: 100, y: 50 }]);
    setColor(two, [card], "4");
    placeItems(two, [{ id: other, x: 500 }]);
    removeItems(one, [other]);
    sync(one, two);
    for (const d of [one, two]) {
      expect(readItems(d)).toMatchObject([{ id: card, x: 100, y: 50, color: "4" }]);
    }
  });

  it("ignores a line whose end another device deleted", () => {
    const one = device(1n);
    const a = addItem(one, { kind: "text", text: "a", x: 0, y: 0 });
    const b = addItem(one, { kind: "text", text: "b", x: 300, y: 0 });
    const two = device(2n);
    sync(one, two);
    removeItems(one, [b]);
    addEdge(two, { from: a, to: b });
    sync(one, two);
    expect(readEdges(one)).toEqual([]);
    expect(readEdges(two)).toEqual([]);
  });

  it("knows what lies inside a section, and draws one around items", () => {
    const doc = device(1n);
    const a = addItem(doc, { kind: "card", cardId: "c1", x: 100, y: 100 });
    const b = addItem(doc, { kind: "text", text: "t", x: 500, y: 150 });
    const items = readItems(doc);
    const box = sectionAround(items);
    const s = addItem(doc, { kind: "section", text: "小节", ...box });
    const section = readItems(doc).find((i) => i.id === s)!;
    expect(insideSection(section, readItems(doc)).sort()).toEqual([a, b].sort());
    expect(itemsOfCards(doc, ["c1"])).toEqual([a]);
  });

  it("puts a new card next to others instead of on top of them", () => {
    const doc = device(1n);
    addItem(doc, { kind: "card", cardId: "c1", x: 0, y: 0 });
    addItem(doc, { kind: "section", text: "s", x: -100, y: -100, w: 1000, h: 1000 });
    const items = readItems(doc);
    expect(freeSpot(items, { x: 600, y: 0 }, 280, 200)).toEqual({ x: 600, y: 0 });
    const spot = freeSpot(items, { x: 0, y: 0 }, 280, 200);
    const overlaps = spot.x < 280 && spot.x + 280 > 0 && spot.y < 200 && spot.y + 200 > 0;
    expect(overlaps).toBe(false);
  });

  it("exports JSON Canvas 1.0", () => {
    const doc = device(1n);
    const s = addItem(doc, { kind: "section", text: "基础", x: 0, y: 0, color: "2" });
    const c = addItem(doc, { kind: "card", cardId: "c1", x: 20, y: 40 });
    const t = addItem(doc, { kind: "text", text: "备注", x: 400, y: 40 });
    addEdge(doc, { from: c, to: t, toSide: "left", label: "见" });
    const json = JSON.parse(toJsonCanvas(readItems(doc), readEdges(doc), () => "# 卡片\n\n正文"));
    expect(json.nodes.map((n: { type: string }) => n.type)).toEqual(["group", "text", "text"]);
    expect(json.nodes[0]).toMatchObject({ id: s, label: "基础", color: "2", width: 480, height: 320 });
    expect(json.nodes[1]).toMatchObject({ id: c, text: "# 卡片\n\n正文", x: 20, y: 40 });
    expect(json.edges[0]).toMatchObject({ fromNode: c, toNode: t, toSide: "left", label: "见" });
  });

  it("is a document of its own, saved once it has something", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const id = boardId("0190f5a2-0000-7000-8000-000000000000");
    const h = await hub.open(id);
    await h.persistence.flush();
    expect(await backend.docSnapshot(id)).toBeNull();
    addItem(h.doc, { kind: "text", text: "hi", x: 0, y: 0 });
    await h.persistence.flush();
    const again = new LoroDoc();
    again.import((await backend.docSnapshot(id))!);
    expect(readItems(again).map((i) => i.text)).toEqual(["hi"]);
    expect(await backend.listCards()).toEqual([]);
  });

  it("folds cards, fits them to content, styles lines", () => {
    const doc = device(1n);
    const a = addItem(doc, { kind: "card", cardId: "c1", x: 0, y: 0 });
    const b = addItem(doc, { kind: "text", text: "t", x: 400, y: 0 });
    const s = addItem(doc, { kind: "section", text: "s", x: -50, y: -50 });
    const item = (id: string) => readItems(doc).find((i) => i.id === id)!;
    expect([item(a).fixed, item(a).folded, item(s).fixed]).toEqual([false, false, true]);
    setItemFlags(doc, [a], { folded: true, fixed: true });
    expect([item(a).fixed, item(a).folded]).toEqual([true, true]);
    setItemFlags(doc, [a], { folded: false, fixed: false });
    expect([item(a).fixed, item(a).folded]).toEqual([false, false]);
    const e = addEdge(doc, { from: a, to: b })!;
    expect(readEdges(doc)[0]).toMatchObject({ style: "solid", arrows: "end" });
    setEdgeLook(doc, e, { style: "dashed", arrows: "both" });
    expect(readEdges(doc)[0]).toMatchObject({ style: "dashed", arrows: "both" });
    const json = JSON.parse(toJsonCanvas(readItems(doc), readEdges(doc), () => ""));
    expect(json.edges[0]).toMatchObject({ fromEnd: "arrow" });
    setEdgeLook(doc, e, { arrows: "none" });
    expect(JSON.parse(toJsonCanvas(readItems(doc), readEdges(doc), () => "")).edges[0]).toMatchObject({ toEnd: "none" });
  });

  it("duplicates items with the lines between them; cards stay the same card", () => {
    const doc = device(1n);
    const a = addItem(doc, { kind: "card", cardId: "c1", x: 0, y: 0 });
    const b = addItem(doc, { kind: "text", text: "t", x: 400, y: 0 });
    addEdge(doc, { from: a, to: b, label: "因为" });
    const before = readItems(doc);
    const copies = duplicateItems(doc, before, readEdges(doc));
    const items = readItems(doc);
    expect(items).toHaveLength(4);
    const copyA = items.find((i) => i.id === copies[0])!;
    expect(copyA).toMatchObject({ kind: "card", cardId: "c1", x: 40, y: 40 });
    expect(readEdges(doc).filter((e) => e.label === "因为")).toHaveLength(2);
  });

  it("tidies items into a grid and aligns them", () => {
    const items = [
      { id: "a", x: 500, y: 10, w: 100, h: 50 },
      { id: "b", x: 0, y: 0, w: 100, h: 80 },
      { id: "c", x: 300, y: 400, w: 100, h: 50 },
    ].map((i) => ({ ...i, kind: "card" as const, z: 0, fixed: false, folded: false, order: 0, root: false, collapsed: false }));
    const placed = new Map(tidyUp(items, 20).map((p) => [p.id, p]));
    // Reading order b, a | c; two columns; rows as tall as their tallest.
    expect(placed.get("b")).toEqual({ id: "b", x: 0, y: 0 });
    expect(placed.get("a")).toEqual({ id: "a", x: 120, y: 0 });
    expect(placed.get("c")).toEqual({ id: "c", x: 0, y: 100 });
    expect(align(items, "left").map((p) => p.x)).toEqual([0, 0, 0]);
    expect(align(items, "bottom").map((p) => p.y)).toEqual([400, 370, 400]);
  });

  describe("the list of whiteboards (workspace document)", () => {
    it("makes, renames and deletes boards, newest first", () => {
      const ws = device(1n);
      const a = createBoard(ws, "投资地图", 1);
      const b = createBoard(ws, "读书", 2);
      renameBoard(ws, a, "资产配置地图");
      expect(readBoards(ws).map((x) => [x.id, x.name])).toEqual([
        [b, "读书"],
        [a, "资产配置地图"],
      ]);
      deleteBoard(ws, b, 3);
      expect(readBoards(ws).map((x) => x.id)).toEqual([a]);
    });

    it("merges boards made on two devices", () => {
      const one = device(1n);
      const two = device(2n);
      createBoard(one, "A", 1);
      createBoard(two, "B", 2);
      sync(one, two);
      expect(readBoards(one).map((x) => x.name)).toEqual(["B", "A"]);
      expect(readBoards(two)).toEqual(readBoards(one));
    });

    it("can keep an existing board document under its id", () => {
      const ws = device(1n);
      const id = "0190f5a2-0000-7000-8000-000000000000";
      expect(createBoard(ws, "投资", 1, id)).toBe(id);
      expect(boardId(readBoards(ws)[0].id)).toBe(`board:${id}`);
    });
  });
});
