// The assistant's changes to the notes (design/ai.md, phase 2). Each write
// tool is shown to the user first, as a proposal, unless they chose to let
// it change notes directly; each change made is kept with the conversation
// with what undoes it, so it can be undone later and on another device.
// Blocks it writes are marked "ai:<model>" (§0.3 provenance).

import type { Node as PmNode } from "@tiptap/pm/model";
import { DOMSerializer } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { docs, notes } from "../app";
import { cardsChanged, moveToTrash } from "../card/actions";
import { cardName } from "../card/reveal";
import { readCardTopics, readMeta, setTitle } from "../docs/card";
import { isJournalId } from "../docs/ids";
import { setCardsTopic, workspaceDoc } from "../docs/topics";
import { readTopics, type Topic } from "../docs/workspace";
import { withHeadlessEditor } from "../editor/headless";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { inlineHtml, parseInline, parseMarkdown, toHtml } from "./markdown";
import type { AiTool } from "./types";

/** What undoes a change made. */
export type Change =
  | { kind: "create"; cardId: string }
  | { kind: "append"; cardId: string; bids: string[] }
  | { kind: "update"; cardId: string; bid: string; before: string; afterText: string }
  | { kind: "rename"; cardId: string; before: string; after: string }
  | { kind: "topic"; cardId: string; topic: string; add: boolean };

/** A write tool call as kept with its result: where, and what came of it. */
export interface WriteRecord {
  /** The card's name, as it was. */
  target: string;
  cardId: string | null;
  status: "done" | "declined" | "failed";
  change?: Change;
}

/** A write tool call as shown before it is made. */
export interface Proposal {
  target: string;
  cardId: string | null;
  /** Markdown to be written. */
  content?: string;
  before?: string;
  after?: string;
  topic?: string;
  add?: boolean;
}

const CARD_ID = { type: "string", description: "Card id, or journal:YYYY-MM-DD for a journal day." };

export const WRITE_TOOLS: AiTool[] = [
  {
    name: "create_card",
    description: "Create a new card with a title and content (Markdown: headings, lists, task lists `- [ ]`, tables, code, links to notes as folio:card/… and folio:block/…). Returns the new card's id.",
    schema: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string", description: "The card's content in Markdown, without the title." } },
      required: ["title", "content"],
    },
  },
  {
    name: "append_to_card",
    description: "Add content (Markdown) at the end of a card or a journal day. In the journal, the content becomes outline items. Use journal:<today's date> to add to today's journal.",
    schema: { type: "object", properties: { card_id: CARD_ID, content: { type: "string" } }, required: ["card_id", "content"] },
  },
  {
    name: "update_block",
    description: "Replace the text of one block (a paragraph, heading, list item or task) with new text: inline Markdown only (bold, italic, code, links), one block. Read the card first for its block ids.",
    schema: {
      type: "object",
      properties: { card_id: CARD_ID, block_id: { type: "string" }, text: { type: "string" } },
      required: ["card_id", "block_id", "text"],
    },
  },
  {
    name: "rename_card",
    description: "Change a card's title.",
    schema: { type: "object", properties: { card_id: { type: "string" }, title: { type: "string" } }, required: ["card_id", "title"] },
  },
  {
    name: "set_card_topic",
    description: "File a card under an existing topic, or take it out (in: false). Topics are listed by list_topics.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" }, topic: { type: "string", description: "Topic id, name, or path as “Parent › Name”." }, in: { type: "boolean", default: true } },
      required: ["card_id", "topic"],
    },
  },
];

const NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
export const isWriteTool = (name: string) => NAMES.has(name);

const str = (input: Record<string, unknown>, key: string) => {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`“${key}” is missing.`);
  return v;
};

/** A card that exists and is not in the trash (a journal day may be new). */
async function cardTitle(cardId: string): Promise<string> {
  const snapshot = await backend.docSnapshot(cardId);
  if (!snapshot) {
    if (isJournalId(cardId)) return cardName(cardId, "");
    throw new Error(`No card with id ${cardId}.`);
  }
  const h = await docs().open(cardId);
  try {
    const meta = readMeta(h.doc);
    if (meta.deletedAt !== null) throw new Error(`The card ${cardId} is in the trash.`);
    return cardName(cardId, meta.title);
  } finally {
    void docs().release(cardId);
  }
}

/** Finds a block and the textblock that holds its text. */
function findBlock(editor: Editor, bid: string): { pos: number; node: PmNode; text: { pos: number; node: PmNode } } {
  let found: { pos: number; node: PmNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.bid === bid) found = { pos, node };
    return true;
  });
  if (!found) throw new Error(`No block ${bid} in this card.`);
  const { pos, node } = found as { pos: number; node: PmNode };
  if (node.isTextblock) return { pos, node, text: { pos, node } };
  const first = node.firstChild;
  if (first?.isTextblock) return { pos, node, text: { pos: pos + 1, node: first } };
  throw new Error(`The block ${bid} has no text of its own.`);
}

