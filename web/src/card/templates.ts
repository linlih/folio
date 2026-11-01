// Templates (design/outliner.md "模板"): any card can be one. Which cards
// are templates is kept in the workspace document, so it syncs; `/` lists
// them by name and pastes the chosen one's body where the cursor is.

import type { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { useEffect } from "react";
import { create } from "zustand";
import { docs } from "../app";
import { workspaceDoc } from "../docs/topics";
import { readTemplates, setTemplate } from "../docs/workspace";
import { embedContent } from "../editor/embed";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { CARDS_CHANGED } from "./actions";
import { cardName } from "./reveal";

interface Templates {
  /** Template cards as stored, trashed ones included. */
  ids: string[];
  /** Those not in the trash, with their names, in the order made. */
  cards: { id: string; title: string }[];
}

export const useTemplates = create<Templates>(() => ({ ids: [], cards: [] }));

/** Looks up the templates' names, leaving out cards in the trash. */
async function loadNames() {
  const { ids } = useTemplates.getState();
  if (ids.length === 0) return useTemplates.setState({ cards: [] });
  const live = new Map((await backend.listCards(100_000)).map((r) => [r.id, r.title]));
  useTemplates.setState({ cards: ids.filter((id) => live.has(id)).map((id) => ({ id, title: cardName(id, live.get(id) ?? "") })) });
}

/** Keeps the template list current (marked on another device, renamed,
 *  trashed). */
export function useTemplatesLoader() {
  useEffect(() => {
    let off = () => {};
    let gone = false;
    const names = () => void loadNames().catch(() => {});
    void workspaceDoc().then((h) => {
      if (gone) return;
      const read = () => {
        const ids = readTemplates(h.doc);
        if (ids.join() !== useTemplates.getState().ids.join()) {
          useTemplates.setState({ ids });
          names();
        }
      };
      read();
      off = h.doc.subscribe(read);
    });
    window.addEventListener(CARDS_CHANGED, names);
    return () => {
      gone = true;
      off();
      window.removeEventListener(CARDS_CHANGED, names);
    };
  }, []);
}

export const isTemplate = (ids: string[], cardId: string) => ids.includes(cardId);

export async function markTemplate(cardId: string, on: boolean) {
  const h = await workspaceDoc();
  setTemplate(h.doc, cardId, on, Date.now());
  useShell.getState().setNotice(i18n.t(on ? "templates.marked" : "templates.unmarked"));
}

/** Pastes the template's body at the cursor, as if copied from it: the
 *  outline's paste rules fit it in, and its blocks get new ids. */
export async function insertTemplate(editor: Editor, cardId: string) {
  const hub = docs();
  const h = await hub.open(cardId);
  try {
    const content = embedContent(editor.schema, h.doc, null);
    if (!content || !content.textBetween(0, content.size, "\n", " ").trim()) {
      useShell.getState().setNotice(i18n.t("templates.empty"));
      return;
    }
    const box = document.createElement("div");
    box.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(content));
    const data = new DataTransfer();
    data.setData("text/html", box.innerHTML);
    data.setData("text/plain", content.textBetween(0, content.size, "\n", " "));
    editor.view.focus();
    editor.view.pasteHTML(box.innerHTML, new ClipboardEvent("paste", { clipboardData: data }));
  } finally {
    void hub.release(cardId);
  }
}
