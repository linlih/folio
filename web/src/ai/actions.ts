// Keeping an answer (design/ai.md): as a card of its own, or at the end of
// today's journal, with its formatting and its links into the notes.

import { TextSelection } from "@tiptap/pm/state";
import { docs, notes } from "../app";
import { cardsChanged } from "../card/actions";
import { journalId, localDate } from "../docs/ids";
import { withHeadlessEditor } from "../editor/headless";
import { parseMarkdown, plain, toHtml } from "./markdown";

/** A title for an answer saved as a card: its first heading, or its first line. */
export function answerTitle(text: string, fallback: string): string {
  const blocks = parseMarkdown(text);
  const h = blocks.find((b) => b.t === "h");
  const first = h && h.t === "h" ? plain(h.c) : blocks[0]?.t === "p" ? plain(blocks[0].c).split("\n")[0] : "";
  const title = first.trim() || fallback;
  return title.length > 60 ? `${title.slice(0, 60)}…` : title;
}

/** Saves `text` (Markdown) as a new card; returns its id. */
export async function saveAsCard(text: string, title: string): Promise<string> {
  const id = await notes().createCard({ title, source: "human" });
  const hub = docs();
  const h = await hub.open(id);
  try {
    // A first heading that became the title is not repeated under it.
    const blocks = parseMarkdown(text);
    const first = blocks[0];
    const body = first?.t === "h" && plain(first.c).trim() === title ? blocks.slice(1) : blocks;
    await withHeadlessEditor(h, (editor) => editor.commands.setContent(toHtml(body)));
    await h.persistence.flush();
  } finally {
    await hub.release(id);
  }
  cardsChanged();
  return id;
}

/** Adds `text` (Markdown) at the end of today's journal, as pasted there. */
export async function appendToJournal(text: string, now = new Date()): Promise<void> {
  const id = journalId(localDate(now));
  const hub = docs();
  const h = await hub.open(id);
  try {
    await withHeadlessEditor(h, (editor) => {
      const html = toHtml(parseMarkdown(text));
      const { state } = editor.view;
      editor.view.dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", text);
      editor.view.pasteHTML(html, new ClipboardEvent("paste", { clipboardData: data }));
    });
    await h.persistence.flush();
  } finally {
    await hub.release(id);
  }
}