const contentHtml = (editor: Editor, node: PmNode) => {
  const box = document.createElement("div");
  box.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(node.content));
  return box.innerHTML;
};

/** Replaces a textblock's content with inline HTML, marked as `source`'s. */
function replaceText(editor: Editor, at: { pos: number; node: PmNode }, html: string, source: string | null) {
  const from = at.pos + 1;
  const to = from + at.node.content.size;
  if (html) editor.commands.insertContentAt({ from, to }, html, { updateSelection: false });
  else if (to > from) editor.commands.command(({ tr }) => (tr.delete(from, to), true));
  editor.commands.command(({ tr }) => (tr.setNodeAttribute(at.pos, "source", source), true));
}

function resolveTopic(topics: Topic[], query: string): Topic {
  const q = query.trim().toLowerCase();
  const path = (t: Topic) => {
    const parent = t.parent ? topics.find((p) => p.id === t.parent) : null;
    return parent ? `${parent.name} › ${t.name}` : t.name;
  };
  const norm = (s: string) => s.toLowerCase().replace(/\s*[›>/]\s*/g, " › ");
  const hits = topics.filter((t) => t.id === query || t.name.toLowerCase() === q || norm(path(t)) === norm(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`More than one topic is called “${query}”: ${hits.map((t) => `${path(t)} (id ${t.id})`).join(", ")}.`);
  throw new Error(`No topic “${query}”. Topics: ${topics.map(path).join(", ") || "none"}.`);
}

/** What the call would do, for the user to decide on. Throws when it cannot be made. */
export async function propose(name: string, input: Record<string, unknown>): Promise<Proposal> {
  switch (name) {
    case "create_card": {
      const title = str(input, "title").trim();
      if (!title) throw new Error("The title is empty.");
      return { target: title, cardId: null, content: str(input, "content") };
    }
    case "append_to_card": {
      const cardId = str(input, "card_id");
      return { target: await cardTitle(cardId), cardId, content: str(input, "content") };
    }
    case "update_block": {
      const cardId = str(input, "card_id");
      const target = await cardTitle(cardId);
      const bid = str(input, "block_id");
      const h = await docs().open(cardId);
      try {
        const before = await withHeadlessEditor(h, (editor) => findBlock(editor, bid).text.node.textContent);
        return { target, cardId, before, after: str(input, "text") };
      } finally {
        void docs().release(cardId);
      }
    }
    case "rename_card": {
      const cardId = str(input, "card_id");
      const target = await cardTitle(cardId);
      return { target, cardId, before: target, after: str(input, "title").trim() };
    }
    case "set_card_topic": {
      const cardId = str(input, "card_id");
      const topic = resolveTopic(readTopics((await workspaceDoc()).doc), str(input, "topic"));
      return { target: await cardTitle(cardId), cardId, topic: topic.name, add: input.in !== false };
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

/** New blocks: those not there before, outermost only. */
function newBlocks(doc: PmNode, before: Set<string>): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    const bid = node.attrs.bid as string | null;
    if (bid && !before.has(bid)) {
      out.push(bid);
      return false;
    }
    return true;
  });
  return out;
}

function allBlocks(doc: PmNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((node) => void (node.attrs.bid && out.add(node.attrs.bid as string)));
  return out;
}

/** Makes the change; returns what the model is told, and what undoes it. */
export async function apply(name: string, input: Record<string, unknown>, source: string): Promise<{ content: string; change: Change | null }> {
  const hub = docs();
  switch (name) {
    case "create_card": {
      const title = str(input, "title").trim();
      const cardId = await notes().createCard({ title, source });
      const h = await hub.open(cardId);
      try {
        await withHeadlessEditor(h, (editor) => editor.commands.setContent(toHtml(parseMarkdown(str(input, "content")), source)));
        await h.persistence.flush();
      } finally {
        await hub.release(cardId);
      }
      cardsChanged();
      return { content: `Created the card “${title}” (id ${cardId}).`, change: { kind: "create", cardId } };
    }
    case "append_to_card": {
      const cardId = str(input, "card_id");
      const title = await cardTitle(cardId);
      const text = str(input, "content");
      const html = toHtml(parseMarkdown(text), source);
      const h = await hub.open(cardId);
      try {
        const bids = await withHeadlessEditor(h, (editor) => {
          const before = allBlocks(editor.state.doc);
          const { state } = editor.view;
          if (isJournalId(cardId)) {
            // As pasted at the end of the day: the outline's rules apply.
            editor.view.dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
            const data = new DataTransfer();
            data.setData("text/html", html);
            data.setData("text/plain", text);
            editor.view.pasteHTML(html, new ClipboardEvent("paste", { clipboardData: data }));
          } else if (state.doc.childCount === 1 && state.doc.firstChild!.isTextblock && state.doc.firstChild!.content.size === 0) {
            editor.commands.setContent(html);
          } else {
            editor.commands.insertContentAt(state.doc.content.size, html, { updateSelection: false });
          }
          return newBlocks(editor.state.doc, before);
        });
        await h.persistence.flush();
        return { content: `Added to “${title}”.`, change: { kind: "append", cardId, bids } };
      } finally {
        await hub.release(cardId);
      }
    }
    case "update_block": {
      const cardId = str(input, "card_id");
      const title = await cardTitle(cardId);
      const bid = str(input, "block_id");
      const h = await hub.open(cardId);
      try {
        const change = await withHeadlessEditor(h, (editor) => {
          const at = findBlock(editor, bid).text;
          const before = contentHtml(editor, at.node);
          replaceText(editor, at, inlineHtml(parseInline(str(input, "text"))), source);
          const afterText = findBlock(editor, bid).text.node.textContent;
          return { kind: "update" as const, cardId, bid, before, afterText };
        });
        await h.persistence.flush();
        return { content: `Changed the block ${bid} in “${title}”.`, change };
      } finally {
        await hub.release(cardId);
      }
    }
    case "rename_card": {
      const cardId = str(input, "card_id");
      await cardTitle(cardId);
      const after = str(input, "title").trim();
      const h = await hub.open(cardId);
      try {
        const before = readMeta(h.doc).title;
        setTitle(h.doc, after);
        await h.persistence.flush();
        useShell.getState().renameCard(cardId, after);
        cardsChanged();
        return { content: `Renamed the card to “${after}”.`, change: { kind: "rename", cardId, before, after } };
      } finally {
        await hub.release(cardId);
      }
    }
    case "set_card_topic": {
      const cardId = str(input, "card_id");
      await cardTitle(cardId);
      const topic = resolveTopic(readTopics((await workspaceDoc()).doc), str(input, "topic"));
      const add = input.in !== false;
      const h = await hub.open(cardId);
      const was = readCardTopics(h.doc).includes(topic.id);
      void hub.release(cardId);
      if (was === add) return { content: add ? `The card is already in “${topic.name}”.` : `The card is not in “${topic.name}”.`, change: null };
      await setCardsTopic([cardId], topic.id, add);
      return { content: add ? `Filed the card under “${topic.name}”.` : `Took the card out of “${topic.name}”.`, change: { kind: "topic", cardId, topic: topic.id, add } };
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

/** Thrown when what the change made was changed since: undoing it would
 *  lose the later edit. */
export class ChangedSince extends Error {}

/** Undoes a change made. */
export async function undo(change: Change): Promise<void> {
  const hub = docs();
  switch (change.kind) {
    case "create": {
      const h = await hub.open(change.cardId);
      const title = readMeta(h.doc).title;
      void hub.release(change.cardId);
      await moveToTrash(change.cardId, title);
      return;
    }
    case "append":
    case "update": {
      const h = await hub.open(change.cardId);
      try {
        await withHeadlessEditor(h, (editor) => {
          if (change.kind === "update") {
            const at = findBlock(editor, change.bid).text;
            if (at.node.textContent !== change.afterText) throw new ChangedSince();
            replaceText(editor, at, change.before, null);
            return;
          }
          const ranges: { from: number; to: number }[] = [];
          editor.state.doc.descendants((node, pos) => {
            if (node.attrs.bid && change.bids.includes(node.attrs.bid as string)) {
              ranges.push({ from: pos, to: pos + node.nodeSize });
              return false;
            }
            return true;
          });
          editor.commands.command(({ tr }) => {
            for (const r of ranges.reverse()) tr.deleteRange(tr.mapping.map(r.from), tr.mapping.map(r.to));
            return true;
          });
        });
        await h.persistence.flush();
      } finally {
        await hub.release(change.cardId);
      }
      return;
    }
    case "rename": {
      const h = await hub.open(change.cardId);
      try {
        if (readMeta(h.doc).title !== change.after) throw new ChangedSince();
        setTitle(h.doc, change.before);
        await h.persistence.flush();
        useShell.getState().renameCard(change.cardId, change.before);
        cardsChanged();
      } finally {
        await hub.release(change.cardId);
      }
      return;
    }
    case "topic":
      await setCardsTopic([change.cardId], change.topic, !change.add);
      return;
  }
}
