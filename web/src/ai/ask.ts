// "Ask AI" about text selected in a card (design/ai.md "对话窗口"): the
// text goes to the chat panel as a quote above the message, which the user
// adds to (or not) and sends.

import { create } from "zustand";
import { useShell } from "../shell/tabs";

export interface Quote {
  cardId: string;
  title: string;
  text: string;
}

export const useAskAi = create<{ quote: Quote | null }>(() => ({ quote: null }));

/** Opens the chat panel with `quote` waiting above the message. */
export function askAi(quote: Quote) {
  const text = quote.text.trim();
  if (!text) return;
  useAskAi.setState({ quote: { ...quote, text } });
  useShell.getState().setChatOpen(true);
}

export const clearQuote = () => useAskAi.setState({ quote: null });
