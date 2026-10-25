// A whiteboard (design/ARCHITECTURE.md §4.3): the document `board:<id>`
// holds where cards, texts and sections sit and the lines between them; the
// list of boards and their names is in the workspace document. Every item and edge is a map under its own new id, made by
// one device only, so its fields merge one by one (a move on one device, a
// colour on another).

import { LoroMap, type LoroDoc } from "loro-crdt";
import { uuidv7 } from "./ids";

export const BOARD_PREFIX = "board:";
/** The document of the whiteboard with this id. */
export const boardId = (id: string) => `${BOARD_PREFIX}${id}`;
export const isBoardId = (id: string) => id.startsWith(BOARD_PREFIX);

const ITEMS = "items";
const EDGES = "edges";
/** Origin of board edits (one undo history per board). */
export const BOARD_ORIGIN = "board";

/** `mind`: a text node of a mind map (§4.3); a card can be a map node too. */
export type ItemKind = "card" | "text" | "section" | "mind";
export type Side = "top" | "right" | "bottom" | "left";
/** JSON Canvas presets: "1" red … "6" purple. */
export type BoardColor = "1" | "2" | "3" | "4" | "5" | "6";
export const COLORS: BoardColor[] = ["1", "2", "3", "4", "5", "6"];

export interface BoardItem {
  id: string;
  kind: ItemKind;
  cardId?: string;
  /** A text item's text; a section's title. */
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drawing order; higher on top. */
  z: number;
  color?: BoardColor;
  /** A card or text grows with its content (Heptabase) until resized by
   *  hand; then `h` holds and it scrolls. Sections are always fixed. */
  fixed: boolean;
  /** A card folded to its title. */
  folded: boolean;
  /** Mind maps (§4.3): the node this one hangs under, its place among its
   *  siblings, whether it is a map's centre, and whether its branch is
   *  folded away. Nodes in a map are laid out from the centre's position. */
  parent?: string;
  order: number;
  root: boolean;
  collapsed: boolean;
}

export type LineStyle = "solid" | "dashed";
/** Arrowheads: at the end (default, as JSON Canvas), none, or both ends. */
export type Arrows = "end" | "none" | "both";

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  fromSide?: Side;
  toSide?: Side;
  label?: string;
  color?: BoardColor;
  style: LineStyle;
  arrows: Arrows;
}

export const DEFAULT_SIZE: Record<ItemKind, { w: number; h: number }> = {
  card: { w: 280, h: 200 },
  text: { w: 220, h: 80 },
  section: { w: 480, h: 320 },
  mind: { w: 160, h: 40 },
};

const num = (m: LoroMap, k: string, d = 0) => (typeof m.get(k) === "number" ? (m.get(k) as number) : d);
const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : undefined);
const commit = (doc: LoroDoc) => doc.commit({ origin: BOARD_ORIGIN });

export function readItems(doc: LoroDoc): BoardItem[] {
  const all = doc.getMap(ITEMS);
  const out: BoardItem[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap)) continue;
    const kind = str(m, "kind") as ItemKind | undefined;
    if (kind !== "card" && kind !== "text" && kind !== "section" && kind !== "mind") continue;
    const color = str(m, "color") as BoardColor | undefined;
    out.push({
      id,
      kind,
      cardId: str(m, "card_id"),
      text: str(m, "text"),
      x: num(m, "x"),
      y: num(m, "y"),
      w: num(m, "w", DEFAULT_SIZE[kind].w),
      h: num(m, "h", DEFAULT_SIZE[kind].h),
      z: num(m, "z"),
      color: color && COLORS.includes(color) ? color : undefined,
      fixed: kind === "section" || m.get("fixed") === true,
      folded: kind === "card" && m.get("folded") === true,
      parent: str(m, "parent"),
      order: num(m, "order"),
      root: m.get("root") === true,
      collapsed: m.get("collapsed") === true,
    });
  }
  // Sections under everything else, then by drawing order.
  return out.sort((a, b) => Number(b.kind === "section") - Number(a.kind === "section") || a.z - b.z || (a.id < b.id ? -1 : 1));
}

