// The task list's sections: by the date a task is due (its deadline, else
// the day it is scheduled for), counted from today.

import type { TaskRow } from "../bindings/commands";
import { addDays } from "../docs/ids";

export type TaskGroup = "overdue" | "today" | "week" | "later" | "undated";

export const GROUPS: TaskGroup[] = ["overdue", "today", "week", "later", "undated"];

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** The day a task is for: its deadline, else its scheduled day. */
export const dueDate = (t: TaskRow) => t.deadline ?? t.scheduled;

export function groupOf(t: TaskRow, today: string): TaskGroup {
  const date = dueDate(t);
  if (!date) return "undated";
  if (date < today) return "overdue";
  if (date === today) return "today";
  return date <= addDays(today, 7) ? "week" : "later";
}

/** Open tasks in their sections, the non-empty ones in order: soonest
 *  first, then by priority; otherwise as given (most recently changed card
 *  first, in document order). */
export function groupTasks(rows: TaskRow[], today: string): [TaskGroup, TaskRow[]][] {
  const by = new Map<TaskGroup, TaskRow[]>();
  for (const r of rows) {
    const g = groupOf(r, today);
    by.set(g, [...(by.get(g) ?? []), r]);
  }
  const rank = (t: TaskRow) => RANK[t.priority ?? ""] ?? 4;
  return GROUPS.filter((g) => by.has(g)).map((g) => [
    g,
    by.get(g)!.map((r, i) => ({ r, i })).sort((a, b) => (dueDate(a.r) ?? "").localeCompare(dueDate(b.r) ?? "") || rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r),
  ]);
}
