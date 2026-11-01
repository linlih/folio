// Pinyin search (design/ARCHITECTURE.md "全文搜索"): a name in Chinese is
// found by typing its pinyin, in full or by first letters, without switching
// the input method: "xuexi", "xxbj" and "xuexb" all find 学习笔记. Names only
// (card titles, tags, topics, commands): body text stays with the full-text
// index. The dictionary (pinyin-pro, about 300 KB) loads after startup, in a
// file of its own; until then names match as written.

import { useEffect, useState } from "react";
import type { CardRow, SearchHit } from "../bindings/commands";
import { backend } from "../platform";

type Match = typeof import("pinyin-pro").match;

let match: Match | null = null;
let loading: Promise<void> | null = null;

/** Loads the dictionary once; resolves (without it) if it cannot load. */
export function loadPinyin(): Promise<void> {
  loading ??= import("pinyin-pro").then(
    (m) => void (match = m.match),
    () => {},
  );
  return loading;
}

/** Re-renders once the dictionary is there, for matching done while rendering. */
export function usePinyin(): boolean {
  const [ready, setReady] = useState(match !== null);
  useEffect(() => {
    if (!ready) void loadPinyin().then(() => setReady(match !== null));
  }, [ready]);
  return ready;
}

const HAN = /\p{Script=Han}/u;

/** How `text` has `word`: "text" as written (ignoring case), "pinyin" as
 *  the pinyin of characters in a row, for a word of Latin letters. */
export function wordMatch(text: string, word: string): "text" | "pinyin" | null {
  const w = word.toLowerCase();
  if (text.toLowerCase().includes(w)) return "text";
  const letters = w.replace(/'/g, "");
  if (!match || !/^[a-z]+$/.test(letters) || !HAN.test(text)) return null;
  return match(text, letters, { continuous: true, v: true }) ? "pinyin" : null;
}

/** How `text` has every word of `query`: "pinyin" when any word needed
 *  pinyin. An empty query is in everything. */
export function queryMatch(text: string, query: string): "text" | "pinyin" | null {
  let how: "text" | "pinyin" = "text";
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const m = wordMatch(text, word);
    if (!m) return null;
    if (m === "pinyin") how = m;
  }
  return how;
}

export const matches = (text: string, query: string) => queryMatch(text, query) !== null;

/** `items` that have `query`, those matching as written first. */
export function filterNames<T>(items: T[], query: string, name: (item: T) => string): T[] {
  const text: T[] = [];
  const pinyin: T[] = [];
  for (const item of items) {
    const m = queryMatch(name(item), query);
    if (m === "text") text.push(item);
    else if (m === "pinyin") pinyin.push(item);
  }
  return [...text, ...pinyin];
}

/** The index's search hits with the cards whose title has `query` only by
 *  pinyin added after its title hits (the index matches text as written). */
export function withPinyinTitles(hits: SearchHit[], cards: CardRow[], query: string, limit = 8): SearchHit[] {
  const titled = new Set(hits.filter((h) => !h.bid).map((h) => h.cardId));
  const extra: SearchHit[] = [];
  for (const c of cards) {
    if (extra.length >= limit) break;
    if (!titled.has(c.id) && c.title && queryMatch(c.title, query) === "pinyin") extra.push({ cardId: c.id, cardTitle: c.title, cardKind: c.kind, bid: null, text: c.title });
  }
  if (!extra.length) return hits;
  const at = hits.findIndex((h) => h.bid);
  return at < 0 ? [...hits, ...extra] : [...hits.slice(0, at), ...extra, ...hits.slice(at)];
}

/** Search, with titles found by pinyin. */
export async function searchCards(query: string, limit = 40): Promise<SearchHit[]> {
  const [hits, cards] = await Promise.all([backend.search(query, limit), backend.listCards(100_000), loadPinyin()]);
  return withPinyinTitles(hits, cards, query);
}
