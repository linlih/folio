// The assistant's proposed changes to one card, shown in the card itself
// as a diff (editor/aiReview.ts, ai/ReviewBar.tsx) as well as in the
// conversation: the same proposals (ai/chat.ts), so deciding in either
// place decides in both.

import { useMemo } from "react";
import { decide, useChatLive } from "./chat";
import { changeElement, IN_CARD, useReview, type ReviewView } from "./reviewState";
import type { Proposal } from "./writes";

export { changeElement, goToChange, IN_CARD, useReview, type ReviewView } from "./reviewState";

export interface CardChange {
  chatId: string;
  /** The tool call's id. */
  id: string;
  name: "update_block" | "append_to_card" | "rename_card";
  proposal: Proposal;
  /** update_block's block. */
  bid: string | null;
  /** The user's answer, once given (the change is made once every change
   *  of that reply is answered). */
  allowed?: boolean;
}

type Live = ReturnType<typeof useChatLive.getState>["live"];

/** Proposed changes to the card, in the order proposed. */
export function changesFor(live: Live, cardId: string): CardChange[] {
  const out: CardChange[] = [];
  for (const [chatId, turn] of Object.entries(live)) {
    for (const p of turn.pending ?? []) {
      if (!IN_CARD.has(p.part.name) || p.proposal.cardId !== cardId) continue;
      const bid = typeof p.part.input?.block_id === "string" ? p.part.input.block_id : null;
      out.push({ chatId, id: p.part.id, name: p.part.name as CardChange["name"], proposal: p.proposal, bid, allowed: p.allowed });
    }
  }
  return out;
}

export function useCardChanges(cardId: string): CardChange[] {
  const live = useChatLive((s) => s.live);
  return useMemo(() => changesFor(live, cardId), [live, cardId]);
}

export const setReviewView = (view: ReviewView) => useReview.setState({ view });

/** Answers one change; the next one waiting becomes current. */
export function decideChange(change: CardChange, allowed: boolean | undefined, all: CardChange[]) {
  if (allowed === undefined) {
    // Taken back: waiting again (only while the rest are still waiting).
    useChatLive.setState((s) => {
      const turn = s.live[change.chatId];
      if (!turn?.pending) return s;
      return { live: { ...s.live, [change.chatId]: { ...turn, pending: turn.pending.map((p) => (p.part.id === change.id ? { ...p, allowed: undefined } : p)) } } };
    });
    return;
  }
  const waiting = all.filter((c) => c.allowed === undefined && c.id !== change.id);
  const after = waiting.find((c) => all.indexOf(c) > all.indexOf(change)) ?? waiting[0];
  useReview.setState({ current: after?.id ?? null });
  decide(change.chatId, change.id, allowed);
  if (after) requestAnimationFrame(() => changeElement(after.id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

/** Answers every change to the card still waiting. */
export function decideAll(changes: CardChange[], allowed: boolean) {
  useReview.setState({ current: null });
  for (const c of changes) if (c.allowed === undefined) decide(c.chatId, c.id, allowed);
}