/** Edges whose two ends are on the board (an end may have been deleted on
 *  another device). */
export function readEdges(doc: LoroDoc, items = readItems(doc)): BoardEdge[] {
  const ids = new Set(items.map((i) => i.id));
  const all = doc.getMap(EDGES);
  const out: BoardEdge[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap)) continue;
    const from = str(m, "from");
    const to = str(m, "to");
    if (!from || !to || !ids.has(from) || !ids.has(to)) continue;
    const arrows = str(m, "arrows");
    out.push({
      id,
      from,
      to,
      fromSide: str(m, "from_side") as Side | undefined,
      toSide: str(m, "to_side") as Side | undefined,
      label: str(m, "label"),
      color: str(m, "color") as BoardColor | undefined,
      style: str(m, "style") === "dashed" ? "dashed" : "solid",
      arrows: arrows === "none" || arrows === "both" ? arrows : "end",
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function topZ(doc: LoroDoc): number {
  return readItems(doc).reduce((z, i) => Math.max(z, i.z), 0);
}

export function addItem(
  doc: LoroDoc,
  item: Omit<BoardItem, "id" | "z" | "w" | "h" | "fixed" | "folded" | "order" | "root" | "collapsed"> & { w?: number; h?: number; order?: number; root?: boolean },
  now = Date.now(),
): string {
  const id = uuidv7(now);
  const m = doc.getMap(ITEMS).setContainer(id, new LoroMap());
  m.set("kind", item.kind);
  if (item.cardId) m.set("card_id", item.cardId);
  if (item.text !== undefined) m.set("text", item.text);
  m.set("x", Math.round(item.x));
  m.set("y", Math.round(item.y));
  m.set("w", Math.round(item.w ?? DEFAULT_SIZE[item.kind].w));
  m.set("h", Math.round(item.h ?? DEFAULT_SIZE[item.kind].h));
  m.set("z", topZ(doc) + 1);
  if (item.color) m.set("color", item.color);
  if (item.parent) m.set("parent", item.parent);
  if (item.order !== undefined) m.set("order", item.order);
  if (item.root) m.set("root", true);
  commit(doc);
  return id;
}

function itemMap(doc: LoroDoc, id: string): LoroMap | null {
  const m = doc.getMap(ITEMS).get(id);
  return m instanceof LoroMap ? m : null;
}

/** Moves (and resizes) items in one step. */
export function placeItems(doc: LoroDoc, changes: { id: string; x?: number; y?: number; w?: number; h?: number }[]) {
  let any = false;
  for (const c of changes) {
    const m = itemMap(doc, c.id);
    if (!m) continue;
    for (const k of ["x", "y", "w", "h"] as const) {
      const v = c[k];
      if (v !== undefined && num(m, k) !== Math.round(v)) {
        m.set(k, Math.round(v));
        any = true;
      }
    }
  }
  if (any) commit(doc);
}

export function setItemText(doc: LoroDoc, id: string, text: string) {
  const m = itemMap(doc, id);
  if (!m || str(m, "text") === text) return;
  m.set("text", text);
  commit(doc);
}

export function setColor(doc: LoroDoc, ids: string[], color: BoardColor | null) {
  for (const id of ids) {
    const m = itemMap(doc, id) ?? (doc.getMap(EDGES).get(id) instanceof LoroMap ? (doc.getMap(EDGES).get(id) as LoroMap) : null);
    if (!m) continue;
    if (color) m.set("color", color);
    else m.delete("color");
  }
  commit(doc);
}

/** Brings items to the top of the drawing order. */
export function raise(doc: LoroDoc, ids: string[]) {
  let z = topZ(doc);
  for (const id of ids) itemMap(doc, id)?.set("z", ++z);
  commit(doc);
}

/** Removes items and the edges that touch them, in one step; a map node
 *  takes its branch with it. */
export function removeItems(doc: LoroDoc, ids: string[]) {
  const gone = new Set(ids);
  for (const id of ids) for (const d of descendants(readItems(doc), id)) gone.add(d);
  ids = [...gone];
  const items = doc.getMap(ITEMS);
  for (const id of ids) items.delete(id);
  const edges = doc.getMap(EDGES);
  for (const id of edges.keys()) {
    const m = edges.get(id);
    if (m instanceof LoroMap && (gone.has(str(m, "from") ?? "") || gone.has(str(m, "to") ?? ""))) edges.delete(id);
  }
  commit(doc);
}

/** The items showing these cards (taking cards off the board). */
export function itemsOfCards(doc: LoroDoc, cardIds: string[]): string[] {
  const want = new Set(cardIds);
  return readItems(doc)
    .filter((i) => i.kind === "card" && i.cardId && want.has(i.cardId))
    .map((i) => i.id);
}

export function addEdge(doc: LoroDoc, edge: Omit<BoardEdge, "id" | "style" | "arrows"> & Partial<Pick<BoardEdge, "style" | "arrows">>, now = Date.now()): string | null {
  if (edge.from === edge.to) return null;
  const id = uuidv7(now);
  const m = doc.getMap(EDGES).setContainer(id, new LoroMap());
  m.set("from", edge.from);
  m.set("to", edge.to);
  if (edge.fromSide) m.set("from_side", edge.fromSide);
  if (edge.toSide) m.set("to_side", edge.toSide);
  if (edge.label) m.set("label", edge.label);
  if (edge.color) m.set("color", edge.color);
  if (edge.style && edge.style !== "solid") m.set("style", edge.style);
  if (edge.arrows && edge.arrows !== "end") m.set("arrows", edge.arrows);
  commit(doc);
  return id;
}

/** A line's look: solid or dashed, and where its arrowheads are. */
export function setEdgeLook(doc: LoroDoc, id: string, look: Partial<Pick<BoardEdge, "style" | "arrows">>) {
  const m = doc.getMap(EDGES).get(id);
  if (!(m instanceof LoroMap)) return;
  if (look.style) look.style === "solid" ? m.delete("style") : m.set("style", look.style);
  if (look.arrows) look.arrows === "end" ? m.delete("arrows") : m.set("arrows", look.arrows);
  commit(doc);
}

/** Folds cards to their title or opens them; `fixed: false` lets items grow
 *  with their content again ("fit to content"). */
export function setItemFlags(doc: LoroDoc, ids: string[], flags: { folded?: boolean; fixed?: boolean }) {
  for (const id of ids) {
    const m = itemMap(doc, id);
    if (!m) continue;
    for (const k of ["folded", "fixed"] as const) {
      const v = flags[k];
      if (v === undefined) continue;
      if (v) m.set(k, true);
      else m.delete(k);
    }
  }
  commit(doc);
}

/** Copies of items, offset (paste, duplicate): cards stay references to the
 *  same card; texts and sections are copied. Lines between copied items are
 *  copied too. Returns the new ids. */
export function duplicateItems(doc: LoroDoc, items: BoardItem[], edges: BoardEdge[], dx = 40, dy = 40, now = Date.now()): string[] {
  const ids = new Map<string, string>();
  let z = topZ(doc);
  for (const [n, i] of items.entries()) {
    const id = uuidv7(now + n);
    ids.set(i.id, id);
    const m = doc.getMap(ITEMS).setContainer(id, new LoroMap());
    m.set("kind", i.kind);
    if (i.cardId) m.set("card_id", i.cardId);
    if (i.text !== undefined) m.set("text", i.text);
    m.set("x", Math.round(i.x + dx));
    m.set("y", Math.round(i.y + dy));
    m.set("w", i.w);
    m.set("h", i.h);
    m.set("z", i.kind === "section" ? i.z : ++z);
    if (i.color) m.set("color", i.color);
    if (i.fixed && i.kind !== "section") m.set("fixed", true);
    if (i.folded) m.set("folded", true);
    m.set("order", i.order);
    if (i.collapsed) m.set("collapsed", true);
  }
  // A copied map node keeps its parent when the parent is copied too;
  // otherwise it becomes the centre of its own map.
  for (const i of items) {
    if (i.kind !== "mind" && !i.root && !i.parent) continue;
    const m = itemMap(doc, ids.get(i.id)!)!;
    const parent = i.parent && ids.get(i.parent);
    if (parent) m.set("parent", parent);
    else m.set("root", true);
  }
  for (const [n, e] of edges.entries()) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    const m = doc.getMap(EDGES).setContainer(uuidv7(now + items.length + n), new LoroMap());
    m.set("from", from);
    m.set("to", to);
    if (e.fromSide) m.set("from_side", e.fromSide);
    if (e.toSide) m.set("to_side", e.toSide);
    if (e.label) m.set("label", e.label);
    if (e.color) m.set("color", e.color);
    if (e.style !== "solid") m.set("style", e.style);
    if (e.arrows !== "end") m.set("arrows", e.arrows);
  }
  commit(doc);
  return [...ids.values()];
}

/** "Tidy up" (Heptabase): the items in rows of a grid, in their reading
 *  order, from the top left of where they are. Uses each item's size. */
export function tidyUp(items: BoardItem[], gap = 40): { id: string; x: number; y: number }[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const cols = Math.ceil(Math.sqrt(sorted.length));
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const out: { id: string; x: number; y: number }[] = [];
  let y = y0;
  for (let r = 0; r * cols < sorted.length; r++) {
    const row = sorted.slice(r * cols, r * cols + cols);
    let x = x0;
    for (const i of row) {
      out.push({ id: i.id, x, y });
      x += i.w + gap;
    }
    y += Math.max(...row.map((i) => i.h)) + gap;
  }
  return out;
}

// ---- mind maps (§4.3) ----

/** A map's centre: a text node (or `cardId`, a card) at `at`. */
export function addMindRoot(doc: LoroDoc, at: { x: number; y: number }, text = "", cardId?: string, now = Date.now()): string {
  return cardId ? addItem(doc, { kind: "card", cardId, ...at, root: true }, now) : addItem(doc, { kind: "mind", text, ...at, root: true }, now);
}

/** The map node a node hangs under, if it is in a map whose links hold. */
const parentOf = (byId: Map<string, BoardItem>, i: BoardItem) => (i.parent ? byId.get(i.parent) : undefined);

/** Children in order. */
export function childrenOf(items: BoardItem[], id: string): BoardItem[] {
  return items.filter((i) => i.parent === id).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Every node below `id` (not `id` itself). */
export function descendants(items: BoardItem[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const walk = (p: string) => {
    for (const c of items) if (c.parent === p && !seen.has(c.id)) (seen.add(c.id), out.push(c.id), walk(c.id));
  };
  walk(id);
  return out;
}

/** The centre of the map a node is in; null when it is in none (its
 *  parent was deleted on another device, or two moves made a loop). */
export function rootOf(items: BoardItem[], id: string): BoardItem | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.root) return cur;
    seen.add(cur.id);
    cur = parentOf(byId, cur);
  }
  return null;
}

