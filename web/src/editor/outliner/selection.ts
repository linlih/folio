// Block selection (design/outliner.md): Esc leaves the text and selects the
// block; arrows move or extend the selection; keys act on whole blocks.

import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { indentItems, moveItemsDown, moveItemsUp, outdentItems, type Group } from "./ops";
import { cycleKind } from "./tasks";
import { rememberCut } from "../pasteIds";
import { deleteItems, findByBid, isItem, isList, itemAt, listOf, parentItem, rootList, visibleItems, visibleNeighbour, type Item } from "./tree";

interface BlockSelection {
  anchor: string;
  head: string;
}

export const selectionKey = new PluginKey<BlockSelection | null>("blockSelection");

export const blockSelection = (state: EditorState) => selectionKey.getState(state) ?? null;

/** The selected items in screen order. */
export function selectedItems(state: EditorState): Item[] {
  const sel = blockSelection(state);
  if (!sel) return [];
  const anchor = findByBid(state.doc, sel.anchor);
  const head = findByBid(state.doc, sel.head);
  if (!anchor || !head) return [];
  const all = visibleItems(rootList(state.doc, anchor));
  const a = all.findIndex((i) => i.pos === anchor.pos);
  const h = all.findIndex((i) => i.pos === head.pos);
  if (a < 0 || h < 0) return [];
  return all.slice(Math.min(a, h), Math.max(a, h) + 1);
}

/** Selected items whose parent is not selected: what block operations move. */
function topLevel(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (!out.some((p) => item.pos > p.pos && item.pos < p.pos + p.node.nodeSize)) out.push(item);
  }
  return out;
}

/** The top-level selection as one run of siblings, or null if it is not one. */
function group(state: EditorState): Group | null {
  const top = topLevel(selectedItems(state));
  if (top.length === 0) return null;
  const list = listOf(state.doc, top[0]);
  for (let i = 1; i < top.length; i++) {
    const here = listOf(state.doc, top[i]);
    if (here.pos !== list.pos || here.index !== list.index + i) return null;
  }
  return top;
}

const bidOf = (n: PMNode) => n.attrs.bid as string;

const setSel = (tr: Transaction, sel: BlockSelection | null) => tr.setMeta(selectionKey, { sel });

/** Starts block selection on the item at the cursor. */
export function selectCurrent(state: EditorState): Transaction | null {
  const item = itemAt(state.selection.$head);
  if (!item?.node.attrs.bid) return null;
  return selectBlocks(state.tr, item, item);
}

/** Selects the blocks from `anchor` to `head` (screen order), leaving text
 *  editing; the text cursor rests at the head block. */
export function selectBlocks(tr: Transaction, anchor: Item, head: Item): Transaction {
  tr.setSelection(TextSelection.create(tr.doc, head.pos + 2));
  return setSel(tr, { anchor: bidOf(anchor.node), head: bidOf(head.node) });
}

// ---- copy and cut (design/outliner.md "复制、剪切、粘贴") ----

const taskPrefix = (n: PMNode) =>
  n.type.name !== "taskItem" ? "" : n.attrs.checked ? "[x] " : n.attrs.status === "doing" ? "[-] " : "[ ] ";

/** A line as Markdown text: card links as `[[title]]`, hard breaks kept. */
const lineText = (line: PMNode | null) =>
  line
    ? line.textBetween(0, line.content.size, "", (leaf) =>
        leaf.type.name === "cardLink" ? `[[${leaf.attrs.title as string}]]` : leaf.type.name === "hardBreak" ? "\n" : "",
      )
    : "";

/** Blocks as a Markdown outline, tab-indented like Logseq's copy. */
export function itemsToMarkdown(items: PMNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(`${"\t".repeat(depth)}- ${taskPrefix(item)}${lineText(item.firstChild)}`);
    item.forEach((child) => {
      if (isList(child)) {
        const kids: PMNode[] = [];
        child.forEach((k) => void kids.push(k));
        out.push(...itemsToMarkdown(kids, depth + 1));
      }
    });
  }
  return out;
}

