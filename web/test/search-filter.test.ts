import { describe, expect, it } from "vitest";
import { filtering, toFilter } from "../src/search/SearchPalette";
import { memoryBackend } from "../src/platform/memory";

describe("search filters", () => {
  const now = new Date(2026, 10, 8, 15, 0);
  it("turn the bar's choices into the host's filter", () => {
    expect(toFilter("all", "any", "", false, now)).toEqual({ scope: "all", tag: null, since: null, newestFirst: false });
    expect(toFilter("journal", "week", "读书", true, now)).toEqual({ scope: "journal", tag: "读书", since: now.getTime() - 7 * 86_400_000, newestFirst: true });
    expect(toFilter("all", "year", "", false, now).since).toBe(new Date(2026, 0, 1).getTime());
  });

  it("count sorting alone as no narrowing", () => {
    expect(filtering(toFilter("all", "any", "", true, now))).toBe(false);
    expect(filtering(toFilter("cards", "any", "", false, now))).toBe(true);
    expect(filtering(toFilter("all", "month", "", false, now))).toBe(true);
    expect(filtering(toFilter("all", "any", "x", false, now))).toBe(true);
  });

  it("narrow the web mode's search like the host's", async () => {
    let t = 1000;
    const b = memoryBackend(() => t);
    const old = await b.createCard("plan old");
    t = 5000;
    const fresh = await b.createCard("plan new");
    const ids = async (q: string, f: Parameters<typeof b.search>[2]) => (await b.search(q, 20, f)).map((h) => h.cardId);
    expect(await ids("plan", {})).toEqual([old, fresh]);
    expect(await ids("plan", { newestFirst: true })).toEqual([fresh, old]);
    expect(await ids("plan", { since: 2000 })).toEqual([fresh]);
    expect(await ids("plan", { scope: "journal" })).toEqual([]);
    expect(await ids("", { scope: "cards" })).toEqual([fresh, old]);
    expect(await ids("", {})).toEqual([]);
  });
});