/** A node in a map: a centre, or below one. */
export const inMap = (items: BoardItem[], i: BoardItem) => i.root || (!!i.parent && rootOf(items, i.id) !== null);

/** A new node under `parent`, after `after` (a sibling) or last. */
export function addMindChild(doc: LoroDoc, parent: string, opts: { after?: string; text?: string; cardId?: string } = {}, now = Date.now()): string {
  const items = readItems(doc);
  const kids = childrenOf(items, parent);
  const order = siblingOrder(kids, opts.after);
  const p = items.find((i) => i.id === parent);
  const at = { x: (p?.x ?? 0) + (p?.w ?? 160) + 80, y: p?.y ?? 0 };
  return opts.cardId ? addItem(doc, { kind: "card", cardId: opts.cardId, ...at, parent, order }, now) : addItem(doc, { kind: "mind", text: opts.text ?? "", ...at, parent, order }, now);
}

/** An order between `after` and the sibling following it (or last). */
function siblingOrder(kids: BoardItem[], after?: string): number {
  if (!after) return (kids.at(-1)?.order ?? 0) + 1;
  const i = kids.findIndex((k) => k.id === after);
  if (i < 0) return (kids.at(-1)?.order ?? 0) + 1;
  const next = kids[i + 1];
  return next ? (kids[i].order + next.order) / 2 : kids[i].order + 1;
}

