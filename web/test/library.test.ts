import { describe, expect, it } from "vitest";
import type { CardRow } from "../src/bindings/commands";
import { applyQuery, DEFAULT_QUERY, isEmptyCard, withoutUnsorted } from "../src/library/query";

const DAY = 86_400_000;
const now = new Date(2026, 9, 24, 12);
const row = (id: string, title: string, preview: string, updatedDaysAgo: number, createdDaysAgo: number): CardRow => ({
  id,
  kind: "note",
  title,
  preview,
  updatedAt: now.getTime() - updatedDaysAgo * DAY,
  createdAt: now.getTime() - createdDaysAgo * DAY,
});
const CARDS = [
  row("a", "卡片要独立可读", "先写结论，再写理由", 0, 10),
  row("b", "Zettelkasten", "atomic notes", 3, 2),
  row("c", "", "", 20, 20),
  row("d", "Card 10", "", 40, 1),
  row("e", "Card 9", "numbers", 1, 40),
];
const ids = (rows: CardRow[]) => rows.map((r) => r.id);

describe("card library query", () => {
  it("sorts by last edited by default", () => {
    expect(ids(applyQuery(CARDS, DEFAULT_QUERY, "zh", now))).toEqual(["a", "e", "b", "c", "d"]);
  });

  it("sorts by created, and by title with numbers in order and untitled last", () => {
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, sort: "created" }, "en", now))).toEqual(["d", "b", "a", "c", "e"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, sort: "title" }, "en", now)).slice(0, 2)).toEqual(["e", "d"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, sort: "title" }, "en", now)).at(-1)).toBe("c");
  });

  it("searches titles and text, every word must match", () => {
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, text: "结论" }, "zh", now))).toEqual(["a"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, text: "atomic zettel" }, "en", now))).toEqual(["b"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, text: "missing" }, "en", now))).toEqual([]);
  });

  it("filters by last edit", () => {
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, edited: "today" }, "en", now))).toEqual(["a"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, edited: "week" }, "en", now))).toEqual(["a", "e", "b"]);
    expect(ids(applyQuery(CARDS, { ...DEFAULT_QUERY, edited: "month" }, "en", now))).toEqual(["a", "e", "b", "c"]);
  });

  it("finds empty cards", () => {
    expect(CARDS.filter(isEmptyCard).map((c) => c.id)).toEqual(["c"]);
  });

  it("leaves out links still in the inbox, unless put in a topic", () => {
    const rows = [row("note", "手写的卡片", "", 1, 1), row("clip", "一篇文章", "", 0, 0), row("filed", "放进主题的文章", "", 0, 0)];
    const { cards, waiting } = withoutUnsorted(rows, [["filed", "topic-1"]], [{ id: "clip" }, { id: "filed" }]);
    expect(cards.map((c) => c.id)).toEqual(["note", "filed"]);
    expect(waiting).toBe(1);
  });
});