/** Puts the selected blocks on the clipboard: Markdown text plus HTML that
 *  keeps the structure (and block ids, for a move after a cut). */
function copyBlocks(view: EditorView, e: ClipboardEvent, cut: boolean): boolean {
  const items = topLevel(selectedItems(view.state));
  if (items.length === 0 || !e.clipboardData) return false;
  e.preventDefault();
  const nodes = items.map((i) => i.node);
  const list = view.state.schema.nodes.bulletList.create(null, Fragment.from(nodes));
  const { dom } = view.serializeForClipboard(new Slice(Fragment.from(list), 0, 0));
  e.clipboardData.setData("text/html", dom.innerHTML);
  e.clipboardData.setData("text/plain", itemsToMarkdown(nodes).join("\n"));
  if (cut) {
    const bids: string[] = [];
    for (const n of nodes) n.descendants((d) => void (d.attrs.bid && bids.push(d.attrs.bid as string)));
    for (const n of nodes) if (n.attrs.bid) bids.push(n.attrs.bid as string);
    rememberCut(bids);
    const tr = view.state.tr;
    const above = visibleNeighbour(view.state.doc, selectedItems(view.state)[0], -1);
    for (const item of [...items].reverse()) deleteItems(tr, [itemAtOrNull(tr.doc, item.pos)!]);
    setSel(tr, null);
    const at = above && itemAtOrNull(tr.doc, tr.mapping.map(above.pos));
    if (at) editAt(tr, at);
    view.dispatch(tr);
  }
  return true;
}

function decorations(state: EditorState): DecorationSet {
  const items = selectedItems(state);
  if (items.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    items.map((i) => Decoration.node(i.pos, i.pos + i.node.nodeSize, { class: "block-selected" })),
  );
}

/** Puts the text cursor at the end of the item's first line and leaves
 *  block selection. */
function editAt(tr: Transaction, item: Item) {
  const end = item.pos + 1 + item.node.firstChild!.nodeSize - 1;
  setSel(tr, null).setSelection(TextSelection.create(tr.doc, end));
}

function keydown(view: EditorView, e: KeyboardEvent): boolean {
  const { state } = view;
  const sel = blockSelection(state);
  if (!sel) return false;
  const mod = e.metaKey || e.ctrlKey;
  const items = selectedItems(state);
  const head = findByBid(state.doc, sel.head);
  if (!head || items.length === 0) {
    view.dispatch(setSel(state.tr, null));
    return false;
  }
  const run = (tr: Transaction | null) => {
    if (tr) view.dispatch(tr.scrollIntoView());
    return true;
  };

  // Mod+A: the parent block; at the top level, every block of the outline.
  if (mod && e.key.toLowerCase() === "a") {
    const parent = parentItem(state.doc, items[0]);
    if (parent) return run(selectBlocks(state.tr, parent, parent));
    const all = visibleItems(rootList(state.doc, items[0]));
    return run(selectBlocks(state.tr, all[0], all[all.length - 1]));
  }
  if (e.key === "Escape") {
    view.dispatch(setSel(state.tr, null));
    view.dom.blur();
    return true;
  }
  if (e.key === "Enter" && !mod) return run(((tr) => (editAt(tr, head), tr))(state.tr));
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && !e.altKey) {
    const next = visibleNeighbour(state.doc, head, e.key === "ArrowUp" ? -1 : 1);
    if (!next) return true;
    const nb = bidOf(next.node);
    return run(setSel(state.tr, { anchor: e.shiftKey ? sel.anchor : nb, head: nb }));
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    const top = topLevel(items);
    const above = visibleNeighbour(state.doc, items[0], -1);
    const tr = state.tr;
    // From the bottom up so earlier positions stay valid.
    for (const item of [...top].reverse()) deleteItems(tr, [itemAtOrNull(tr.doc, item.pos)!]);
    setSel(tr, null);
    if (above) {
      const at = itemAtOrNull(tr.doc, tr.mapping.map(above.pos));
      if (at) editAt(tr, at);
    }
    return run(tr);
  }
  const groupOp =
    e.key === "Tab" ? (e.shiftKey ? outdentItems : indentItems)
    : mod && e.shiftKey && e.key === "ArrowUp" ? moveItemsUp
    : mod && e.shiftKey && e.key === "ArrowDown" ? moveItemsDown
    : e.altKey && e.shiftKey && e.key === "ArrowUp" ? moveItemsUp
    : e.altKey && e.shiftKey && e.key === "ArrowDown" ? moveItemsDown
    : null;
  if (groupOp) {
    const g = group(state);
    if (!g) return true;
    const tr = state.tr;
    groupOp(tr, g);
    return run(tr);
  }
  if (mod && e.key === "Enter") {
    const tr = state.tr;
    for (const item of items) cycleKind(tr, itemAtOrNull(tr.doc, tr.mapping.map(item.pos))!);
    return run(tr);
  }
  // Undo and other shortcuts pass through; plain typing does nothing.
  return !mod;
}