/** Hangs a node (and its branch) under another node, last; refused when
 *  that would hang a node under itself. A card from outside joins. */
export function attach(doc: LoroDoc, id: string, parent: string): boolean {
  const items = readItems(doc);
  if (id === parent || descendants(items, id).includes(parent)) return false;
  const m = itemMap(doc, id);
  if (!m) return false;
  m.set("parent", parent);
  m.set("order", siblingOrder(childrenOf(items, parent).filter((k) => k.id !== id)));
  m.delete("root");
  commit(doc);
  return true;
}

/** Takes a node out of its map, to stand alone at `at`: its branch stays
 *  with it as a map of its own. */
export function detach(doc: LoroDoc, id: string, at: { x: number; y: number }) {
  const m = itemMap(doc, id);
  if (!m) return;
  m.delete("parent");
  if (descendants(readItems(doc), id).length || str(m, "kind") === "mind") m.set("root", true);
  m.set("x", Math.round(at.x));
  m.set("y", Math.round(at.y));
  commit(doc);
}

/** Makes a node the centre of a map (a free card, or a node whose map is
 *  gone), so it can have branches. */
export function makeRoot(doc: LoroDoc, id: string) {
  const m = itemMap(doc, id);
  if (!m) return;
  m.delete("parent");
  m.set("root", true);
  commit(doc);
}

