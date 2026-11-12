// From a query's spec to the conditions the store runs (design/query.md §7):
// relative days become dates, "this card" its id, periods ranges. Done here
// once, so the Rust store and the web build's memory store only compare.

import type { ResolvedCond, ResolvedQuery } from "../bindings/commands";
import { addDays } from "../docs/ids";
import { addMonths } from "../tasks/calendar";
import { DEFAULT_LIMIT, MAX_LIMIT, OPEN_STATES, PRIORITIES, shownKind, type Cond, type DateCond, type Period, type QuerySpec, type SortKey } from "./spec";

export interface QueryContext {
  /** The card (or journal day) the query is in. */
  cardId: string | null;
  /** The journal day it is on, YYYY-MM-DD; null outside the journal. */
  day: string | null;
  today: string;
  /** 1 = Monday … 7 = Sunday. */
  firstDay: number;
  /** Template cards: never listed. */
  templates: string[];
}

const weekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() || 7;
};

/** A day token as a date. */
export function dayOf(token: string, ctx: QueryContext): string | null {
  switch (token) {
    case "today":
      return ctx.today;
    case "yesterday":
      return addDays(ctx.today, -1);
    case "tomorrow":
      return addDays(ctx.today, 1);
    case "page":
      return ctx.day ?? ctx.today;
  }
  const rel = /^([+-])(\d+)([dw])$/.exec(token);
  if (rel) return addDays(ctx.today, (rel[1] === "-" ? -1 : 1) * Number(rel[2]) * (rel[3] === "w" ? 7 : 1));
  return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : null;
}

/** A period's first and last day. */
export function periodRange(p: Period, ctx: QueryContext): [string, string] {
  if (p.endsWith("week")) {
    const start = addDays(ctx.today, -((weekday(ctx.today) - ctx.firstDay + 7) % 7));
    const s = addDays(start, p === "last-week" ? -7 : p === "next-week" ? 7 : 0);
    return [s, addDays(s, 6)];
  }
  const first = addMonths(`${ctx.today.slice(0, 7)}-01`, p === "last-month" ? -1 : p === "next-month" ? 1 : 0);
  return [first, addDays(addMonths(first, 1), -1)];
}

/** The days a date condition takes, inclusive; null for an open end. */
function days(v: DateCond, ctx: QueryContext): { from: string | null; to: string | null; none?: boolean } {
  if ("period" in v) {
    const [from, to] = periodRange(v.period, ctx);
    return { from, to };
  }
  if ("is" in v) return v.is === "none" ? { from: null, to: null, none: true } : { from: null, to: addDays(ctx.today, -1) };
  let from = v.from ? dayOf(v.from, ctx) : null;
  let to = v.to ? dayOf(v.to, ctx) : null;
  if (from && v.xfrom) from = addDays(from, 1);
  if (to && v.xto) to = addDays(to, -1);
  return { from, to };
}

/** Local midnight at the start of `date`, in ms. */
const startOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

const RANK = ["urgent", "high", "medium", "low", "none"];

function resolveCond(c: Cond, ctx: QueryContext): ResolvedCond {
  const not = !!c.not;
  switch (c.k) {
    case "tag":
      return { k: "tag", not, v: c.v.map((x) => x.trim().toLowerCase()) };
    case "task": {
      const all = ["backlog", "todo", "doing", "review", "done", "canceled"];
      const v = c.v.flatMap((s) => (s === "open" ? OPEN_STATES : s === "any" ? all : [s]));
      return { k: "task", not, v: [...new Set(v)] };
    }
    case "priority": {
      // "At least high": high and urgent.
      const v = c.min ? RANK.slice(0, RANK.indexOf(c.v[0]) + 1).filter((p) => p !== "none") : c.v.filter((p) => (PRIORITIES as readonly string[]).includes(p));
      return { k: "priority", not, v };
    }
    case "text":
      return { k: "text", not, v: [c.v] };
    case "in": {
      const v = c.v;
      if (v === "this") return { k: "in", not, v: ["card", ctx.cardId ?? ""] };
      return { k: "in", not, v: typeof v === "string" ? [v] : ["topic", v.topic] };
    }
    case "links": {
      const v = c.v;
      if ("block" in v) return { k: "links", not, block: v.block };
      return { k: "links", not, card: v.card === "this" ? (ctx.cardId ?? "") : v.card };
    }
    case "group":
      return { k: "group", not, match: c.match, where: c.where.map((x) => resolveCond(x, ctx)) };
    case "created":
    case "updated": {
      const { from, to } = days(c.v, ctx);
      return { k: "time", not, field: c.k, fromMs: from ? startOf(from) : null, toMs: to ? startOf(addDays(to, 1)) : null };
    }
    default: {
      const { from, to, none } = days(c.v, ctx);
      return { k: "date", not, field: c.k, from, to, none: !!none };
    }
  }
}

const DEFAULT_SORT: Record<string, { by: SortKey; desc: boolean }[]> = {
  tasks: [
    { by: "due", desc: false },
    { by: "priority", desc: false },
  ],
  blocks: [{ by: "day", desc: true }],
  cards: [{ by: "updated", desc: true }],
};

/** The query as the store runs it. */
export function resolveQuery(spec: QuerySpec, ctx: QueryContext): ResolvedQuery {
  const show = shownKind(spec);
  const where = spec.where.map((c) => resolveCond(c, ctx));
  const mentions = (cs: Cond[]): boolean => cs.some((c) => (c.k === "in" && c.v === "inbox") || (c.k === "group" && mentions(c.where)));
  return {
    show,
    match: spec.match,
    where,
    sort: spec.sort?.length ? spec.sort.map((s) => ({ by: s.by, desc: !!s.desc })) : DEFAULT_SORT[show],
    exclude: ctx.templates,
    includeInbox: mentions(spec.where),
    limit: Math.min(MAX_LIMIT, spec.view?.limit ?? DEFAULT_LIMIT),
  };
}
