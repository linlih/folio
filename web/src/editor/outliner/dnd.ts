// Dragging blocks (design/outliner.md "拖放"): list items by their bullet,
// other top-level blocks by their handle (dragHandle.ts). Over a list item,
// far enough right of its text nests the dragged block as its first child,
// the top edge of an outline's first block puts it before, anywhere else
// after it (with its children); over a block outside lists, above or below
// it by the half it is over. A line shows where.
//
// Within a pane a drop moves the block (between journal days too); into the
// other pane of a split view it copies, with new block ids. ⌥ forces a copy,
// ⌘ a move, as in Finder.

import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { loroSyncPluginKey } from "../../vendor/loro-prosemirror";
import { stripIds } from "../pasteIds";
import { deleteItems, findByBid, insertItems, isItem, isList, itemAtPos, moveItems, rootList, visibleItems, type Item, type Place } from "./tree";

/** Pixels right of a block's text that make a drop nest (Logseq: 50). */
export const NEST_OFFSET = 50;
/** Pixels below the top of an outline's first block that drop before it. */
const TOP_EDGE = 16;

/** Where a drop lands: relative to a list item, or at a position between
 *  top-level blocks. */
export type DropAt = Place | { kind: "top"; pos: number };
export type DropMode = "move" | "copy";

/** The block being dragged, by id: a list item, or a top-level block. */
let drag: { view: EditorView; bid: string; handle: boolean } | null = null;

function begin(view: EditorView, bid: string, handle: boolean, e: DragEvent) {
  drag = { view, bid, handle };
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
}

const dimKey = new PluginKey<string | null>("dragDim");

/** Dims the dragged block. A decoration, not a class set on its DOM: that
 *  would make ProseMirror redraw the block, and WebKit cancels a drag whose
 *  source element (the bullet) is replaced. Set after the drag has begun. */
function dim(view: EditorView, bid: string | null) {
  if (!view.isDestroyed && dimKey.getState(view.state) !== bid) view.dispatch(view.state.tr.setMeta(dimKey, bid));
}

export function startItemDrag(view: EditorView, item: Item, e: DragEvent) {
  const bid = item.node.attrs.bid as string | null;
  if (!bid) return;
  begin(view, bid, false, e);
  const dom = view.nodeDOM(item.pos);
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", item.node.firstChild?.textContent ?? "");
    if (dom instanceof HTMLElement) e.dataTransfer.setDragImage(dom, 12, 12);
  }
  setTimeout(() => drag?.bid === bid && dim(view, bid));
}

/** A top-level block dragged by its handle. Within its own editor
 *  ProseMirror's native drag moves it; this lets other editors take it. */
export function startHandleDrag(view: EditorView, node: PMNode, e: DragEvent) {
  const bid = node.attrs.bid as string | null;
  if (bid) begin(view, bid, true, e);
}

export function endItemDrag() {
  if (drag) dim(drag.view, null);
  drag = null;
  document.querySelectorAll(".drop-line").forEach((el) => ((el as HTMLElement).hidden = true));
}

const paneOf = (view: EditorView) => view.dom.closest("[data-pane]")?.getAttribute("data-pane") ?? null;
const docOf = (view: EditorView) => loroSyncPluginKey.getState(view.state)?.doc ?? view;

/** Moves within a pane, copies into the other one; ⌥ copies, ⌘ moves. */
export function dropMode(source: EditorView, target: EditorView, keys: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }): DropMode {
  if (keys.altKey) return "copy";
  if (keys.metaKey || keys.ctrlKey) return "move";
  return paneOf(source) === paneOf(target) ? "move" : "copy";
}

/** A block with this id: a list item, or a block outside lists. */
function findBlock(doc: PMNode, bid: string): Item | null {
  let found: Item | null = null;
  doc.descendants((n, pos) => {
    if (found) return false;
    if (n.isBlock && !isList(n) && n.attrs.bid === bid) found = { node: n, pos };
    return !found;
  });
  return found;
}

const firstLine = (li: Element) => li.querySelector(":scope > p, :scope > div > p") as HTMLElement | null;

/** The dragged block's range in `view`'s document, when it is there. */
function draggedRange(view: EditorView): { from: number; to: number } | null {
  if (!drag || docOf(drag.view) !== docOf(view)) return null;
  const b = findBlock(view.state.doc, drag.bid);
  return b && { from: b.pos, to: b.pos + b.node.nodeSize };
}