/** Moves a node one place up (-1) or down (1) among its siblings. */
export function moveSibling(doc: LoroDoc, id: string, dir: -1 | 1) {
  const items = readItems(doc);
  const node = items.find((i) => i.id === id);
  if (!node?.parent) return;
  const kids = childrenOf(items, node.parent);
  const at = kids.findIndex((k) => k.id === id);
  const other = kids[at + dir];
  if (!other) return;
  // Swap places; equal orders (made on two devices) are spread first.
  const mine = node.order === other.order ? other.order + dir * 0.5 : other.order;
  itemMap(doc, id)!.set("order", mine);
  itemMap(doc, other.id)!.set("order", node.order);
  commit(doc);
}

/** Folds a node's branch away, or shows it again. */
export function setCollapsed(doc: LoroDoc, id: string, collapsed: boolean) {
  const m = itemMap(doc, id);
  if (!m) return;
  if (collapsed) m.set("collapsed", true);
  else m.delete("collapsed");
  commit(doc);
}

/** A map's text node becomes a card with that text as its title, in place. */
export function mindToCard(doc: LoroDoc, id: string, cardId: string) {
  const m = itemMap(doc, id);
  if (!m) return;
  m.set("kind", "card");
  m.set("card_id", cardId);
  m.delete("text");
  m.set("w", DEFAULT_SIZE.card.w);
  commit(doc);
}

export const MIND_GAP_X = 72;
export const MIND_GAP_Y = 18;

/** Where every node of every map goes: from the centre to the right, each
 *  branch as tall as its children, children centred on their parent. Uses
 *  the nodes' measured sizes. Folded branches take no room. */
