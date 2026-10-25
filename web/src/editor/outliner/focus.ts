import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isItem } from "./tree";

/** View state, not document content: which item the editor is focused on
 *  (shown alone, like opening a block in Logseq). Never synced. */
export const focusKey = new PluginKey<string | null>("outlineFocus");

export const focusedBid = (state: EditorState) => focusKey.getState(state) ?? null;

/** Position of the item with block id `bid`, or null. */
export function findItem(doc: PMNode, bid: string): number | null {
  let found: number | null = null;
  doc.descendants((n, pos) => {
    if (found !== null) return false;
    if (isItem(n) && n.attrs.bid === bid) found = pos;
    return true;
  });
  return found;
}

/** The focused item's ancestors from the outside in, for the breadcrumb. */
export function focusTrail(state: EditorState): { bid: string; text: string }[] {
  const bid = focusedBid(state);
  if (!bid) return [];
  const pos = findItem(state.doc, bid);
  if (pos === null) return [];
  const $p = state.doc.resolve(pos);
  const trail: { bid: string; text: string }[] = [];
  for (let d = 1; d <= $p.depth; d++) {
    const n = $p.node(d);
    if (isItem(n)) trail.push({ bid: n.attrs.bid as string, text: n.firstChild?.textContent ?? "" });
  }
  const self = state.doc.nodeAt(pos)!;
  trail.push({ bid, text: self.firstChild?.textContent ?? "" });
  return trail;
}

/** Hides everything except the focused item: siblings along the way are
 *  hidden, ancestors lose their own line and indentation. */
function decorations(state: EditorState): DecorationSet {
  const bid = focusedBid(state);
  if (!bid) return DecorationSet.empty;
  const pos = findItem(state.doc, bid);
  if (pos === null) return DecorationSet.empty;
  const $p = state.doc.resolve(pos);
  const decos: Decoration[] = [];
  for (let d = 0; d <= $p.depth; d++) {
    const container = $p.node(d);
    const start = d === 0 ? 0 : $p.start(d);
    const keep = $p.index(d);
    container.forEach((child, offset, i) => {
      const from = start + offset;
      if (i !== keep) decos.push(Decoration.node(from, from + child.nodeSize, { class: "folio-hidden" }));
      else if (from !== pos) decos.push(Decoration.node(from, from + child.nodeSize, { class: "folio-focus-path" }));
    });
  }
  const self = state.doc.nodeAt(pos)!;
  decos.push(Decoration.node(pos, pos + self.nodeSize, { class: "folio-focus-root" }));
  return DecorationSet.create(state.doc, decos);
}

export function focusPlugin() {
  return new Plugin<string | null>({
    key: focusKey,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(focusKey) as { bid: string | null } | undefined;
        const next = meta ? meta.bid : value;
        // The focused item was deleted (here or on another device).
        if (next && tr.docChanged && findItem(state.doc, next) === null) return null;
        return next;
      },
    },
    props: { decorations },
  });
}