/** Where a drop at (x, y) over `view` would put the dragged block, and the
 *  element the drop line is drawn against. */
export function dropPlace(view: EditorView, target: EventTarget | null, x: number, y: number): { at: DropAt; el: HTMLElement; below: boolean } | null {
  if (!drag || !(target instanceof Element)) return null;
  const inside = draggedRange(view);
  const li = target.closest("li");
  if (li && view.dom.contains(li)) {
    const item = itemAtPos(view.state.doc, view.posAtDOM(li, 0) - 1);
    if (!item) return null;
    // Not into the dragged block itself or its children.
    if (inside && item.pos >= inside.from && item.pos < inside.to) return null;
    const line = firstLine(li);
    const textLeft = (line ?? li).getBoundingClientRect().left;
    const box = li.getBoundingClientRect();
    const first = visibleItems(rootList(view.state.doc, item))[0];
    const place: Place =
      x - textLeft > NEST_OFFSET ? { kind: "firstChild", item }
      : first?.pos === item.pos && y - box.top <= TOP_EDGE ? { kind: "before", item }
      : { kind: "after", item };
    return { at: place, el: li, below: place.kind !== "before" };
  }
  // Outside lists: before or after the top-level block under the pointer.
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.pos);
  if ($pos.depth < 1) return null;
  const pos = $pos.before(1);
  const node = view.state.doc.child($pos.index(0));
  const el = view.nodeDOM(pos);
  if (!(el instanceof HTMLElement)) return null;
  const box = el.getBoundingClientRect();
  const below = y > box.top + box.height / 2;
  const at = below ? pos + node.nodeSize : pos;
  if (inside && at >= inside.from && at <= inside.to) return null;
  return { at: { kind: "top", pos: at }, el, below };
}

function showLine(view: EditorView, at: DropAt, el: HTMLElement, below: boolean) {
  const host = view.dom.parentElement;
  if (!host) return;
  let line = host.querySelector(":scope > .drop-line") as HTMLElement | null;
  if (!line) {
    line = document.createElement("div");
    line.className = "drop-line";
    host.append(line);
  }
  const hostBox = host.getBoundingClientRect();
  const text = (el.tagName === "LI" ? (firstLine(el) ?? el) : el).getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const top = at.kind === "firstChild" ? text.bottom : below ? box.bottom : box.top;
  const left = text.left + (at.kind === "firstChild" ? 28 : 0);
  line.style.top = `${top - hostBox.top - 1}px`;
  line.style.left = `${left - hostBox.left}px`;
  line.style.right = "0";
  line.hidden = false;
}

/** The dragged node shaped for where it lands: a list item among items, a
 *  block between top-level blocks. */
function shaped(view: EditorView, node: PMNode, at: DropAt): Fragment {
  const { schema } = view.state;
  if (at.kind === "top") return Fragment.from(isItem(node) ? schema.nodes.bulletList.create(null, node) : node);
  if (isItem(node)) return Fragment.from(node);
  // A block that can't be an item's first line gets an empty line above it.
  const content = node.type.name === "paragraph" || node.type.name === "heading" ? [node] : [schema.nodes.paragraph.create(), node];
  return Fragment.from(schema.nodes.listItem.create(null, content));
}

function insertAt(tr: Transaction, nodes: Fragment, at: DropAt) {
  if (at.kind === "top") tr.insert(at.pos, nodes);
  else insertItems(tr, nodes, at);
}

/** Removes a dragged block from `tr`'s document, found at `pos`. */
function removeAt(tr: Transaction, pos: number) {
  const item = itemAtPos(tr.doc, pos);
  if (item) return deleteItems(tr, [item]);
  const node = tr.doc.nodeAt(pos);
  if (!node) return;
  // The document's only block becomes an empty line, not nothing.
  if (tr.doc.childCount === 1) tr.replaceWith(pos, pos + node.nodeSize, tr.doc.type.schema.nodes.paragraph.create());
  else tr.delete(pos, pos + node.nodeSize);
}

const isPlace = (at: DropAt): at is Place => at.kind !== "top";

/** Performs the drop. A move within one document is one transaction; a move
 *  across documents inserts in the target first, then removes from the
 *  source (a failure in between leaves a copy, never a loss) and keeps ids.
 *  A copy gets new block ids, so block references stay unambiguous. */
