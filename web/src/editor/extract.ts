import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { LoroDoc } from "loro-crdt";
import { docs } from "../app";
import { cardsChanged } from "../card/actions";
import { initCard } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { uuidv7 } from "../docs/ids";
import { backend } from "../platform";
import { updateLoroToPmState, type LoroDocType } from "../vendor/loro-prosemirror";
import { tagNextStep } from "./stepTags";

/** What extracting the block at the cursor will do. */
export interface Extraction {
  title: string;
  /** Blocks that move into the new card, ids unchanged (§4.2). */
  body: PMNode[];
  /** Replaces the extracted range with a link to `cardId`. */
  apply(state: EditorState, cardId: string): ReturnType<EditorState["tr"]["replaceWith"]>;
}

/** The innermost list item around the cursor, or else the top-level block.
 *  Its first line becomes the title; what is under it becomes the body. */
export function planExtraction(state: EditorState): Extraction | null {
  const { $head } = state.selection;
  const schema = state.schema;
  for (let d = $head.depth; d > 0; d--) {
    const node = $head.node(d);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
    const first = node.firstChild;
    if (!first?.isTextblock) return null;
    const pos = $head.before(d);
    const rest: PMNode[] = [];
    node.forEach((child, _off, i) => void (i > 0 && rest.push(child)));
    return {
      title: first.textContent.trim(),
      body: rest,
      // The item stays where it was; its first line becomes the link and its
      // children leave with the card.
      apply: (s, cardId) => {
        const link = schema.nodes.cardLink.create({ cardId, title: first.textContent.trim() });
        const line = first.type.create(first.attrs, link);
        return s.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, line);
      },
    };
  }
  if ($head.depth < 1) return null;
  const block = $head.node(1);
  if (!block.isTextblock || !block.textContent.trim()) return null;
  const pos = $head.before(1);
  return {
    title: block.textContent.trim(),
    body: [],
    apply: (s, cardId) => {
      const link = schema.nodes.cardLink.create({ cardId, title: block.textContent.trim() });
      return s.tr.replaceWith(pos + 1, pos + block.nodeSize - 1, link);
    },
  };
}

/** A card is a document: the extracted items' first level becomes normal
 *  paragraphs (each keeping its item's block id, which is what references
 *  point at); deeper levels stay lists; tasks stay tasks. */
export function toDocumentBlocks(schema: Schema, body: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of body) {
    if (!["bulletList", "orderedList", "taskList"].includes(node.type.name)) {
      out.push(node);
      continue;
    }
    node.forEach((item) => {
      if (item.type.name === "taskItem") {
        out.push(schema.nodes.bulletList.create(null, item));
        return;
      }
      item.forEach((child, _o, i) => {
        if (i === 0 && child.isTextblock) out.push(child.type.create({ ...child.attrs, bid: item.attrs.bid ?? child.attrs.bid }, child.content, child.marks));
        else out.push(child);
      });
    });
  }
  return out;
}

/** Writes a new card whose body is `body` (ProseMirror nodes) into a Loro
 *  document, in the layout loro-prosemirror reads. */
export function buildCard(schema: Schema, peer: string, title: string, body: PMNode[], now: number): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(BigInt(peer));
  initCard(doc, "note", title, now);
  const blocks = toDocumentBlocks(schema, body);
  const content = blocks.length ? Fragment.from(blocks) : Fragment.from(schema.nodes.paragraph.create());
  const pmDoc = schema.nodes.doc.create(null, content);
  updateLoroToPmState(doc as unknown as LoroDocType, new Map(), { doc: pmDoc } as EditorState);
  return doc;
}

/** Turns the block at the cursor into a new card and links to it, as one
 *  undo step of this document (undo also trashes the new card). */
export async function extractToCard(editor: Editor, handle: DocHandle): Promise<string | null> {
  const plan = planExtraction(editor.state);
  if (!plan) return null;
  const cardId = uuidv7();
  const info = await backend.appInfo();
  const card = buildCard(editor.schema, info.frontendPeer, plan.title, plan.body, Date.now());
  // The card is written before the link to it exists (§4.2): a crash in
  // between leaves an unlinked card, never a link to nothing.
  await backend.applyUpdate(cardId, "card", card.export({ mode: "snapshot" }));
  await docs().flushAll();
  if (editor.isDestroyed) return cardId;
  tagNextStep(handle.undo, { kind: "extract", cardId, title: plan.title });
  editor.view.dispatch(plan.apply(editor.state, cardId));
  cardsChanged();
  return cardId;
}

export const EXTRACT_SHORTCUT = "Mod-Alt-Enter";

export function extractExtension(handle: DocHandle) {
  return Extension.create({
    name: "extractToCard",
    addKeyboardShortcuts() {
      return {
        [EXTRACT_SHORTCUT]: () => {
          void extractToCard(this.editor, handle);
          return true;
        },
      };
    },
  });
}
