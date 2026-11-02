// Habits (打卡, design/habits.md): kept in the workspace document's
// `habits` map, which versions before it leave alone. Each habit is a map
// under its own new id, made by one device only, so its fields merge per
// field; its check-ins are a map in it from a date (`YYYY-MM-DD`) to what
// was done that day, so two devices checking different days both keep
// theirs and the same day settles on one answer.
//
// The model follows Loop Habit Tracker, Streaks and TickTick: a habit is
// done (yes/no) or measured (an amount against a target, at least or at
// most); it is due every day, on some days of the week, or a number of
// times a week; a day can be skipped (sick, travelling) without breaking
// the streak; and its strength is a moving average that a missed day
// lowers a little instead of resetting it.

import { LoroMap, type LoroDoc } from "loro-crdt";
import { addDays, uuidv7 } from "./ids";

const HABITS = "habits";
const PREFS = "prefs";
/** Whether each day's journal lists the habits due that day. */
const JOURNAL_HABITS = "journal_habits";
/** Origin of habit edits: not part of a card's undo history. */
export const HABIT_ORIGIN = "meta:habit";

export type Schedule = { kind: "daily" } | { kind: "days"; days: number[] } | { kind: "weekly"; times: number };

export interface Habit {
  id: string;
  name: string;
  /** An emoji or a short mark; "" for none. */
  icon: string;
  /** One of `HABIT_COLORS`. */
  color: string;
  schedule: Schedule;
  /** A measured habit's target per day ("8 glasses"); null for yes/no. */
  target: number | null;
  unit: string;
  /** For a measured habit: whether the target is a floor or a ceiling. */
  limit: "atLeast" | "atMost";
  createdAt: number;
  archivedAt: number | null;
  /** By date: the amount done (1 for a yes/no habit), or "skip". */
  log: Record<string, number | "skip">;
  /** A note for a day. */
  notes: Record<string, string>;
}

export const HABIT_COLORS = ["green", "blue", "orange", "purple", "red", "teal", "pink", "gray"];

const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");
const num = (m: LoroMap, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : null);

/** As stored: `daily`, `days:1,3,5` (1 Monday … 7 Sunday) or `weekly:3`. */
export function parseSchedule(s: string): Schedule {
  const [kind, arg = ""] = s.split(":");
  if (kind === "days") {
    const days = [...new Set(arg.split(",").map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (days.length > 0 && days.length < 7) return { kind: "days", days };
  }
  if (kind === "weekly") {
    const times = Math.round(Number(arg));
    if (times >= 1 && times <= 6) return { kind: "weekly", times };
  }
  return { kind: "daily" };
}

export function formatSchedule(s: Schedule): string {
  if (s.kind === "days") return `days:${s.days.join(",")}`;
  if (s.kind === "weekly") return `weekly:${s.times}`;
  return "daily";
}

/** Every habit not deleted (archived ones too), in their order. */
export function readHabits(doc: LoroDoc): Habit[] {
  const all = doc.getMap(HABITS);
  const out: (Habit & { order: number })[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap) || num(m, "deleted_at") !== null) continue;
    const log: Habit["log"] = {};
    const l = m.get("log");
    if (l instanceof LoroMap) {
      for (const [date, v] of Object.entries(l.toJSON() as Record<string, unknown>)) {
        if (v === "skip" || (typeof v === "number" && v > 0)) log[date] = v;
      }
    }
    const notes: Habit["notes"] = {};
    const n = m.get("notes");
    if (n instanceof LoroMap) {
      for (const [date, v] of Object.entries(n.toJSON() as Record<string, unknown>)) if (typeof v === "string" && v) notes[date] = v;
    }
    const target = num(m, "target");
    const createdAt = num(m, "created_at") ?? 0;
    out.push({
      id,
      name: str(m, "name"),
      icon: str(m, "icon"),
      color: HABIT_COLORS.includes(str(m, "color")) ? str(m, "color") : HABIT_COLORS[0],
      schedule: parseSchedule(str(m, "schedule")),
      target: target !== null && target > 0 ? target : null,
      unit: str(m, "unit"),
      limit: str(m, "limit") === "atMost" ? "atMost" : "atLeast",
      createdAt,
      archivedAt: num(m, "archived_at"),
      log,
      notes,
      order: num(m, "order") ?? createdAt,
    });
  }
  out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  return out.map(({ order: _, ...h }) => h);
}

export type HabitInput = Pick<Habit, "name" | "icon" | "color" | "schedule" | "target" | "unit" | "limit">;

