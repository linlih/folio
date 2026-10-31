// Changing a task from outside its editor (the task list, the calendar,
// today's journal): written to its card document, so open editors follow;
// it does not join their undo.

import { docs } from "../app";
import type { TaskRow } from "../bindings/commands";
import { setTaskAttrs, TASK_ORIGIN } from "../docs/card";

export const CLOSED = new Set(["done", "canceled"]);

/** Sets attributes of the task; false when it is no longer there. */
async function editTask(row: TaskRow, values: Record<string, string | boolean | null>): Promise<boolean> {
  const hub = docs();
  const h = await hub.open(row.cardId);
  try {
    if (!setTaskAttrs(h.doc, row.bid, values)) return false;
    h.doc.commit({ origin: TASK_ORIGIN });
    await h.persistence.flush();
    return true;
  } finally {
    await hub.release(row.cardId);
  }
}

/** Finishes an open task, or opens a finished one again; the row as it is
 *  now, or null when the task is gone. */
export async function toggleTask(row: TaskRow): Promise<TaskRow | null> {
  const done = !CLOSED.has(row.status);
  if (!(await editTask(row, { checked: done, status: null }))) return null;
  return { ...row, status: done ? "done" : "todo" };
}

/** Moves a task to `date`: its deadline when it has one, else the day it is
 *  scheduled for. */
export async function moveTask(row: TaskRow, date: string): Promise<TaskRow | null> {
  const key = row.deadline ? "deadline" : "scheduled";
  if (!(await editTask(row, { [key]: date }))) return null;
  return { ...row, [key]: date };
}
