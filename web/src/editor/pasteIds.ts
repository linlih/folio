import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { BLOCK_TYPES } from "./blockId";

/** Block ids of the last cut, shared by every editor: a cut followed by a
 *  paste is a move and keeps ids; anything else is a copy (§4.2). */
let lastCut: Set<string> | null = null;

const BLOCK_SET = new Set<string>(BLOCK_TYPES);

function bids(fragment: Fragment): string[] {
  const out: string[] = [];
  fragment.descendants((n) => {
    if (BLOCK_SET.has(n.type.name) && n.attrs.bid) out.push(n.attrs.bid as string);
  });
  return out;
}

/** The fragment with every block's own id cleared (new ones are assigned). */
export function stripIds(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((n) => {
    // Only blocks' own ids: a block reference's `bid` is its target.
    const attrs = BLOCK_SET.has(n.type.name) ? { ...n.attrs, bid: null } : n.attrs;
    nodes.push(n.isText ? n : n.type.create(attrs, stripIds(n.content), n.marks));
  });
  return Fragment.from(nodes);
}

/** Copy-paste gives pasted blocks new ids (block refs stay unambiguous);
 *  cut-paste and drag keep them (the block moved). */
export const PasteIds = Extension.create({
  name: "pasteIds",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("pasteIds"),
        props: {
          handleDOMEvents: {
            cut: (view) => {
              lastCut = new Set(bids(view.state.selection.content().content));
              return false;
            },
          },
          transformPasted(slice, view) {
            if (view.dragging?.move) return slice;
            const ids = bids(slice.content);
            const cut = lastCut;
            if (cut && ids.length > 0 && ids.every((id) => cut.has(id))) {
              // A move happens once; pasting the same cut again is a copy.
              lastCut = null;
              return slice;
            }
            return new Slice(stripIds(slice.content), slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});

/** Block cut (block selection): the next paste of these blocks is a move. */
export function rememberCut(bids: string[]) {
  lastCut = new Set(bids);
}

export const _test = { reset: () => void (lastCut = null) };
