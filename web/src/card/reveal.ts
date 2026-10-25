// Opening a card at a block (from a backlink, a search hit or a block
// reference): the card's tab scrolls the block into view and flashes it.

import type { EditorView } from "@tiptap/pm/view";
import { flashBlock } from "../editor/reveal";
import i18n from "../i18n";
import { isJournalId, journalDate } from "../docs/ids";
import { useShell } from "../shell/tabs";

/** Blocks waiting to be shown, by pane and card. */
const pending = new Map<string, string>();
const EVENT = "folio:reveal-block";
const slot = (pane: string, cardId: string) => `${pane}\n${cardId}`;

/** Opens the card (in the other pane with `side`) and, when given, scrolls
 *  to the block. */
export function openAt(cardId: string, title: string | null, bid?: string | null, side = false) {
  const shell = useShell.getState();
  shell.open({ kind: "card", cardId }, title, side);
  if (!bid) return;
  const pane = useShell.getState().focused;
  pending.set(slot(pane, cardId), bid);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { pane, cardId } }));
}

/** For a card view: takes the block waiting to be revealed, if any. */
export function takePending(pane: string, cardId: string): string | null {
  const key = slot(pane, cardId);
  const bid = pending.get(key) ?? null;
  pending.delete(key);
  return bid;
}

export function onReveal(pane: string, cardId: string, f: (bid: string) => void) {
  const listener = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d?.cardId !== cardId || d?.pane !== pane) return;
    const bid = takePending(pane, cardId);
    if (bid) f(bid);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Scrolls an editor's block into view and flashes it. The flash is a
 *  decoration (editor/reveal.ts), so it survives ProseMirror redrawing the
 *  block right after the tab opens. */
export function revealIn(view: EditorView, bid: string) {
  flashBlock(view, bid);
}

/** A card's name for lists: its title, a journal day's date, or "Untitled". */
export function cardName(cardId: string, title: string): string {
  if (title) return title;
  if (isJournalId(cardId)) {
    const [y, m, d] = journalDate(cardId).split("-").map(Number);
    return new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(new Date(y, m - 1, d));
  }
  return i18n.t("library.untitled");
}