const itemAtOrNull = (doc: PMNode, pos: number): Item | null => {
  const node = doc.nodeAt(pos);
  return isItem(node) ? { node: node!, pos } : null;
};

/** A mouse selection (drag or Shift+click) that crosses from one block into
 *  another becomes a block selection, as in Logseq. */
function mouseSelectionView(view: EditorView) {
  let pointer = false;
  const down = () => void (pointer = true);
  const up = () => {
    if (!pointer) return;
    pointer = false;
    const { state } = view;
    const { $anchor, $head, empty } = state.selection;
    if (empty || blockSelection(state)) return;
    const a = itemAt($anchor);
    const h = itemAt($head);
    if (!a || !h || a.pos === h.pos) return;
    // Only within one outline, and not when one block contains the other's
    // text selection end (a parent and its child are still two blocks).
    if (rootList(state.doc, a).pos !== rootList(state.doc, h).pos) return;
    const ia = a.node.attrs.bid ? a : null;
    if (!ia || !h.node.attrs.bid) return;
    view.dispatch(selectBlocks(state.tr, a, h));
  };
  view.dom.addEventListener("mousedown", down);
  document.addEventListener("mouseup", up);
  return { destroy: () => (view.dom.removeEventListener("mousedown", down), document.removeEventListener("mouseup", up)) };
}

/** `outline`: a mouse selection across blocks becomes a block selection
 *  (Logseq); in documents it stays a text selection (Notion). */
export function blockSelectionPlugin(outline = true) {
  return new Plugin<BlockSelection | null>({
    key: selectionKey,
    view: outline ? mouseSelectionView : undefined,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(selectionKey) as { sel: BlockSelection | null } | undefined;
        const next = meta ? meta.sel : value;
        if (!next) return null;
        // A typed or clicked text selection ends block selection.
        if (!meta && tr.selectionSet && !tr.docChanged) return null;
        if (!findByBid(state.doc, next.anchor) || !findByBid(state.doc, next.head)) return null;
        return next;
      },
    },
    props: {
      decorations,
      attributes: (state): Record<string, string> => (blockSelection(state) ? { class: "block-selecting" } : {}),
      handleKeyDown: keydown,
      handleTextInput: (view) => !!blockSelection(view.state),
      handleDOMEvents: {
        mousedown: (view, e) => {
          const sel = blockSelection(view.state);
          if (!sel) return false;
          // Shift+click extends the block selection to the clicked block.
          if (e.shiftKey) {
            const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
            const item = hit && itemAt(view.state.doc.resolve(hit.pos));
            const anchor = findByBid(view.state.doc, sel.anchor);
            if (item && anchor) {
              e.preventDefault();
              view.dispatch(selectBlocks(view.state.tr, anchor, item));
              return true;
            }
          }
          view.dispatch(setSel(view.state.tr, null));
          return false;
        },
        copy: (view, e) => !!blockSelection(view.state) && copyBlocks(view, e, false),
        cut: (view, e) => !!blockSelection(view.state) && copyBlocks(view, e, true),
      },
    },
  });
}
