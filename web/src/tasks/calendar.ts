// Days for the task calendar: a month's weeks or one week, starting on the
// locale's first day of the week.

import type { TaskRow } from "../bindings/commands";
import { addDays } from "../docs/ids";
import { dueDate } from "./group";

/** 1 = Monday … 7 = Sunday, as the locale has it (Monday when it can't say). */
export function firstDayOfWeek(lang: string): number {
  try {
    const loc = new Intl.Locale(lang) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay;
    // No week info (older WebKit): regions that start on Sunday.
    return /^(en-(US|CA)|ja|ko|zh-TW|he|pt-BR)\b/.test(lang) || lang === "en" ? 7 : 1;
  } catch {
    return 1;
  }
}

/** Day of the week of `date`, 1 = Monday … 7 = Sunday. */
const weekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() || 7;
};

/** The seven days of the week `date` is in. */
export function weekOf(date: string, first: number): string[] {
  const start = addDays(date, -((weekday(date) - first + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The weeks that show the month `date` is in (4 to 6 of them). */
export function monthOf(date: string, first: number): string[] {
  const month = date.slice(0, 7);
  const out: string[] = [];
  for (let day = weekOf(`${month}-01`, first)[0]; day.slice(0, 7) <= month || out.length % 7; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The same day a month later (or earlier), kept within the month. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  const x = new Date(y, m - 1 + n, Math.min(d, last));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Tasks by the day they are due, in the order given. */
export function byDay(rows: TaskRow[]): Map<string, TaskRow[]> {
  const out = new Map<string, TaskRow[]>();
  for (const r of rows) {
    const d = dueDate(r);
    if (d) out.set(d, [...(out.get(d) ?? []), r]);
  }
  return out;
}
