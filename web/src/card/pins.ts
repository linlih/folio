// Cards pinned to the sidebar. The pin is a field of the card (it syncs);
// this keeps the list the sidebar and card menus show.

import { useEffect } from "react";
import { create } from "zustand";
import { docs } from "../app";
import type { CardRow } from "../bindings/commands";
import { DOC_SAVED } from "../docs/persistence";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { CARDS_CHANGED, cardsChanged } from "./actions";

interface Pins {
  cards: CardRow[];
  load(): Promise<void>;
}

export const usePins = create<Pins>((set) => ({
  cards: [],
  load: async () => set({ cards: await backend.pinnedCards() }),
}));

export const isPinned = (cards: CardRow[], id: string) => cards.some((c) => c.id === id);

export async function setPin(cardId: string, pinned: boolean) {
  try {
    // The host edits the card; an open replica takes the change in.
    await backend.pinCard(cardId, pinned);
    await docs().refresh([cardId]);
  } catch (e) {
    useShell.getState().setNotice(i18n.t("error.generic", { message: String(e) }));
  }
  cardsChanged();
}

/** Keeps the pinned list current (cards trashed or renamed elsewhere). */
export function usePinsLoader() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void usePins.getState().load().catch(() => {});
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    load();
    window.addEventListener(CARDS_CHANGED, load);
    window.addEventListener(DOC_SAVED, soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARDS_CHANGED, load);
      window.removeEventListener(DOC_SAVED, soon);
    };
  }, []);
}
