import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/bindings/commands";
import { dueBy } from "../src/journal/TodayTasks";
import { addMonths, byDay, firstDayOfWeek, monthOf, weekOf } from "../src/tasks/calendar";

const task = (over: Partial<TaskRow>): TaskRow => ({ cardId: "c", cardTitle: "", cardKind: "note", bid: over.text ?? "", text: "", status: "todo", priority: null, deadline: null, scheduled: null, updatedAt: 0, ...over });

describe("the task calendar's days", () => {
  it("are weeks from the locale's first day", () => {
    expect(firstDayOfWeek("zh-CN")).toBe(1);
    expect(firstDayOfWeek("en-US")).toBe(7);
    // 2026-11-01 is a Sunday.
    expect(weekOf("2026-11-04", 1)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(weekOf("2026-11-04", 7)[0]).toBe("2026-11-01");
    expect(weekOf("2026-11-01", 1)[0]).toBe("2026-10-26");
  });

  it("cover the month in whole weeks", () => {
    const nov = monthOf("2026-11-15", 1);
    expect(nov.length % 7).toBe(0);
    expect(nov[0]).toBe("2026-10-26");
    expect(nov.at(-1)).toBe("2026-12-06");
    expect(nov).toContain("2026-11-30");
    // February 2026 starts on a Sunday: exactly four weeks.
    expect(monthOf("2026-02-10", 7).length).toBe(28);
    expect(monthOf("2026-02-10", 1).length).toBe(35);
  });

  it("move by months within the month's length", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-15", -3)).toBe("2025-12-15");
  });

  it("hold tasks on the day they are due", () => {
    const m = byDay([task({ text: "a", deadline: "2026-11-02" }), task({ text: "b", scheduled: "2026-11-02" }), task({ text: "c" })]);
    expect([...m]).toEqual([["2026-11-02", [expect.objectContaining({ text: "a" }), expect.objectContaining({ text: "b" })]]]);
  });
});

describe("today's journal", () => {
  it("lists open tasks due by today from elsewhere, the oldest first", () => {
    const today = "2026-11-01";
    const rows = [
      task({ text: "later", deadline: "2026-11-05" }),
      task({ text: "today", scheduled: today }),
      task({ text: "late", deadline: "2026-10-20" }),
      task({ text: "done", deadline: "2026-10-20", status: "done" }),
      task({ text: "undated" }),
      task({ text: "written today", scheduled: today, cardId: "journal:2026-11-01" }),
    ];
    expect(dueBy(rows, today).map((r) => r.text)).toEqual(["late", "today"]);
  });
});