export function mindLayout(items: BoardItem[], size: (i: BoardItem) => { w: number; h: number }): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const kids = (id: string) => childrenOf(items, id);
  const height = new Map<string, number>();
  const measure = (i: BoardItem, seen: Set<string>): number => {
    if (seen.has(i.id)) return 0;
    seen.add(i.id);
    const own = size(i).h;
    const cs = i.collapsed ? [] : kids(i.id);
    const sum = cs.reduce((t, c) => t + measure(c, seen), 0) + MIND_GAP_Y * Math.max(0, cs.length - 1);
    const h = Math.max(own, sum);
    height.set(i.id, h);
    return h;
  };
  const place = (i: BoardItem, x: number, top: number, seen: Set<string>) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    const h = height.get(i.id) ?? size(i).h;
    const own = size(i);
    out.set(i.id, { x, y: top + (h - own.h) / 2 });
    if (i.collapsed) return;
    const cs = kids(i.id);
    const total = cs.reduce((t, c) => t + (height.get(c.id) ?? 0), 0) + MIND_GAP_Y * Math.max(0, cs.length - 1);
    let y = top + (h - total) / 2;
    for (const c of cs) {
      place(c, x + own.w + MIND_GAP_X, y, seen);
      y += (height.get(c.id) ?? 0) + MIND_GAP_Y;
    }
  };
  for (const root of items.filter((i) => i.root)) {
    const h = measure(root, new Set());
    const own = size(root);
    // The centre stays where it is; its branch is centred on it.
    place(root, root.x, root.y + own.h / 2 - h / 2, new Set());
    out.set(root.id, { x: root.x, y: root.y });
  }
  return out;
}

/** The lines of every map: parent to child, for shown (not folded) nodes. */
export function mindLinks(items: BoardItem[]): { parent: string; child: string }[] {
  const shown = new Set<string>();
  const walk = (id: string) => {
    shown.add(id);
    const node = items.find((i) => i.id === id);
    if (node?.collapsed) return;
    for (const c of childrenOf(items, id)) if (!shown.has(c.id)) walk(c.id);
  };
  for (const r of items.filter((i) => i.root)) walk(r.id);
  return items.filter((i) => i.parent && shown.has(i.id) && shown.has(i.parent)).map((i) => ({ parent: i.parent!, child: i.id }));
}

/** Nodes hidden inside folded branches. */
export function hiddenByFold(items: BoardItem[]): Set<string> {
  const hidden = new Set<string>();
  for (const i of items) if (i.collapsed) for (const d of descendants(items, i.id)) hidden.add(d);
  return hidden;
}

/** A branch's colour: its own, or the nearest ancestor's below the centre;
 *  first-level branches without one take the presets in turn. */
export function branchColor(items: BoardItem[], id: string): BoardColor | undefined {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.color) return cur.color;
    const p = parentOf(byId, cur);
    if (p?.root) {
      const idx = childrenOf(items, p.id).findIndex((k) => k.id === cur!.id);
      return COLORS[idx % COLORS.length];
    }
    cur = p;
  }
  return undefined;
}

export type Alignment = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/** Lines items up on one edge or centre of their bounding box. */
export function align(items: BoardItem[], how: Alignment): { id: string; x?: number; y?: number }[] {
  if (items.length < 2) return [];
  const left = Math.min(...items.map((i) => i.x));
  const right = Math.max(...items.map((i) => i.x + i.w));
  const top = Math.min(...items.map((i) => i.y));
  const bottom = Math.max(...items.map((i) => i.y + i.h));
  return items.map((i) => {
    switch (how) {
      case "left":
        return { id: i.id, x: left };
      case "right":
        return { id: i.id, x: right - i.w };
      case "centerX":
        return { id: i.id, x: (left + right) / 2 - i.w / 2 };
      case "top":
        return { id: i.id, y: top };
      case "bottom":
        return { id: i.id, y: bottom - i.h };
      case "centerY":
        return { id: i.id, y: (top + bottom) / 2 - i.h / 2 };
    }
  });
}

export function setEdgeLabel(doc: LoroDoc, id: string, label: string) {
  const m = doc.getMap(EDGES).get(id);
  if (!(m instanceof LoroMap)) return;
  if (label.trim()) m.set("label", label.trim());
  else m.delete("label");
  commit(doc);
}

