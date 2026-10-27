import { describe, expect, it } from "vitest";
import { seen, STALE_DAYS } from "./devices";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("seen", () => {
  it("says just now, today, or calendar days ago", () => {
    const now = at(2026, 10, 28, 9, 30);
    expect(seen(now - 30_000, now)).toEqual({ kind: "now" });
    expect(seen(at(2026, 10, 28, 0, 10), now)).toEqual({ kind: "today" });
    // Late yesterday is a day ago, though under 24 hours.
    expect(seen(at(2026, 10, 27, 23, 50), now)).toEqual({ kind: "days", days: 1, stale: false });
    expect(seen(at(2026, 10, 18), now)).toEqual({ kind: "days", days: 10, stale: false });
  });

  it("marks a device stale after the limit", () => {
    const now = at(2026, 10, 28);
    const day = 24 * 3600_000;
    expect(seen(now - STALE_DAYS * day + 60_000, now)).toMatchObject({ kind: "days", stale: false });
    expect(seen(now - (STALE_DAYS + 1) * day, now)).toMatchObject({ kind: "days", stale: true });
  });

  it("treats a clock ahead of ours as now", () => {
    const now = at(2026, 10, 28);
    expect(seen(now + 60_000, now)).toEqual({ kind: "now" });
  });
});