function writeFields(m: LoroMap, h: HabitInput) {
  m.set("name", h.name.trim());
  m.set("icon", h.icon.trim());
  m.set("color", h.color);
  m.set("schedule", formatSchedule(h.schedule));
  if (h.target !== null && h.target > 0) {
    m.set("target", h.target);
    m.set("unit", h.unit.trim());
    m.set("limit", h.limit);
  } else {
    m.delete("target");
    m.delete("unit");
    m.delete("limit");
  }
}

export function createHabit(doc: LoroDoc, h: HabitInput, now = Date.now()): string {
  const id = uuidv7(now);
  const m = doc.getMap(HABITS).setContainer(id, new LoroMap());
  writeFields(m, h);
  m.set("created_at", now);
  m.set("order", now);
  m.setContainer("log", new LoroMap());
  m.setContainer("notes", new LoroMap());
  doc.commit({ origin: HABIT_ORIGIN });
  return id;
}

const habitMap = (doc: LoroDoc, id: string) => {
  const m = doc.getMap(HABITS).get(id);
  return m instanceof LoroMap ? m : null;
};

/** The habit's own map for days (made with it; from another device's
 *  older habit, made here). */
const dayMap = (m: LoroMap, key: "log" | "notes") => {
  const c = m.get(key);
  return c instanceof LoroMap ? c : m.setContainer(key, new LoroMap());
};

export function updateHabit(doc: LoroDoc, id: string, h: HabitInput) {
  const m = habitMap(doc, id);
  if (!m) return;
  writeFields(m, h);
  doc.commit({ origin: HABIT_ORIGIN });
}

export function archiveHabit(doc: LoroDoc, id: string, at: number | null) {
  const m = habitMap(doc, id);
  if (!m) return;
  if (at === null) m.delete("archived_at");
  else m.set("archived_at", at);
  doc.commit({ origin: HABIT_ORIGIN });
}

/** Deleted for good: its check-ins stay in the document's history only. */
export function deleteHabit(doc: LoroDoc, id: string, now = Date.now()) {
  const m = habitMap(doc, id);
  if (!m) return;
  m.set("deleted_at", now);
  doc.commit({ origin: HABIT_ORIGIN });
}

/** Moves a habit to just before `before` (or to the end with null), among `order`. */
export function moveHabit(doc: LoroDoc, ordered: Habit[], id: string, before: string | null) {
  const m = habitMap(doc, id);
  if (!m) return;
  const rest = ordered.filter((h) => h.id !== id);
  const orderOf = (h: Habit) => num(habitMap(doc, h.id)!, "order") ?? h.createdAt;
  const i = before === null ? rest.length : rest.findIndex((h) => h.id === before);
  if (i < 0) return;
  const prev = i > 0 ? orderOf(rest[i - 1]) : null;
  const next = i < rest.length ? orderOf(rest[i]) : null;
  const order = prev === null && next === null ? 0 : prev === null ? next! - 1000 : next === null ? prev + 1000 : (prev + next) / 2;
  m.set("order", order);
  doc.commit({ origin: HABIT_ORIGIN });
}

/** Sets what was done on `date`: an amount, "skip", or null to clear it. */
export function setCheck(doc: LoroDoc, id: string, date: string, value: number | "skip" | null) {
  const m = habitMap(doc, id);
  if (!m) return;
  const log = dayMap(m, "log");
  if (value === null || value === 0) log.delete(date);
  else log.set(date, value);
  doc.commit({ origin: HABIT_ORIGIN });
}

export function setNote(doc: LoroDoc, id: string, date: string, note: string) {
  const m = habitMap(doc, id);
  if (!m) return;
  const notes = dayMap(m, "notes");
  if (note.trim()) notes.set(date, note.trim());
  else notes.delete(date);
  doc.commit({ origin: HABIT_ORIGIN });
}

export function readJournalHabits(doc: LoroDoc): boolean {
  return doc.getMap(PREFS).get(JOURNAL_HABITS) !== false;
}

export function setJournalHabits(doc: LoroDoc, on: boolean) {
  doc.getMap(PREFS).set(JOURNAL_HABITS, on);
  doc.commit({ origin: HABIT_ORIGIN });
}

// ---- what the check-ins add up to ----

/** 1 Monday … 7 Sunday. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return ((new Date(y, m - 1, d).getDay() + 6) % 7) + 1;
}

/** The Monday of `date`'s week. */
export const weekStart = (date: string) => addDays(date, 1 - weekday(date));

export type DayState = "done" | "partial" | "skip" | "missed" | "open" | "off";

/** Whether `value` meets the habit's goal for a day. */
export function meets(h: Pick<Habit, "target" | "limit">, value: number | "skip" | undefined): boolean {
  if (value === "skip") return false;
  const v = value ?? 0;
  if (h.target === null) return v > 0;
  return h.limit === "atMost" ? v > 0 && v <= h.target : v >= h.target;
}

