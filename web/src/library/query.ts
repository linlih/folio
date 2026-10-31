// Card library search, filter and sort (after Heptabase's card library; see
// design/ARCHITECTURE.md §8.4). Pure functions so they can be tested.

import type { CardRow } from "../bindings/commands";

export type SortKey = "updated" | "created" | "title";
/** Last edited within: today, the last 7 days, the last 30 days, or any time. */
export type EditedWithin = "all" | "today" | "week" | "month";

/** Card previews in a grid (Heptabase's default), or a compact list. */
export type LibraryView = "grid" | "list";

/** The library's home: topics with the cards in none below (§4.7), or all
 *  cards in one list. */
export type LibraryGrouping = "topics" | "all";

export interface LibraryQuery {
  text: string;
  sort: SortKey;
  edited: EditedWithin;
  view: LibraryView;
  grouping: LibraryGrouping;
}

export const DEFAULT_QUERY: LibraryQuery = { text: "", sort: "updated", edited: "all", view: "grid", grouping: "topics" };

/** A card nobody wrote anything in (Heptabase's "empty cards"). */
export const isEmptyCard = (c: CardRow) => !c.title.trim() && !c.preview.trim();

/** The library without what still waits in the inbox: a clipped link not
 *  dealt with is little more than a link, so it stays out of the cards
 *  written by hand until marked 已整理. One already put in a topic has been
 *  sorted, so it shows. `waiting`: how many were left out. */
export function withoutUnsorted(rows: CardRow[], inTopics: [string, string][], inbox: { id: string }[]) {
  const filed = new Set(inTopics.map(([id]) => id));
  const waiting = new Set(inbox.map((i) => i.id).filter((id) => !filed.has(id)));
  return { cards: rows.filter((c) => !waiting.has(c.id)), waiting: waiting.size };
}

function startOf(edited: EditedWithin, now: Date): number {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (edited === "today") return day;
  if (edited === "week") return day - 6 * 86_400_000;
  if (edited === "month") return day - 29 * 86_400_000;
  return -Infinity;
}

export function applyQuery(rows: CardRow[], q: LibraryQuery, locale: string, now = new Date()): CardRow[] {
  const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const since = startOf(q.edited, now);
  const out = rows.filter((c) => {
    if (c.updatedAt < since) return false;
    const hay = `${c.title}\n${c.preview}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byTitle = (a: CardRow, b: CardRow) => {
    // Untitled cards go last.
    if (!a.title !== !b.title) return a.title ? -1 : 1;
    return collator.compare(a.title, b.title);
  };
  const cmp: Record<SortKey, (a: CardRow, b: CardRow) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    title: byTitle,
  };
  return out.sort(cmp[q.sort]);
}
