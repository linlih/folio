// The outline as a tree of items, and the one operation every outline
// command is built on: moving a run of sibling items somewhere else
// (design/outliner.md). Positions are ProseMirror document positions; an
// item's `pos` is the position just before it.

import { Fragment, type Node as PMNode, type NodeType, type ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export const ITEM_TYPES = new Set(["listItem", "taskItem"]);
export const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

export const isItem = (n: PMNode | null | undefined) => !!n && ITEM_TYPES.has(n.type.name);
export const isList = (n: PMNode | null | undefined) => !!n && LIST_TYPES.has(n.type.name);

export interface Item {
  node: PMNode;
  pos: number;
}

/** Kept for callers that think in "blocks": an item, or a top-level block. */
export interface Target extends Item {
  depth: number;
}

export const itemAtPos = (doc: PMNode, pos: number): Item | null => {
  const node = doc.nodeAt(pos);
  return isItem(node) ? { node: node!, pos } : null;
};

/** The innermost list item around `$pos`. */
export function itemAt($pos: ResolvedPos): Target | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (isItem(node)) return { node, pos: $pos.before(d), depth: d };
  }
  return null;
}

/** The innermost list item around `$pos`, or else its top-level block. */
export function blockAt($pos: ResolvedPos): Target | null {
  const item = itemAt($pos);
  if (item) return item;
  if ($pos.depth < 1) return null;
  return { node: $pos.node(1), pos: $pos.before(1), depth: 1 };
}

/** The item's nested list (the first list among its children), if any. */
export function childList(doc: PMNode, item: Item): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  item.node.forEach((child, offset) => {
    if (!found && isList(child)) found = { node: child, pos: item.pos + 1 + offset };
  });
  void doc;
  return found;
}

export function childItems(doc: PMNode, item: Item): Item[] {
  const list = childList(doc, item);
  if (!list) return [];
  const out: Item[] = [];
  list.node.forEach((child, offset) => void (isItem(child) && out.push({ node: child, pos: list.pos + 1 + offset })));
  return out;
}

/** True when the item has nested items (something to collapse). */
export const hasChildren = (item: PMNode) => {
  let found = false;
  item.forEach((child) => void (isList(child) && child.childCount > 0 && (found = true)));
  return found;
};

export const isCollapsed = (item: PMNode) => !!item.attrs.collapsed && hasChildren(item);

/** The list an item sits in, and its index there. */
export function listOf(doc: PMNode, item: Item) {
  const $p = doc.resolve(item.pos);
  return { node: $p.parent, pos: $p.depth > 0 ? $p.before() : -1, index: $p.index(), depth: $p.depth };
}

export function siblings(doc: PMNode, item: Item): Item[] {
  const list = listOf(doc, item);
  const out: Item[] = [];
  list.node.forEach((child, offset) => void (isItem(child) && out.push({ node: child, pos: list.pos + 1 + offset })));
  return out;
}

export function prevSibling(doc: PMNode, item: Item): Item | null {
  const sibs = siblings(doc, item);
  const i = sibs.findIndex((s) => s.pos === item.pos);
  return i > 0 ? sibs[i - 1] : null;
}

export function nextSibling(doc: PMNode, item: Item): Item | null {
  const sibs = siblings(doc, item);
  const i = sibs.findIndex((s) => s.pos === item.pos);
  return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
}

/** The item whose nested list holds `item`; null for a root-level item. */
export function parentItem(doc: PMNode, item: Item): Item | null {
  const $p = doc.resolve(item.pos);
  for (let d = $p.depth - 1; d > 0; d--) {
    const node = $p.node(d);
    if (isItem(node)) return { node, pos: $p.before(d) };
    if (!isList(node)) return null;
  }
  return null;
}

/** The outermost list containing `item`. */
export function rootList(doc: PMNode, item: Item): { node: PMNode; pos: number } {
  const $p = doc.resolve(item.pos);
  for (let d = 1; d <= $p.depth; d++) {
    if (isList($p.node(d))) return { node: $p.node(d), pos: $p.before(d) };
  }
  return { node: $p.parent, pos: $p.before() };
}

/** Items of the list tree at `root` in screen order, skipping the children
 *  of collapsed items. */
export function visibleItems(root: { node: PMNode; pos: number }): Item[] {
  const out: Item[] = [];
  const walk = (list: PMNode, listPos: number) => {
    list.forEach((child, offset) => {
      if (!isItem(child)) return;
      const pos = listPos + 1 + offset;
      out.push({ node: child, pos });
      if (child.attrs.collapsed) return;
      child.forEach((grand, o) => void (isList(grand) && walk(grand, pos + 1 + o)));
    });
  };
  walk(root.node, root.pos);
  return out;
}

