// Flashing a block (opened from a backlink, search hit or block reference).

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { findItem, focusedBid, focusKey } from "./outliner/focus";

const key = new PluginKey<string | null>("revealBlock");
const FLASH_MS = 1600;

function findBlock(view: EditorView, bid: string): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null;
  view.state.doc.descendants((n, pos) => {
    if (found) return false;
    if (n.isBlock && n.attrs.bid === bid) found = { pos, size: n.nodeSize };
    return true;
  });
  return found;
}

/** Where the shown block lands: mid-page with what is around it (a
 *  backlink or search hit), or at the top (a heading picked in the table
 *  of contents). */
export type RevealAlign = "center" | "start";

/** Scrolls the block into view and highlights it briefly. A block hidden
 *  inside collapsed items is unfolded first (as clicking their arrows
 *  would), and a focused (zoomed) outline that leaves it out is left.
 *  Whether the block was there to show. */
export function flashBlock(view: EditorView, bid: string, align: RevealAlign = "center"): boolean {
  const at = findBlock(view, bid);
  if (!at) return false;
  const tr = view.state.tr.setMeta(key, bid);
  const $at = view.state.doc.resolve(at.pos);
  for (let d = 1; d <= $at.depth; d++) {
    if ($at.node(d).attrs.collapsed) tr.setNodeAttribute($at.before(d), "collapsed", false);
  }
  const zoom = focusedBid(view.state);
  if (zoom) {
    const root = findItem(view.state.doc, zoom);
    const inside = root !== null && at.pos > root && at.pos < root + view.state.doc.nodeAt(root)!.nodeSize;
    if (!inside) tr.setMeta(focusKey, { bid: null });
  }
  view.dispatch(tr);
  const dom = view.nodeDOM(at.pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: align, behavior: "smooth" });
  setTimeout(() => {
    if (!view.isDestroyed && key.getState(view.state) === bid) view.dispatch(view.state.tr.setMeta(key, null));
  }, FLASH_MS);
  return true;
}

export const RevealBlock = Extension.create({
  name: "revealBlock",
  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(key) as string | null | undefined;
            return meta === undefined ? value : meta;
          },
        },
        props: {
          decorations(state) {
            const bid = key.getState(state);
            if (!bid) return null;
            let deco: Decoration | null = null;
            state.doc.descendants((n, pos) => {
              if (deco) return false;
              if (n.isBlock && n.attrs.bid === bid) deco = Decoration.node(pos, pos + n.nodeSize, { class: "folio-flash" });
              return true;
            });
            return deco ? DecorationSet.create(state.doc, [deco]) : null;
          },
        },
      }),
    ];
  },
});
