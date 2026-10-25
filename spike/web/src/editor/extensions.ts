import { Extension, type AnyExtension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

/** Block-level node types that carry a stable `bid` (block-reference anchor). */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "listItem",
  "taskItem",
  "image",
  "horizontalRule",
] as const;

const BLOCK_SET = new Set<string>(BLOCK_TYPES);

/** UUIDv7-ish: time-ordered, random tail. Good enough for the spike. */
export function newBid(): string {
  const t = Date.now().toString(16).padStart(12, "0");
  const r = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${t}-${hex}`;
}

const blockIdKey = new PluginKey("block-id");

/** True for transactions produced by applying a remote update or an undo. */
export type RemoteTxPredicate = (tr: Transaction) => boolean;

/**
 * "local-only": fix ids only after local edits (first version of the spike).
 * "all": also repair duplicates that arrive through merges and undo. Neither
 * binding has a real "move" for ProseMirror nodes, so a drag is delete+insert;
 * undoing it while a peer edited the moved copy leaves two blocks with one id.
 */
export const bidRepair = { mode: "all" as "local-only" | "all" };

/**
 * Every replica that sees the same duplicates must pick the same new ids, or
 * concurrent repairs would fight. So the first block in document order keeps
 * the id and later copies get `${bid}~n`, derived only from the document.
 */
function repairedId(bid: string, taken: Set<string>): string {
  const base = bid.replace(/~\d+$/, "");
  for (let n = 1; ; n++) {
    const id = `${base}~${n}`;
    if (!taken.has(id)) return id;
  }
}

export function BlockId(isRemote: RemoteTxPredicate) {
  return Extension.create({
    name: "blockId",
    // Must run before the CRDT binding's appendTransaction. loro-prosemirror
    // writes to Loro inside appendTransaction, so if the id fix-up came later
    // one user action would become two commits (two undo steps), and undo
    // would restore the pre-fix state with missing/duplicate ids.
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
              renderHTML: (attrs: Record<string, unknown>) =>
                attrs.bid ? { "data-bid": attrs.bid } : {},
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
            if (bidRepair.mode === "local-only" || scheduled) return null;
            // Repairs for merged/undone content go out as their own local
            // edit after the binding finishes rendering: y-prosemirror holds a
            // mutex while it renders a remote change and silently skips any
            // ProseMirror change appended inside it, so an appended repair
            // would never reach Yjs. Both engines get the same treatment.
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (!view) return;
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

/** Gives every block a unique id; null when nothing needed fixing. */
function repairIds(state: EditorState): Transaction | null {
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
  // Stays in the same history step as the edit that needed it: both
  // bindings treat the whole view update as one undo step.
  return changed ? tr : null;
}

/** Everything except the CRDT binding, shared by both prototypes. */
export function baseExtensions(isRemote: RemoteTxPredicate): AnyExtension[] {
  return [
    StarterKit.configure({
      // The CRDT binding owns undo; ProseMirror history would fight it.
      undoRedo: false,
      // trailingNode appends a node in appendTransaction on every peer, which
      // duplicates paragraphs after a merge.
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    BlockId(isRemote),
  ];
}