/** The previous / next item in screen order within the same outline. */
export function visibleNeighbour(doc: PMNode, item: Item, dir: -1 | 1): Item | null {
  const all = visibleItems(rootList(doc, item));
  const i = all.findIndex((x) => x.pos === item.pos);
  return i < 0 ? null : (all[i + dir] ?? null);
}

/** Item positions by block id, so callers can find items again after a step. */
export function findByBid(doc: PMNode, bid: string): Item | null {
  let found: Item | null = null;
  doc.descendants((n, pos) => {
    if (found) return false;
    if (isItem(n) && n.attrs.bid === bid) found = { node: n, pos };
    return true;
  });
  return found;
}

export type Place =
  | { kind: "before" | "after"; item: Item }
  | { kind: "firstChild" | "lastChild"; item: Item };

/** Where `place` is in `doc`: the insert position, whether a new list has to
 *  be created around the inserted items, and the list type they land in. */
function resolvePlace(doc: PMNode, place: Place): { pos: number; wrap: boolean; listType: NodeType } {
  const { item } = place;
  if (place.kind === "before" || place.kind === "after") {
    const list = listOf(doc, item).node;
    return { pos: place.kind === "before" ? item.pos : item.pos + item.node.nodeSize, wrap: false, listType: list.type };
  }
  const list = childList(doc, item);
  if (list) {
    const pos = place.kind === "firstChild" ? list.pos + 1 : list.pos + list.node.nodeSize - 1;
    return { pos, wrap: false, listType: list.node.type };
  }
  // A new nested list at the end of the item.
  return { pos: item.pos + item.node.nodeSize - 1, wrap: true, listType: doc.type.schema.nodes.bulletList };
}

/** Makes items fit the list they move into: an ordered list holds plain items
 *  only, a task list tasks only; bullet lists hold both. Ids are kept. */
function fitItems(items: Fragment, listType: NodeType): Fragment {
  const schema = listType.schema;
  const out: PMNode[] = [];
  items.forEach((n) => {
    if (listType.contentMatch.matchType(n.type)) return void out.push(n);
    const target = n.type.name === "taskItem" ? schema.nodes.listItem : schema.nodes.taskItem;
    const attrs = { bid: n.attrs.bid, source: n.attrs.source, collapsed: n.attrs.collapsed };
    out.push(target.create(target.name === "taskItem" ? { ...attrs, checked: false } : attrs, n.content, n.marks));
  });
  return Fragment.from(out);
}

/** Deletes a run of sibling items; an emptied list goes too. */
export function deleteItems(tr: Transaction, items: Item[]) {
  const first = items[0];
  const last = items[items.length - 1];
  const list = listOf(tr.doc, first);
  if (list.node.childCount === items.length && list.depth > 0) tr.delete(list.pos, list.pos + list.node.nodeSize);
  else tr.delete(first.pos, last.pos + last.node.nodeSize);
}

/** Inserts item nodes at `place`; returns the position of the first one. */
export function insertItems(tr: Transaction, nodes: Fragment, place: Place): number {
  const at = resolvePlace(tr.doc, place);
  const fitted = fitItems(nodes, at.listType);
  if (at.wrap) {
    tr.insert(at.pos, at.listType.create(null, fitted));
    return at.pos + 1;
  }
  tr.insert(at.pos, fitted);
  return at.pos;
}

/** Moves a run of sibling items (with their children) to `place`, in one
 *  transaction. Returns the new position of the first item, or null when the
 *  move is impossible (into its own subtree) or changes nothing. A target
 *  that was collapsed is expanded so the moved items stay visible. */
export function moveItems(tr: Transaction, items: Item[], place: Place): number | null {
  if (items.length === 0) return null;
  const from = items[0].pos;
  const to = items[items.length - 1].pos + items[items.length - 1].node.nodeSize;
  if (place.item.pos >= from && place.item.pos < to) return null;
  const at = resolvePlace(tr.doc, place);
  if (!at.wrap && at.pos >= from && at.pos <= to) return null; // already there
  const nodes = tr.doc.slice(from, to).content;
  const targetBid = place.item.node.attrs.bid as string | null;
  const start = tr.steps.length;
  deleteItems(tr, items);
  const mapping = tr.mapping.slice(start);
  // The target item moved with the deletion; find it again.
  const target = itemAtPos(tr.doc, mapping.map(place.item.pos)) ?? (targetBid ? findByBid(tr.doc, targetBid) : null);
  if (!target) return null;
  const newPos = insertItems(tr, nodes, { ...place, item: target } as Place);
  if ((place.kind === "firstChild" || place.kind === "lastChild") && target.node.attrs.collapsed) {
    // The insert was inside the target, so its own position did not move.
    tr.setNodeAttribute(target.pos, "collapsed", false);
  }
  return newPos;
}
