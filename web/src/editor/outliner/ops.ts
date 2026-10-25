// The outline rules of design/outliner.md as functions of the editor state.
// Each returns a transaction to dispatch, or null when the rule does not
// apply and the key should do its default. They are all built on the three
// tree operations in tree.ts.

import { Fragment } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  blockAt,
  childItems,
  deleteItems,
  hasChildren,
  insertItems,
  itemAt,
  itemAtPos,
  moveItems,
  nextSibling,
  parentItem,
  prevSibling,
  visibleNeighbour,
  type Item,
} from "./tree";

/** A run of sibling items, operated on together (block selection). */
export type Group = Item[];

/** Item ops return the new position of the group's first item, or null. */
type GroupOp = (tr: Transaction, items: Group) => number | null;

// ---- moves ----

/** Tab: become the last child of the previous sibling. */
export const indentItems: GroupOp = (tr, items) => {
  const left = prevSibling(tr.doc, items[0]);
  return left ? moveItems(tr, items, { kind: "lastChild", item: left }) : null;
};

/** Shift+Tab: move after the parent; the siblings below become children of
 *  the moved block (Logseq's direct outdenting). */
export const outdentItems: GroupOp = (tr, items) => {
  const parent = parentItem(tr.doc, items[0]);
  if (!parent) return null;
  const last = items[items.length - 1];
  const below: Item[] = [];
  for (let s = nextSibling(tr.doc, last); s; s = nextSibling(tr.doc, s)) below.push(s);
  if (below.length) moveItems(tr, below, { kind: "lastChild", item: last });
  // The steps above happened after the group, so its positions still hold.
  const group = items.map((i) => itemAtPos(tr.doc, i.pos)!);
  return moveItems(tr, group, { kind: "after", item: itemAtPos(tr.doc, parent.pos)! });
};

/** Mod+Shift+↑: swap with the previous sibling; a first child moves to the
 *  end of the parent's previous sibling's children, keeping its depth. */
export const moveItemsUp: GroupOp = (tr, items) => {
  const prev = prevSibling(tr.doc, items[0]);
  if (prev) return moveItems(tr, items, { kind: "before", item: prev });
  const parent = parentItem(tr.doc, items[0]);
  const uncle = parent && prevSibling(tr.doc, parent);
  return uncle ? moveItems(tr, items, { kind: "lastChild", item: uncle }) : null;
};

/** Mod+Shift+↓: after the next sibling (and its children); a last child
 *  becomes the first child of the parent's next sibling. */
export const moveItemsDown: GroupOp = (tr, items) => {
  const next = nextSibling(tr.doc, items[items.length - 1]);
  if (next) return moveItems(tr, items, { kind: "after", item: next });
  const parent = parentItem(tr.doc, items[0]);
  const uncle = parent && nextSibling(tr.doc, parent);
  return uncle ? moveItems(tr, items, { kind: "firstChild", item: uncle }) : null;
};

/** Runs a group op on the item at the cursor and keeps the cursor where it
 *  was inside that item. Null when the cursor is not in an item. */
export function onCurrentItem(state: EditorState, op: GroupOp): Transaction | null {
  const item = itemAt(state.selection.$head);
  if (!item) return null;
  const tr = state.tr;
  const anchor = state.selection.anchor - item.pos;
  const head = state.selection.head - item.pos;
  const pos = op(tr, [item]);
  if (pos === null) return tr; // handled, nothing to do (at an edge)
  tr.setSelection(TextSelection.create(tr.doc, pos + anchor, pos + head));
  return tr;
}

/** Moves the block at the cursor: list items by the outline rules, other
 *  top-level blocks (in a document) by swapping with their neighbour. */
export function moveBlock(state: EditorState, dir: -1 | 1): Transaction | null {
  if (itemAt(state.selection.$head)) {
    const tr = onCurrentItem(state, dir < 0 ? moveItemsUp : moveItemsDown);
    return tr && tr.docChanged ? tr : null;
  }
  const target = blockAt(state.selection.$head);
  if (!target) return null;
  const $pos = state.doc.resolve(target.pos);
  const index = $pos.index();
  if (index + dir < 0 || index + dir >= $pos.parent.childCount) return null;
  const sibling = $pos.parent.child(index + dir);
  const from = dir < 0 ? target.pos - sibling.nodeSize : target.pos;
  const to = dir < 0 ? target.pos + target.node.nodeSize : target.pos + target.node.nodeSize + sibling.nodeSize;
  const tr = state.tr.replaceWith(from, to, Fragment.from(dir < 0 ? [target.node, sibling] : [sibling, target.node]));
  const shift = (dir < 0 ? from : from + sibling.nodeSize) - target.pos;
  tr.setSelection(TextSelection.create(tr.doc, state.selection.anchor + shift, state.selection.head + shift));
  return tr;
}

// ---- typing ----

/** The item whose first line holds the whole selection, with the offsets. */
function lineOf(state: EditorState) {
  const { $from, $to } = state.selection;
  const item = itemAt($from);
  if (!item || $from.parent !== item.node.firstChild || $to.parent !== $from.parent) return null;
  return { item, from: $from.parentOffset, to: $to.parentOffset };
}