export function removeEdges(doc: LoroDoc, ids: string[]) {
  const edges = doc.getMap(EDGES);
  for (const id of ids) edges.delete(id);
  commit(doc);
}

/** Where a new item of this size can go near `at` without covering another
 *  card or text: `at` itself if free, else the nearest free spot on a grid
 *  around it. */
export function freeSpot(items: BoardItem[], at: { x: number; y: number }, w: number, h: number, step = 40): { x: number; y: number } {
  const others = items.filter((i) => i.kind !== "section");
  const free = (x: number, y: number) => others.every((i) => x + w <= i.x || i.x + i.w <= x || y + h <= i.y || i.y + i.h <= y);
  for (let ring = 0; ring < 40; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (const dy of ring === 0 ? [0] : [-ring, ring]) {
        if (free(at.x + dx * step, at.y + dy * step)) return { x: at.x + dx * step, y: at.y + dy * step };
      }
    }
    for (let dy = -ring + 1; dy < ring; dy++) {
      for (const dx of [-ring, ring]) {
        if (free(at.x + dx * step, at.y + dy * step)) return { x: at.x + dx * step, y: at.y + dy * step };
      }
    }
  }
  return at;
}

/** Items lying wholly inside a section: they move with it (§4.3). */
export function insideSection(section: BoardItem, items: BoardItem[]): string[] {
  return items
    .filter((i) => i.id !== section.id && i.x >= section.x && i.y >= section.y && i.x + i.w <= section.x + section.w && i.y + i.h <= section.y + section.h)
    .map((i) => i.id);
}

/** A section around items, with room for its title. */
export function sectionAround(items: BoardItem[], pad = 32): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...items.map((i) => i.x)) - pad;
  const y = Math.min(...items.map((i) => i.y)) - pad - 24;
  const r = Math.max(...items.map((i) => i.x + i.w)) + pad;
  const b = Math.max(...items.map((i) => i.y + i.h)) + pad;
  return { x, y, w: r - x, h: b - y };
}

/** JSON Canvas 1.0 (jsoncanvas.org): cards become text nodes with their
 *  Markdown, sections groups; drawing order is array order. */
export function toJsonCanvas(items: BoardItem[], edges: BoardEdge[], cardMarkdown: (cardId: string) => string): string {
  const ordered = [...items].sort((a, b) => Number(b.kind === "section") - Number(a.kind === "section") || a.z - b.z);
  const nodes = ordered.map((i) => {
    const base = { id: i.id, x: i.x, y: i.y, width: i.w, height: i.h, ...(i.color ? { color: i.color } : {}) };
    if (i.kind === "section") return { ...base, type: "group", ...(i.text ? { label: i.text } : {}) };
    if (i.kind === "card") return { ...base, type: "text", text: cardMarkdown(i.cardId ?? "") };
    if (i.kind === "mind") return { ...base, type: "text", text: i.text ?? "" };
    return { ...base, type: "text", text: i.text ?? "" };
  });
  const lines = edges.map((e) => ({
    id: e.id,
    fromNode: e.from,
    toNode: e.to,
    ...(e.arrows === "both" ? { fromEnd: "arrow" } : {}),
    ...(e.arrows === "none" ? { toEnd: "none" } : {}),
    ...(e.fromSide ? { fromSide: e.fromSide } : {}),
    ...(e.toSide ? { toSide: e.toSide } : {}),
    ...(e.label ? { label: e.label } : {}),
    ...(e.color ? { color: e.color } : {}),
  }));
  // Mind map branches as lines from the right side to the left side.
  const branches = mindLinks(items).map((l) => ({ id: `mind-${l.child}`, fromNode: l.parent, fromSide: "right", toNode: l.child, toSide: "left", toEnd: "none" }));
  return JSON.stringify({ nodes, edges: [...lines, ...branches] }, null, 2);
}
