// A journal day is shown in the journal, not as a card of its own: what
// opens one (a task, a backlink, a search hit, a block reference) goes to
// the journal and asks it to bring that day, and the block, into view
// (journal/JournalView.tsx).

import { create } from "zustand";

/** `write`: the day gets an editor, to write in it (a day picked in the
 *  calendar). */
export type JournalJump = { date: string; bid: string | null; seq: number; write?: boolean };

/** The latest day asked for; `seq` tells a repeat of the same day apart. */
export const useJournalJump = create<{ jump: JournalJump | null }>(() => ({ jump: null }));

export function jumpToDay(date: string, bid: string | null = null, write = false) {
  const seq = (useJournalJump.getState().jump?.seq ?? 0) + 1;
  useJournalJump.setState({ jump: { date, bid, seq, write } });
}

/** Marks a jump as done, unless a newer one came meanwhile. */
export function jumpDone(seq: number) {
  if (useJournalJump.getState().jump?.seq === seq) useJournalJump.setState({ jump: null });
}
