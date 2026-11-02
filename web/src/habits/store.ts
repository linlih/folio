// The habits, kept current from the workspace document (docs/habits.ts).

import { useEffect } from "react";
import { create } from "zustand";
import * as model from "../docs/habits";
import { localDate } from "../docs/ids";
import { workspaceDoc } from "../docs/topics";

interface HabitsState {
  habits: model.Habit[];
  /** Whether each day's journal lists the habits due that day. */
  inJournal: boolean;
  loaded: boolean;
}

export const useHabitsStore = create<HabitsState>(() => ({ habits: [], inJournal: true, loaded: false }));

let watching = false;

/** Starts following the workspace document's habits (once). */
function watch() {
  if (watching) return;
  watching = true;
  void workspaceDoc().then((h) => {
    const read = () => useHabitsStore.setState({ habits: model.readHabits(h.doc), inJournal: model.readJournalHabits(h.doc), loaded: true });
    read();
    h.doc.subscribe(read);
  });
}

/** The habits, read from the workspace document and kept current. */
export function useHabits(): HabitsState {
  useEffect(watch, []);
  return useHabitsStore();
}

export const habitStart = (h: model.Habit) => model.startDate(h, localDate);

const edit = async (f: (doc: import("loro-crdt").LoroDoc) => void) => f((await workspaceDoc()).doc);

export const createHabit = (h: model.HabitInput) => edit((d) => void model.createHabit(d, h));
export const updateHabit = (id: string, h: model.HabitInput) => edit((d) => model.updateHabit(d, id, h));
export const archiveHabit = (id: string, at: number | null) => edit((d) => model.archiveHabit(d, id, at));
export const deleteHabit = (id: string) => edit((d) => model.deleteHabit(d, id));
export const moveHabit = (id: string, before: string | null) => edit((d) => model.moveHabit(d, useHabitsStore.getState().habits, id, before));
export const setCheck = (id: string, date: string, value: number | "skip" | null) => edit((d) => model.setCheck(d, id, date, value));
export const setNote = (id: string, date: string, note: string) => edit((d) => model.setNote(d, id, date, note));
export const setInJournal = (on: boolean) => edit((d) => model.setJournalHabits(d, on));

/** One tap on a day: a yes/no habit is done or not; a measured habit
 *  asks for the amount (`ask`), so that is not done here. */
export function toggle(h: model.Habit, date: string) {
  const v = h.log[date];
  return setCheck(h.id, date, v === undefined ? 1 : null);
}
