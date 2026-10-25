import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { newBid } from "../docs/ids";

/** Block-level node types that carry a stable `bid` (block-reference anchor, §4.2). */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "listItem",
  "taskItem",
  "horizontalRule",
  "image",
  "blockMath",
] as const;

const BLOCK_SET = new Set<string>(BLOCK_TYPES);

/** True for transactions produced by applying a remote update or an undo. */
export type RemoteTxPredicate = (tr: Transaction) => boolean;

/** Every replica that sees the same duplicates must pick the same new ids, or
 *  concurrent repairs would fight: the first block in document order keeps
 *  the id and later copies get `${bid}~n`, derived only from the document. */
function repairedId(bid: string, taken: Set<string>): string {
  const base = bid.replace(/~\d+$/, "");
  for (let n = 1; ; n++) {
    const id = `${base}~${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Gives every block a unique id; null when nothing needed fixing. */
export function repairIds(state: EditorState): Transaction | null {
  const all = new Set<string>();
  state.doc.descendants((node: PMNode) => {
    if (BLOCK_SET.has(node.type.name) && node.attrs.bid) all.add(node.attrs.bid as string);
  });
  const seen = new Set<string>();
  const tr = state.tr;
  let changed = false;
  state.doc.descendants((node: PMNode, pos: number) => {
    if (!BLOCK_SET.has(node.type.name)) return;
    const bid = node.attrs.bid as string | null;
    if (bid && !seen.has(bid)) {
      seen.add(bid);
      return;
    }
    // A missing id gets a random one: only a local edit can create it.
    const id = bid ? repairedId(bid, all) : newBid();
    all.add(id);
    seen.add(id);
    tr.setNodeAttribute(pos, "bid", id);
    changed = true;
  });
  return changed ? tr : null;
}

const blockIdKey = new PluginKey("blockId");

/** Block ids and provenance on every block (§4.2, §5.1 points 2–3). */
export function BlockId(isRemote: RemoteTxPredicate) {
  return Extension.create({
    name: "blockId",
    // Must run before the CRDT binding's appendTransaction, or one user action
    // would become two commits (two undo steps) (§5.1 point 2).
    priority: 1000,
    addGlobalAttributes() {
      return [
        {
          types: [...BLOCK_TYPES],
          attributes: {
            bid: {
              default: null,
              keepOnSplit: false,
              parseHTML: (el: HTMLElement) => el.getAttribute("data-bid"),
              renderHTML: (attrs: Record<string, unknown>) => (attrs.bid ? { "data-bid": attrs.bid } : {}),
            },
            // Who wrote the block: null is a person; "ai:<model>" or
            // "import:<source>" otherwise (§0.3). A split-off part is new text.
            source: {
              default: null,
              keepOnSplit: false,
              parseHTML: (el: HTMLElement) => el.getAttribute("data-source"),
              renderHTML: (attrs: Record<string, unknown>) => (attrs.source ? { "data-source": attrs.source } : {}),
            },
          },
        },
      ];
    },
    addProseMirrorPlugins() {
      let view: EditorView | null = null;
      let scheduled = false;
      return [
        new Plugin({
          key: blockIdKey,
          view(v) {
            view = v;
            return { destroy: () => void (view = null) };
          },
          appendTransaction(trs, _old, state) {
            if (!trs.some((tr) => tr.docChanged)) return null;
            if (!trs.some(isRemote)) return repairIds(state);
            if (scheduled) return null;
            // Repairs for merged or undone content go out as their own local
            // edit once the binding has finished applying the change.
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (!view || view.isDestroyed) return;
              const tr = repairIds(view.state);
              if (tr) view.dispatch(tr);
            });
            return null;
          },
        }),
      ];
    },
  });
}
