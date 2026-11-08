// How the assistant's proposed changes are shown in cards (ai/review.ts),
// apart from the conversation's state so either can read it.

import { create } from "zustand";

/** Write tools whose change is drawn in the card. */
export const IN_CARD = new Set(["update_block", "append_to_card", "rename_card"]);

export type ReviewView = "inline" | "lines" | "after";

/** How changes are shown, and the one being looked at. */
export const useReview = create<{ view: ReviewView; current: string | null }>(() => ({ view: "inline", current: null }));

/** The element showing a change, in any open card. */
export const changeElement = (id: string) => document.querySelector<HTMLElement>(`[data-ai-change="${CSS.escape(id)}"]`);

/** Makes the change the current one and scrolls it into view. */
export function goToChange(id: string) {
  useReview.setState({ current: id });
  requestAnimationFrame(() => changeElement(id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
}
