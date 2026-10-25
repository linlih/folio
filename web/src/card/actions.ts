import { appUndo, docs } from "../app";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";

export const undoKey = () => (navigator.platform.toLowerCase().includes("mac") ? "⌘Z" : "Ctrl+Z");

/** Moves a card to the trash as one undoable step (§0.1: nothing is lost
 *  without a way back). Pending edits are saved first. */
export async function moveToTrash(cardId: string, title: string) {
  const shell = useShell.getState();
  try {
    await docs().flushAll();
    await backend.trashCard(cardId);
  } catch (e) {
    shell.setNotice(i18n.t("error.generic", { message: String(e) }));
    return;
  }
  shell.forgetCard(cardId);
  const shown = title || i18n.t("library.untitled");
  appUndo.push({
    label: "trash",
    undo: async () => {
      await backend.restoreCard(cardId);
      useShell.getState().setNotice(i18n.t("trash.restored", { title: shown }));
      cardsChanged();
    },
    redo: async () => {
      await backend.trashCard(cardId);
      useShell.getState().forgetCard(cardId);
      cardsChanged();
    },
  });
  shell.setNotice(i18n.t("trash.moved", { title: shown, undo: undoKey() }));
  cardsChanged();
}

/** Lists of cards listen for this to reload. */
export const CARDS_CHANGED = "folio:cards-changed";
export const cardsChanged = () => window.dispatchEvent(new Event(CARDS_CHANGED));

/** Moves several cards to the trash as one undoable step (library
 *  multi-select, "clean up empty cards"). */
export async function moveManyToTrash(cards: { id: string; title: string }[]) {
  if (cards.length === 0) return;
  const shell = useShell.getState();
  try {
    await docs().flushAll();
    for (const c of cards) await backend.trashCard(c.id);
  } catch (e) {
    shell.setNotice(i18n.t("error.generic", { message: String(e) }));
    cardsChanged();
    return;
  }
  for (const c of cards) shell.forgetCard(c.id);
  appUndo.push({
    label: "trash",
    undo: async () => {
      for (const c of cards) await backend.restoreCard(c.id);
      useShell.getState().setNotice(i18n.t("trash.restoredMany", { count: cards.length }));
      cardsChanged();
    },
    redo: async () => {
      for (const c of cards) {
        await backend.trashCard(c.id);
        useShell.getState().forgetCard(c.id);
      }
      cardsChanged();
    },
  });
  shell.setNotice(i18n.t("trash.movedMany", { count: cards.length, undo: undoKey() }));
  cardsChanged();
}