/** The day the habit starts counting: the day it was made, or the first
 *  day checked before that (filled in afterwards). */
export function startDate(h: Habit, localDate: (d: Date) => string): string {
  let start = localDate(new Date(h.createdAt));
  for (const d of Object.keys(h.log)) if (d < start) start = d;
  return start;
}

/** Whether the habit asks for something on `date` (a habit done some
 *  times a week may be done any day). */
export const isDue = (h: Habit, date: string) => h.schedule.kind !== "days" || h.schedule.days.includes(weekday(date));

/** A day as a calendar shows it. Days before the habit or after today are
 *  "off"; today not done yet is "open", not missed. */
export function dayState(h: Habit, date: string, today: string, start: string): DayState {
  const v = h.log[date];
  if (v === "skip") return "skip";
  if (meets(h, v)) return "done";
  if (typeof v === "number" && v > 0) return "partial";
  if (date > today || date < start) return "off";
  if (!isDue(h, date)) return "off";
  if (h.schedule.kind === "weekly") {
    // Done enough that week already: the other days are not missed.
    const done = weekDone(h, weekStart(date));
    if (done >= h.schedule.times || date === today) return "open";
    return weekStart(date) === weekStart(today) ? "open" : "missed";
  }
  return date === today ? "open" : "missed";
}

/** Days in the week starting `monday` that meet the goal. */
export function weekDone(h: Habit, monday: string): number {
  let n = 0;
  for (let i = 0; i < 7; i++) if (meets(h, h.log[addDays(monday, i)])) n++;
  return n;
}

export interface HabitStats {
  /** In days, or in weeks for a habit done some times a week. */
  streak: number;
  best: number;
  /** 0 … 1: recent check-ins weigh most (Loop's "habit strength"). */
  strength: number;
  /** Days that met the goal, ever. */
  total: number;
  /** This week: done, and how many are asked for. */
  week: { done: number; goal: number };
}

/** A due day's step in the streak and strength: met, skipped (left out)
 *  or missed. Days still open today are left out too. */
type Step = 1 | 0 | null;

function steps(h: Habit, today: string, start: string): { steps: Step[]; weekly: boolean } {
  const out: Step[] = [];
  if (start > today) return { steps: out, weekly: h.schedule.kind === "weekly" };
  if (h.schedule.kind === "weekly") {
    // One step a week: met when done `times` days; a week with a skip asks
    // one day fewer. This week counts only once met.
    for (let monday = weekStart(start); monday <= today; monday = addDays(monday, 7)) {
      let skips = 0;
      for (let i = 0; i < 7; i++) if (h.log[addDays(monday, i)] === "skip") skips++;
      const goal = Math.max(0, h.schedule.times - skips);
      const done = weekDone(h, monday);
      if (goal === 0) out.push(null);
      else if (done >= goal) out.push(1);
      else out.push(monday === weekStart(today) ? null : 0);
    }
    return { steps: out, weekly: true };
  }
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!isDue(h, d)) continue;
    const v = h.log[d];
    if (v === "skip") out.push(null);
    else if (meets(h, v)) out.push(1);
    else out.push(d === today ? null : 0);
  }
  return { steps: out, weekly: false };
}

/** Half-life of the strength, in due days (or weeks): a habit done daily
 *  for a month and then missed for two weeks is about half as strong. */
const HALF_LIFE = 13;
const WEEKLY_HALF_LIFE = 4;

export function habitStats(h: Habit, today: string, start: string): HabitStats {
  const { steps: s, weekly } = steps(h, today, start);
  const keep = 0.5 ** (1 / (weekly ? WEEKLY_HALF_LIFE : HALF_LIFE));
  let strength = 0;
  let run = 0;
  let best = 0;
  for (const step of s) {
    if (step === null) continue;
    strength = strength * keep + step * (1 - keep);
    run = step ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let total = 0;
  for (const v of Object.values(h.log)) if (meets(h, v)) total++;
  const monday = weekStart(today);
  const goal =
    h.schedule.kind === "weekly" ? h.schedule.times : h.schedule.kind === "days" ? h.schedule.days.length : 7;
  return { streak: run, best, strength, total, week: { done: weekDone(h, monday), goal } };
}

/** The habits shown on a journal day: not archived, already made, due. */
export function habitsForDay(habits: Habit[], date: string, start: (h: Habit) => string): Habit[] {
  return habits.filter((h) => h.archivedAt === null && start(h) <= date && isDue(h, date));
}
