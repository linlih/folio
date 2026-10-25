// Flashing a block (opened from a backlink, search hit or block reference).

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

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

/** Scrolls the block into view and highlights it briefly. */
export function flashBlock(view: EditorView, bid: string) {
  const at = findBlock(view, bid);
  if (!at) return;
  view.dispatch(view.state.tr.setMeta(key, bid));
  const dom = view.nodeDOM(at.pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => {
    if (!view.isDestroyed && key.getState(view.state) === bid) view.dispatch(view.state.tr.setMeta(key, null));
  }, FLASH_MS);
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
