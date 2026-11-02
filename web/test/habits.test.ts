import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  archiveHabit,
  createHabit,
  dayState,
  deleteHabit,
  habitsForDay,
  habitStats,
  moveHabit,
  parseSchedule,
  readHabits,
  readJournalHabits,
  setCheck,
  setJournalHabits,
  setNote,
  startDate,
  updateHabit,
  weekday,
  type Habit,
  type HabitInput,
} from "../src/docs/habits";
import { addDays, localDate } from "../src/docs/ids";

const at = (date: string) => new Date(`${date}T09:00:00`).getTime();
const input = (patch: Partial<HabitInput> = {}): HabitInput => ({
  name: "Read",
  icon: "📖",
  color: "blue",
  schedule: { kind: "daily" },
  target: null,
  unit: "",
  limit: "atLeast",
  ...patch,
});
const start = (h: Habit) => startDate(h, localDate);

function habitWith(patch: Partial<HabitInput>, created: string, log: Record<string, number | "skip">): Habit {
  const doc = new LoroDoc();
  const id = createHabit(doc, input(patch), at(created));
  for (const [d, v] of Object.entries(log)) setCheck(doc, id, d, v);
  return readHabits(doc)[0];
}

describe("habits", () => {
  it("stores habits in the workspace document, edited, ordered, archived and deleted", () => {
    const doc = new LoroDoc();
    const a = createHabit(doc, input(), at("2026-11-01"));
    const b = createHabit(doc, input({ name: "Water", target: 8, unit: "glasses", schedule: { kind: "weekly", times: 3 } }), at("2026-11-01") + 1);
    expect(readHabits(doc).map((h) => h.name)).toEqual(["Read", "Water"]);
    const water = readHabits(doc)[1];
    expect(water).toMatchObject({ target: 8, unit: "glasses", limit: "atLeast", schedule: { kind: "weekly", times: 3 } });
    updateHabit(doc, b, { ...water, target: null });
    expect(readHabits(doc)[1].target).toBeNull();
    moveHabit(doc, readHabits(doc), b, a);
    expect(readHabits(doc).map((h) => h.id)).toEqual([b, a]);
    archiveHabit(doc, a, 5);
    expect(readHabits(doc).find((h) => h.id === a)!.archivedAt).toBe(5);
    deleteHabit(doc, b);
    expect(readHabits(doc).map((h) => h.id)).toEqual([a]);
  });

  it("keeps check-ins and notes by day; clearing removes them", () => {
    const doc = new LoroDoc();
    const id = createHabit(doc, input(), at("2026-11-01"));
    setCheck(doc, id, "2026-11-01", 1);
    setCheck(doc, id, "2026-11-02", "skip");
    setNote(doc, id, "2026-11-01", " 20 pages ");
    expect(readHabits(doc)[0].log).toEqual({ "2026-11-01": 1, "2026-11-02": "skip" });
    expect(readHabits(doc)[0].notes).toEqual({ "2026-11-01": "20 pages" });
    setCheck(doc, id, "2026-11-01", null);
    setNote(doc, id, "2026-11-01", "");
    expect(readHabits(doc)[0].log).toEqual({ "2026-11-02": "skip" });
    expect(readHabits(doc)[0].notes).toEqual({});
  });

  it("merges two devices checking different days, and both made at once", () => {
    const one = new LoroDoc();
    one.setPeerId(1n);
    const id = createHabit(one, input(), at("2026-11-01"));
    const two = new LoroDoc();
    two.setPeerId(2n);
    two.import(one.export({ mode: "snapshot" }));
    setCheck(one, id, "2026-11-01", 1);
    setCheck(two, id, "2026-11-02", 1);
    createHabit(two, input({ name: "Run" }), at("2026-11-02"));
    one.import(two.export({ mode: "snapshot" }));
    two.import(one.export({ mode: "snapshot" }));
    expect(readHabits(one)).toEqual(readHabits(two));
    expect(Object.keys(readHabits(one)[0].log).sort()).toEqual(["2026-11-01", "2026-11-02"]);
    expect(readHabits(one)).toHaveLength(2);
  });

  it("reads unknown or broken values as defaults", () => {
    expect(parseSchedule("days:1,3,9")).toEqual({ kind: "days", days: [1, 3] });
    expect(parseSchedule("days:1,2,3,4,5,6,7")).toEqual({ kind: "daily" });
    expect(parseSchedule("weekly:0")).toEqual({ kind: "daily" });
    expect(parseSchedule("monthly:2")).toEqual({ kind: "daily" });
    const doc = new LoroDoc();
    doc.getMap("habits").set("not-a-map", 3);
    expect(readHabits(doc)).toEqual([]);
  });

  it("shows journal habits unless turned off", () => {
    const doc = new LoroDoc();
    expect(readJournalHabits(doc)).toBe(true);
    setJournalHabits(doc, false);
    expect(readJournalHabits(doc)).toBe(false);
  });

  it("counts a daily streak; a skip neither breaks nor adds; today not done yet does not break it", () => {
    // 2026-11-02 is a Monday.
    expect(weekday("2026-11-02")).toBe(1);
    const h = habitWith({}, "2026-10-27", { "2026-10-27": 1, "2026-10-28": 1, "2026-10-30": 1, "2026-10-31": "skip", "2026-11-01": 1 });
    const s = habitStats(h, "2026-11-02", start(h));
    expect(s.streak).toBe(2);
    expect(s.best).toBe(2);
    expect(s.total).toBe(4);
    expect(dayState(h, "2026-10-29", "2026-11-02", start(h))).toBe("missed");
    expect(dayState(h, "2026-10-31", "2026-11-02", start(h))).toBe("skip");
    expect(dayState(h, "2026-11-02", "2026-11-02", start(h))).toBe("open");
    expect(dayState(h, "2026-10-26", "2026-11-02", start(h))).toBe("off");
  });

  it("only counts the chosen weekdays", () => {
    // Monday, Wednesday, Friday.
    const h = habitWith({ schedule: { kind: "days", days: [1, 3, 5] } }, "2026-10-26", { "2026-10-26": 1, "2026-10-28": 1, "2026-10-30": 1 });
    expect(habitStats(h, "2026-11-01", start(h)).streak).toBe(3);
    expect(dayState(h, "2026-10-27", "2026-11-01", start(h))).toBe("off");
    expect(habitsForDay([h], "2026-10-27", start)).toEqual([]);
    expect(habitsForDay([h], "2026-10-28", start)).toHaveLength(1);
    expect(habitStats(h, "2026-11-01", start(h)).week).toEqual({ done: 3, goal: 3 });
  });

  it("counts a times-a-week habit in weeks; this week counts once met", () => {
    const h = habitWith({ schedule: { kind: "weekly", times: 2 } }, "2026-10-19", {
      "2026-10-20": 1,
      "2026-10-22": 1,
      "2026-10-27": 1,
      "2026-10-29": 1,
      "2026-11-03": 1,
    });
    const s = habitStats(h, "2026-11-04", start(h));
    expect(s.streak).toBe(2);
    expect(s.week).toEqual({ done: 1, goal: 2 });
    // Done twice that week: its other days are not missed.
    expect(dayState(h, "2026-10-21", "2026-11-04", start(h))).toBe("open");
    // A week short of the goal breaks it.
    const short = habitWith({ schedule: { kind: "weekly", times: 2 } }, "2026-10-19", { "2026-10-20": 1, "2026-10-27": 1, "2026-10-28": 1 });
    expect(habitStats(short, "2026-11-04", start(short)).streak).toBe(1);
    expect(dayState(short, "2026-10-21", "2026-11-04", start(short))).toBe("missed");
  });

  it("measures amounts against a target, at least or at most", () => {
    const water = habitWith({ target: 8, unit: "glasses" }, "2026-11-01", { "2026-11-01": 8, "2026-11-02": 5 });
    expect(dayState(water, "2026-11-01", "2026-11-03", start(water))).toBe("done");
    expect(dayState(water, "2026-11-02", "2026-11-03", start(water))).toBe("partial");
    expect(habitStats(water, "2026-11-03", start(water)).streak).toBe(0);
    const coffee = habitWith({ target: 2, unit: "cups", limit: "atMost" }, "2026-11-01", { "2026-11-01": 1, "2026-11-02": 3 });
    expect(dayState(coffee, "2026-11-01", "2026-11-03", start(coffee))).toBe("done");
    expect(dayState(coffee, "2026-11-02", "2026-11-03", start(coffee))).toBe("partial");
  });

  it("grows strength with each check-in and lowers it gently on a miss", () => {
    const log: Record<string, number> = {};
    for (let i = 0; i < 30; i++) log[addDays("2026-10-01", i)] = 1;
    const h = habitWith({}, "2026-10-01", log);
    const strong = habitStats(h, "2026-10-31", start(h)).strength;
    expect(strong).toBeGreaterThan(0.75);
    const after = habitStats(h, "2026-11-02", start(h)).strength;
    expect(after).toBeLessThan(strong);
    expect(after).toBeGreaterThan(strong * 0.85);
    // Back-filled days before the habit was made count from the first.
    const filled = habitWith({}, "2026-11-02", { "2026-10-30": 1 });
    expect(start(filled)).toBe("2026-10-30");
  });
});