export function dropDragged(view: EditorView, at: DropAt, mode: DropMode = "move"): boolean {
  if (!drag) return false;
  const source = drag.view;
  const original = findBlock(source.state.doc, drag.bid);
  if (!original) return false;
  const sameDoc = docOf(source) === docOf(view);
  // Fresh nodes: the originals are tied to the source document's containers.
  const fresh = PMNode.fromJSON(view.state.schema, original.node.toJSON());
  const node = mode === "copy" ? stripIds(Fragment.from(fresh)).firstChild! : fresh;

  if (mode === "move" && sameDoc) {
    const tr = view.state.tr;
    const here = findBlock(view.state.doc, drag.bid)!;
    if (isItem(here.node) && isPlace(at)) {
      if (moveItems(tr, [here as Item], at) === null) return false;
    } else {
      insertAt(tr, shaped(view, node, at), at);
      removeAt(tr, tr.mapping.map(here.pos));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const insert = view.state.tr;
  insertAt(insert, shaped(view, node, at), at);
  view.dispatch(insert.scrollIntoView());
  if (mode === "move") {
    const remove = source.state.tr;
    removeAt(remove, findBlock(source.state.doc, drag.bid)!.pos);
    source.dispatch(remove);
  }
  return true;
}

/** The editor a plain drag (selected text, ProseMirror's own) started in. */
let textSource: EditorView | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "dragstart",
    (e) => {
      const dom = (e.target as Element | null)?.closest?.(".ProseMirror") as (Element & { editor?: { view: EditorView } }) | null;
      textSource = drag ? null : (dom?.editor?.view ?? null);
    },
    true,
  );
  window.addEventListener("dragend", () => void (textSource = null), true);
}

export function dragDropPlugin() {
  // A block dragged by its handle within its own editor is ProseMirror's
  // native drag; everything else is ours.
  const ours = (view: EditorView) => !!drag && !(drag.handle && drag.view === view);

  /** Drops run here, in the capture phase, ahead of the editor's own drop
   *  handlers: TipTap's paste rules delete the source editor's selection
   *  after any drop that came from another editor, which would turn every
   *  copy into a move. */
  const onDrop = (view: EditorView) => (e: DragEvent) => {
    if (ours(view)) {
      e.preventDefault();
      e.stopPropagation();
      const found = dropPlace(view, e.target, e.clientX, e.clientY);
      if (found) dropDragged(view, found.at, dropMode(drag!.view, view, e));
      endItemDrag();
      return;
    }
    // Selected text from another editor: ProseMirror inserts it (with new
    // block ids); for a copy, the source keeps it.
    const source = textSource;
    if (source && source !== view && !source.isDestroyed && dropMode(source, view, e) === "copy") {
      const { $to } = source.state.selection;
      source.dispatch(source.state.tr.setSelection(TextSelection.near($to)));
    }
  };

  return new Plugin<string | null>({
    key: dimKey,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const meta = tr.getMeta(dimKey) as string | null | undefined;
        return meta === undefined ? value : meta;
      },
    },
    view(view) {
      const listener = onDrop(view);
      view.dom.addEventListener("drop", listener, true);
      return { destroy: () => view.dom.removeEventListener("drop", listener, true) };
    },
    props: {
      decorations(state) {
        const bid = dimKey.getState(state);
        const item = bid ? findByBid(state.doc, bid) : null;
        return item ? DecorationSet.create(state.doc, [Decoration.node(item.pos, item.pos + item.node.nodeSize, { class: "dragging" })]) : null;
      },
      handleDOMEvents: {
        dragover(view, e) {
          if (!ours(view)) return false;
          e.preventDefault();
          const found = dropPlace(view, e.target, e.clientX, e.clientY);
          const line = view.dom.parentElement?.querySelector(":scope > .drop-line") as HTMLElement | null;
          if (!found) {
            if (line) line.hidden = true;
            return true;
          }
          if (e.dataTransfer) e.dataTransfer.dropEffect = dropMode(drag!.view, view, e);
          showLine(view, found.at, found.el, found.below);
          return true;
        },
        dragleave(view, e) {
          const line = view.dom.parentElement?.querySelector(":scope > .drop-line") as HTMLElement | null;
          if (line && !view.dom.contains(e.relatedTarget as Node | null)) line.hidden = true;
          return false;
        },
      },
    },
  });
}
