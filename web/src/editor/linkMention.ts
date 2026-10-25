// Turning an unlinked mention into a card link (backlinks panel): the first
// occurrence of the card's title in the block becomes a cardLink.

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { DocHub } from "../docs/hub";
import { withHeadlessEditor } from "./headless";

const ITEMS = new Set(["listItem", "taskItem"]);
/** Transaction meta: the text a link replaced. */
export const LINKED_TEXT = "linkedText";

/** The block with this id and the position of its node. */
function findBlock(doc: PMNode, bid: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isBlock && node.attrs.bid === bid) found = { node, pos };
    return !found;
  });
  return found;
}

/** The text blocks a block's text comes from (as the index reads it): an
 *  item's own lines, not its children's. */
function textblocks(block: { node: PMNode; pos: number }): { node: PMNode; pos: number }[] {
  if (block.node.isTextblock) return [block];
  if (!ITEMS.has(block.node.type.name)) return [];
  const out: { node: PMNode; pos: number }[] = [];
  block.node.forEach((child, offset) => {
    if (child.isTextblock) out.push({ node: child, pos: block.pos + 1 + offset });
  });
  return out;
}

/** A transaction linking the first mention of `title` in block `bid`, or
 *  null when the block has none (already linked, or edited since). Matches
 *  case-insensitively, within plain text (not across links or marks'
 *  boundaries with inline nodes). */
export function linkInBlock(state: EditorState, bid: string, target: { cardId: string; title: string }): Transaction | null {
  const block = findBlock(state.doc, bid);
  const title = target.title.trim();
  if (!block || !title) return null;
  const needle = title.toLowerCase();
  for (const tb of textblocks(block)) {
    // Runs of adjacent text nodes, with their document positions.
    let run = "";
    let runStart = -1;
    const check = (): Transaction | null => {
      const i = run.toLowerCase().indexOf(needle);
      if (runStart < 0 || i < 0) return null;
      const from = runStart + i;
      const link = state.schema.nodes.cardLink.create({ cardId: target.cardId, title });
      // The text as written, for unlinking back to it.
      return state.tr.replaceWith(from, from + title.length, link).setMeta(LINKED_TEXT, run.slice(i, i + title.length));
    };
    let hit: Transaction | null = null;
    tb.node.forEach((child, offset) => {
      if (hit) return;
      const pos = tb.pos + 1 + offset;
      if (child.isText) {
        if (runStart < 0) runStart = pos;
        run += child.text;
      } else {
        hit = check();
        run = "";
        runStart = -1;
      }
    });
    hit ??= check();
    if (hit) return hit;
  }
  return null;
}

/** The inverse: the first link to `cardId` in block `bid` becomes plain
 *  text again: `text` (what it replaced), else the link's title. */
export function unlinkInBlock(state: EditorState, bid: string, cardId: string, text?: string): Transaction | null {
  const block = findBlock(state.doc, bid);
  if (!block) return null;
  for (const tb of textblocks(block)) {
    let at: { pos: number; node: PMNode } | null = null;
    tb.node.forEach((child, offset) => {
      if (!at && child.type.name === "cardLink" && child.attrs.cardId === cardId) at = { pos: tb.pos + 1 + offset, node: child };
    });
    if (at) {
      const { pos, node } = at as { pos: number; node: PMNode };
      return state.tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(text || (node.attrs.title as string)));
    }
  }
  return null;
}

/** Runs a block edit on card `sourceId` through a headless editor; the
 *  dispatched transaction, or null when there was nothing to do. */
async function editCard(hub: DocHub, sourceId: string, edit: (state: EditorState) => Transaction | null): Promise<Transaction | null> {
  const handle = await hub.open(sourceId);
  try {
    return await withHeadlessEditor(handle, (editor) => {
      const tr = edit(editor.state);
      if (tr) editor.view.dispatch(tr);
      return tr;
    });
  } finally {
    void hub.release(sourceId);
  }
}

/** Undoes `linkMention`, putting back the text it replaced. */
export async function unlinkMention(hub: DocHub, sourceId: string, bid: string, cardId: string, text?: string): Promise<boolean> {
  return !!(await editCard(hub, sourceId, (state) => unlinkInBlock(state, bid, cardId, text)));
}

/** Links the mention in card `sourceId`'s block `bid`; returns the text
 *  it replaced, or null when there is nothing to link there any more. */
export async function linkMention(hub: DocHub, sourceId: string, bid: string, target: { cardId: string; title: string }): Promise<string | null> {
  const tr = await editCard(hub, sourceId, (state) => linkInBlock(state, bid, target));
  return tr ? ((tr.getMeta(LINKED_TEXT) as string | undefined) ?? target.title) : null;
}