/** Enter in an item's first line (design/outliner.md). `outline` is false in
 *  document-mode cards, where Enter on an empty root item leaves the list.
 *  `focusBid` is the item the editor is focused on: Enter there adds a child. */
export function enter(state: EditorState, outline: boolean, focusBid: string | null): Transaction | null {
  const line = lineOf(state);
  if (!line) return null;
  const { item } = line;
  const { schema } = state;
  const tr = state.tr;
  const textStart = item.pos + 2;
  if (line.to > line.from) tr.delete(textStart + line.from, textStart + line.to);
  const cur = itemAtPos(tr.doc, item.pos)!;
  const text = cur.node.firstChild!;
  const offset = line.from;
  const newItem = (content: Fragment = Fragment.empty) =>
    schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, content));
  const isFocusRoot = focusBid !== null && cur.node.attrs.bid === focusBid;

  // An empty task becomes a plain block first (so Enter never keeps
  // producing tasks).
  if (text.content.size === 0 && cur.node.type.name === "taskItem") {
    tr.setNodeMarkup(cur.pos, schema.nodes.listItem, { ...cur.node.attrs });
    return tr;
  }

  // An empty block: outdent when it is the last child, else a new block.
  if (text.content.size === 0 && cur.node.childCount === 1 && !isFocusRoot) {
    const parent = parentItem(tr.doc, cur);
    if (parent && !nextSibling(tr.doc, cur)) {
      const pos = outdentItems(tr, [cur]);
      if (pos !== null) tr.setSelection(TextSelection.create(tr.doc, pos + 2));
      return tr;
    }
    if (!parent && !outline) return null;
  }

  // Cursor at the start of a non-empty line: a new block above.
  if (offset === 0 && text.content.size > 0 && !isFocusRoot) {
    insertItems(tr, Fragment.from(newItem()), { kind: "before", item: cur });
    const moved = tr.mapping.slice(tr.steps.length - 1).map(cur.pos);
    tr.setSelection(TextSelection.create(tr.doc, moved + 2));
    return tr;
  }

  // Split: the rest of the line becomes a new block, as the first child when
  // the block shows children (or is the focused one), else as the next one.
  const rest = text.content.cut(offset);
  if (rest.size) tr.delete(textStart + offset, textStart + text.content.size);
  const now = itemAtPos(tr.doc, cur.pos)!;
  const asChild = isFocusRoot || (hasChildren(now.node) && !now.node.attrs.collapsed);
  const pos = insertItems(tr, Fragment.from(newItem(rest)), { kind: asChild ? "firstChild" : "after", item: now });
  if (asChild && now.node.attrs.collapsed) tr.setNodeAttribute(now.pos, "collapsed", false);
  tr.setSelection(TextSelection.create(tr.doc, pos + 2));
  return tr;
}

/** Joins `lower` into `upper`, the block just above it on screen: the text
 *  goes to the end of upper's line, lower's children become upper's first
 *  children, and the cursor stays at the seam. An empty `upper` that is not
 *  lower's parent is removed instead. */
export function mergeItems(tr: Transaction, upper: Item, lower: Item): Transaction {
  const upperIsParent = parentItem(tr.doc, lower)?.pos === upper.pos;
  if (!upperIsParent && upper.node.firstChild!.content.size === 0 && upper.node.childCount === 1) {
    const start = tr.steps.length;
    deleteItems(tr, [upper]);
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(start).map(lower.pos) + 2));
    return tr;
  }
  const start = tr.steps.length;
  const kids = childItems(tr.doc, lower);
  if (kids.length) moveItems(tr, kids, { kind: "firstChild", item: upper });
  const map = () => tr.mapping.slice(start);
  const up = itemAtPos(tr.doc, map().map(upper.pos))!;
  const low = itemAtPos(tr.doc, map().map(lower.pos))!;
  const seam = up.pos + 1 + up.node.firstChild!.nodeSize - 1;
  const text = low.node.firstChild!.content;
  const extra: Fragment[] = [];
  low.node.forEach((child, _o, i) => void (i > 0 && extra.push(Fragment.from(child))));
  const before = tr.steps.length;
  deleteItems(tr, [low]);
  const at = tr.mapping.slice(before).map(seam);
  tr.insert(at, text);
  // Anything else the lower block held (further paragraphs, other lists)
  // follows upper's line.
  if (extra.length) tr.insert(at + text.size + 1, extra.reduce((a, b) => a.append(b), Fragment.empty));
  tr.setSelection(TextSelection.create(tr.doc, at));
  return tr;
}

/** Backspace at the start of an item's line. */
export function backspace(state: EditorState, outline: boolean): Transaction | null {
  const line = lineOf(state);
  if (!line || line.from !== 0 || line.to !== 0) return null;
  const above = visibleNeighbour(state.doc, line.item, -1);
  if (!above) return outline ? state.tr : null;
  return mergeItems(state.tr, above, line.item);
}

/** Delete at the end of an item's line: pull the next block up. */
export function deleteForward(state: EditorState): Transaction | null {
  const line = lineOf(state);
  const size = line?.item.node.firstChild!.content.size;
  if (!line || line.from !== size || line.to !== size) return null;
  const below = visibleNeighbour(state.doc, line.item, 1);
  return below ? mergeItems(state.tr, line.item, below) : null;
}
