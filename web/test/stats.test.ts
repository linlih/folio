import { describe, expect, it } from "vitest";
import { recentDays } from "../src/stats/StatsDialog";

const day = (date: string, cards: number, journal = false) => ({ date, cards, journal });

describe("the last 30 days", () => {
  const today = "2026-11-22";
  it("count cards and journal days, and the longest run of days with either", () => {
    const heat = [day("2026-10-23", 9), day("2026-10-24", 2), day("2026-11-01", 1), day("2026-11-02", 0, true), day("2026-11-03", 2, true), day("2026-11-05", 1), day("2026-11-22", 3)];
    // 10-23 is before the 30 days (from 10-24); a young library has no change.
    expect(recentDays(heat, today, "2026-10-23")).toEqual({ cards: 9, change: null, journal: 2, streak: 3 });
  });
  it("compare with the 30 days before once the library is that old", () => {
    const heat = [day("2026-09-24", 4), day("2026-10-20", 3), day("2026-11-10", 2)];
    expect(recentDays(heat, today, "2026-09-01").change).toBe(2 - 7);
  });
});
