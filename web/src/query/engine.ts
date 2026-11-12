// Running a resolved query over cards in memory (the web build and tests):
// the same rules as folio-store's `query`, which runs them as SQL.

import type { Backlink, CardRow, ChildBlock, QueryRows, ResolvedCond, ResolvedQuery, TaskRow } from "../bindings/commands";
import type { IndexBlock, IndexExtract } from "../docs/index";
import { localDate } from "../docs/ids";

export interface EngineCard {
  id: string;
  kind: string;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number;
  inboxAt: number | null;
  fromInbox: number | null;
  topics: string[];
  index: IndexExtract;
}

type Row = { card: EngineCard; block: IndexBlock | null; order: number };

const isJournal = (c: EngineCard) => c.kind === "journal";
/** A journal day's date, else the day it was last edited. */
const dayOf = (c: EngineCard) => (isJournal(c) ? c.id.slice(8) : localDate(new Date(c.updatedAt)));
const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Every word, any case. */
const hasWords = (text: string, words: string) =>
  words
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.toLowerCase().includes(w));

/** Blocks of `card` that have one of `tags`: on themselves or on a block
 *  above them (the tag alone on a line, the note under it). */
function taggedBlocks(card: EngineCard, tags: string[]): Set<string> {
  const direct = new Set(card.index.tags.filter(([, name]) => tags.includes(name.trim().toLowerCase())).map(([bid]) => bid));
  const out = new Set<string>();
  for (const b of card.index.blocks) if (direct.has(b.bid) || (b.parent !== null && out.has(b.parent))) out.add(b.bid);
  return out;
}

function test(c: ResolvedCond, row: Row, q: ResolvedQuery): boolean {
  const r = check(c, row, q);
  return c.not ? !r : r;
}

function check(c: ResolvedCond, { card, block }: Row, q: ResolvedQuery): boolean {
  // A block-level condition on a card: some block of it meets it.
  const blocks = block ? [block] : card.index.blocks;
  const v = c.v ?? [];
  switch (c.k) {
    case "group": {
      const parts = (c.where ?? []).map((x) => test(x, { card, block, order: 0 }, q));
      return c.match === "any" ? parts.some(Boolean) : parts.every(Boolean);
    }
    case "tag": {
      const cardHas = card.index.tags.some(([, name]) => v.includes(name.trim().toLowerCase()));
      if (!block) return cardHas;
      return (!isJournal(card) && cardHas) || taggedBlocks(card, v).has(block.bid);
    }
    case "task":
      return blocks.some((b) => !!b.task && v.includes(b.task.status));
    case "priority":
      return blocks.some((b) => !!b.task && v.includes(b.task.priority ?? "none"));
    case "date": {
      if (c.field === "day") {
        if (!isJournal(card)) return !!c.none;
        const d = card.id.slice(8);
        return !c.none && (!c.from || d >= c.from) && (!c.to || d <= c.to);
      }
      return blocks.some((b) => {
        if (!b.task) return false;
        const d = c.field === "due" ? (b.task.deadline ?? b.task.scheduled) : c.field === "deadline" ? b.task.deadline : b.task.scheduled;
        if (c.none) return !d;
        return !!d && (!c.from || d >= c.from) && (!c.to || d <= c.to);
      });
    }
    case "time": {
      const t = c.field === "created" ? card.createdAt : card.updatedAt;
      return t !== null && (c.fromMs == null || t >= c.fromMs) && (c.toMs == null || t < c.toMs);
    }
    case "text":
      return block ? hasWords(block.text, v[0] ?? "") : hasWords(`${card.title}\n${card.index.blocks.map((b) => b.text).join("\n")}`, v[0] ?? "");
    case "in":
      switch (v[0]) {
        case "cards":
          return !isJournal(card);
        case "journal":
          return isJournal(card);
        case "inbox":
          return card.inboxAt !== null;
        case "card":
          return card.id === v[1];
        case "topic":
          return card.topics.includes(v[1]);
      }
      return false;
    case "links":
      return blocks.some((b) => (c.block ? card.index.refs.some(([from, to]) => from === b.bid && to === c.block) : card.index.links.some(([from, to]) => from === b.bid && to === c.card)));
  }
  return false;
}

/** The value a row sorts by; null sorts last either way. */
function key(by: string, { card, block }: Row): string | number | null {
  switch (by) {
    case "due":
      return block?.task ? (block.task.deadline ?? block.task.scheduled) : null;
    case "priority":
      return block?.task ? (RANK[block.task.priority ?? ""] ?? 4) : null;
    case "created":
      return card.createdAt;
    case "updated":
      return card.updatedAt;
    case "day":
      return dayOf(card);
    case "title":
      return card.title.toLowerCase();
  }
  return null;
}

/** Runs `q` over `cards` (not in the trash). */
export function runQuery(cards: EngineCard[], q: ResolvedQuery): QueryRows {
  const rows: Row[] = [];
  let order = 0;
  // Ties: the card edited last first, then document order.
  const byEdit = [...cards].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  for (const card of byEdit) {
    if (q.exclude.includes(card.id)) continue;
    if (!q.includeInbox && card.inboxAt !== null) continue;
    if (q.show === "cards") {
      if (!isJournal(card)) rows.push({ card, block: null, order: order++ });
      continue;
    }
    for (const block of card.index.blocks) if (q.show === "blocks" || block.task) rows.push({ card, block, order: order++ });
  }
  const hits = rows.filter((row) => {
    const parts = q.where.map((c) => test(c, row, q));
    return q.match === "any" ? parts.length === 0 || parts.some(Boolean) : parts.every(Boolean);
  });
  hits.sort((a, b) => {
    for (const s of q.sort) {
      const x = key(s.by, a);
      const y = key(s.by, b);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return s.desc ? -c : c;
    }
    return a.order - b.order;
  });
  const top = hits.slice(0, q.limit);
  const out: QueryRows = { tasks: [], blocks: [], cards: [], total: hits.length };
  for (const { card, block } of top) {
    if (q.show === "cards") {
      out.cards.push({ id: card.id, kind: card.kind, title: card.title, preview: card.preview, createdAt: card.createdAt, updatedAt: card.updatedAt, fromInbox: card.fromInbox } as CardRow);
    } else if (q.show === "tasks" && block?.task) {
      out.tasks.push({ cardId: card.id, cardTitle: card.title, cardKind: card.kind, bid: block.bid, text: block.text, ...block.task, updatedAt: card.updatedAt } as TaskRow);
    } else if (block) {
      const children: ChildBlock[] = [];
      const depth = new Map([[block.bid, 0]]);
      const all = card.index.blocks;
      for (const c of all.slice(all.indexOf(block) + 1)) {
        const d = c.parent === null ? undefined : depth.get(c.parent);
        if (d === undefined) break;
        depth.set(c.bid, d + 1);
        children.push({ bid: c.bid, depth: d + 1, text: c.text });
      }
      out.blocks.push({ cardId: card.id, cardTitle: card.title, cardKind: card.kind, bid: block.bid, text: block.text, via: "query", ...(children.length > 0 && { children }) } as Backlink);
    }
  }
  return out;
}
