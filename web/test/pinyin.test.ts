import { beforeAll, describe, expect, it } from "vitest";
import type { CardRow, SearchHit } from "../src/bindings/commands";
import { applyQuery, DEFAULT_QUERY } from "../src/library/query";
import { filterNames, loadPinyin, queryMatch, withPinyinTitles } from "../src/search/pinyin";

beforeAll(() => loadPinyin());

const card = (id: string, title: string, preview = ""): CardRow => ({ id, kind: "card", title, preview, createdAt: 0, updatedAt: 0, fromInbox: null });

describe("pinyin search", () => {
  it("finds Chinese names by full pinyin, first letters, or both", () => {
    for (const q of ["xuexi", "xxbj", "xuexb", "XueXi", "biji", "bj", "xue xi"]) expect(queryMatch("学习笔记", q), q).toBe("pinyin");
    // Characters in a row, in order.
    expect(queryMatch("学习笔记", "xxj")).toBeNull();
    expect(queryMatch("学习笔记", "bjxx")).toBeNull();
    // Not inside a syllable.
    expect(queryMatch("学习", "ue")).toBeNull();
    // Either reading of a character with two; ü typed as v.
    expect(queryMatch("银行流水", "yinhang")).toBe("pinyin");
    expect(queryMatch("重要会议", "zhongyao")).toBe("pinyin");
    expect(queryMatch("绿色", "lvse")).toBe("pinyin");
    // Mixed with Latin letters.
    expect(queryMatch("Rust学习", "rustxx")).toBe("pinyin");
  });

  it("matches as written first, and leaves names without Chinese alone", () => {
    expect(queryMatch("Notes 读书", "notes")).toBe("text");
    expect(queryMatch("anything", "")).toBe("text");
    expect(queryMatch("Shanghai trip", "sht")).toBeNull();
    expect(filterNames(["学习计划", "xx plan", "数学"], "xx", (s) => s)).toEqual(["xx plan", "学习计划"]);
  });

  it("adds pinyin title matches after the index's title hits", () => {
    const hits: SearchHit[] = [
      { cardId: "a", cardTitle: "xx 一览", cardKind: "card", bid: null, text: "xx 一览" },
      { cardId: "b", cardTitle: "别的", cardKind: "card", bid: "b1", text: "xx in a block" },
    ];
    const cards = [card("a", "xx 一览"), card("c", "学习笔记"), card("d", "无关")];
    expect(withPinyinTitles(hits, cards, "xx").map((h) => h.cardId)).toEqual(["a", "c", "b"]);
    expect(withPinyinTitles([], cards, "zzz")).toEqual([]);
  });

  it("finds library cards by title pinyin, not by the preview's", () => {
    const rows = [card("1", "学习笔记"), card("2", "Untitled", "学习的时候")];
    expect(applyQuery(rows, { ...DEFAULT_QUERY, text: "xuexi" }, "zh").map((c) => c.id)).toEqual(["1"]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, text: "学习" }, "zh").map((c) => c.id).sort()).toEqual(["1", "2"]);
  });
});
