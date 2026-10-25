import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  addItem,
  addMindChild,
  addMindRoot,
  attach,
  branchColor,
  childrenOf,
  COLORS,
  descendants,
  detach,
  duplicateItems,
  hiddenByFold,
  inMap,
  mindLayout,
  mindLinks,
  mindToCard,
  MIND_GAP_X,
  MIND_GAP_Y,
  readEdges,
  readItems,
  removeItems,
  rootOf,
  setCollapsed,
  toJsonCanvas,
} from "../src/docs/board";

const device = (peer: bigint) => {
  const d = new LoroDoc();
  d.setPeerId(peer);
  return d;
};
const sync = (a: LoroDoc, b: LoroDoc) => {
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
};
const byId = (doc: LoroDoc, id: string) => readItems(doc).find((i) => i.id === id)!;
const size = () => ({ w: 100, h: 40 });

describe("mind maps on a whiteboard", () => {
  it("builds a tree: children in order, siblings in between", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 }, "中心主题");
    const a = addMindChild(doc, root, { text: "A" });
    const c = addMindChild(doc, root, { text: "C" });
    const b = addMindChild(doc, root, { after: a, text: "B" });
    const a1 = addMindChild(doc, a, { text: "A1" });
    const items = readItems(doc);
    expect(childrenOf(items, root).map((i) => i.text)).toEqual(["A", "B", "C"]);
    expect(descendants(items, root).sort()).toEqual([a, b, c, a1].sort());
    expect(rootOf(items, a1)?.id).toBe(root);
    expect(items.every((i) => inMap(items, i))).toBe(true);
  });

  it("lays out to the right, children centred on their parent", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 100, y: 200 });
    const a = addMindChild(doc, root);
    const b = addMindChild(doc, root);
    const pos = mindLayout(readItems(doc), size);
    expect(pos.get(root)).toEqual({ x: 100, y: 200 });
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    expect(pa.x).toBe(100 + 100 + MIND_GAP_X);
    expect(pb.y - pa.y).toBe(40 + MIND_GAP_Y);
    // Centred: the pair's middle is the root's middle.
    expect((pa.y + pb.y + 40) / 2).toBe(200 + 20);
  });

  it("folds a branch: no room, no lines, hidden nodes", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root);
    const a1 = addMindChild(doc, a);
    addMindChild(doc, a);
    setCollapsed(doc, a, true);
    const items = readItems(doc);
    expect([...hiddenByFold(items)]).toHaveLength(2);
    expect(hiddenByFold(items).has(a1)).toBe(true);
    expect(mindLinks(items)).toEqual([{ parent: root, child: a }]);
    expect(mindLayout(items, size).has(a1)).toBe(false);
  });

  it("deleting a node takes its branch", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root);
    addMindChild(doc, a);
    const b = addMindChild(doc, root);
    removeItems(doc, [a]);
    expect(readItems(doc).map((i) => i.id).sort()).toEqual([root, b].sort());
  });

  it("moves branches, refuses loops, and lets cards join and leave", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root);
    const a1 = addMindChild(doc, a);
    const b = addMindChild(doc, root);
    expect(attach(doc, a, a1)).toBe(false);
    expect(attach(doc, a, b)).toBe(true);
    expect(byId(doc, a).parent).toBe(b);
    expect(rootOf(readItems(doc), a1)?.id).toBe(root);

    const card = addItem(doc, { kind: "card", cardId: "c1", x: 900, y: 900 });
    expect(attach(doc, card, root)).toBe(true);
    expect(childrenOf(readItems(doc), root).at(-1)?.id).toBe(card);

    detach(doc, card, { x: 500, y: 500 });
    const free = byId(doc, card);
    expect(free).toMatchObject({ parent: undefined, root: false, x: 500, y: 500 });
    // A text node taken out keeps its branch as a map of its own.
    detach(doc, a, { x: 0, y: 600 });
    expect(byId(doc, a).root).toBe(true);
    expect(rootOf(readItems(doc), a1)?.id).toBe(a);
  });

  it("turns a text node into a card in place", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root, { text: "想法" });
    mindToCard(doc, a, "c9");
    expect(byId(doc, a)).toMatchObject({ kind: "card", cardId: "c9", parent: root, text: undefined });
  });

  it("colours first-level branches in turn; children inherit", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root);
    const b = addMindChild(doc, root);
    const b1 = addMindChild(doc, b);
    const items = readItems(doc);
    expect(branchColor(items, a)).toBe(COLORS[0]);
    expect(branchColor(items, b1)).toBe(COLORS[1]);
    expect(branchColor(items, root)).toBeUndefined();
  });

  it("survives a parent deleted on another device", () => {
    const one = device(1n);
    const root = addMindRoot(one, { x: 0, y: 0 });
    const a = addMindChild(one, root);
    const two = device(2n);
    sync(one, two);
    removeItems(one, [a]);
    const late = addMindChild(two, a, { text: "迟到" });
    sync(one, two);
    const items = readItems(one);
    const orphan = items.find((i) => i.id === late)!;
    expect(orphan).toBeDefined();
    expect(inMap(items, orphan)).toBe(false);
    expect(mindLayout(items, size).has(late)).toBe(false);
  });

  it("copies a map with its links, and exports it", () => {
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 }, "中心");
    const a = addMindChild(doc, root, { text: "A" });
    const copies = duplicateItems(doc, readItems(doc), readEdges(doc), 0, 300);
    const items = readItems(doc);
    const [r2, a2] = copies.map((id) => items.find((i) => i.id === id)!);
    expect(r2.root).toBe(true);
    expect(a2.parent).toBe(r2.id);
    // Copying a child alone makes it a centre.
    const [solo] = duplicateItems(doc, [byId(doc, a)], [], 0, 600);
    expect(byId(doc, solo).root).toBe(true);

    const canvas = JSON.parse(toJsonCanvas(readItems(doc), [], () => ""));
    expect(canvas.nodes.find((n: { id: string }) => n.id === a)).toMatchObject({ type: "text", text: "A" });
    expect(canvas.edges).toContainEqual(expect.objectContaining({ fromNode: root, toNode: a }));
  });
});

describe("mind map ordering", () => {
  it("moves a node among its siblings and makes free cards centres", async () => {
    const { moveSibling, makeRoot } = await import("../src/docs/board");
    const doc = device(1n);
    const root = addMindRoot(doc, { x: 0, y: 0 });
    const a = addMindChild(doc, root, { text: "A" });
    addMindChild(doc, root, { text: "B" });
    moveSibling(doc, a, 1);
    expect(childrenOf(readItems(doc), root).map((i) => i.text)).toEqual(["B", "A"]);
    moveSibling(doc, a, 1);
    expect(childrenOf(readItems(doc), root).map((i) => i.text)).toEqual(["B", "A"]);
    const card = addItem(doc, { kind: "card", cardId: "c1", x: 0, y: 500 });
    makeRoot(doc, card);
    addMindChild(doc, card, { text: "x" });
    expect(inMap(readItems(doc), byId(doc, card))).toBe(true);
  });
});
