// A query block's conditions and display (design/query.md §6): stored as
// JSON in the block's `spec` attribute. The text syntax (syntax.ts) and the
// condition panel are two ways of editing the same object.

export const SPEC_VERSION = 1;

export type Show = "tasks" | "blocks" | "cards";
export type Match = "all" | "any";
export type ViewMode = "list" | "table" | "board";

/** Named periods of time; each is a range. */
export const PERIODS = ["this-week", "last-week", "next-week", "this-month", "last-month", "next-month"] as const;
export type Period = (typeof PERIODS)[number];

/** A day: "today", "yesterday", "tomorrow", "page" (the journal day the
 *  query is on, else today), "+7d" / "-30d" / "+2w", or "YYYY-MM-DD". */
export type DayToken = string;

/** A condition on a date. `from`/`to` are inclusive unless `xfrom`/`xto`;
 *  either may be left open. */
export type DateCond =
  | { from?: DayToken; to?: DayToken; xfrom?: boolean; xto?: boolean }
  | { period: Period }
  | { is: "overdue" | "none" };

export const DATE_KEYS = ["due", "deadline", "scheduled", "created", "updated", "day"] as const;
export type DateKey = (typeof DATE_KEYS)[number];

/** Task states a condition can name: the editor's six, and "open" (not
 *  done or canceled) and "any" (every task). */
export const TASK_STATES = ["open", "done", "canceled", "backlog", "todo", "doing", "review", "any"] as const;
export const OPEN_STATES = ["backlog", "todo", "doing", "review"];
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export type Place = "cards" | "journal" | "inbox" | "this" | { topic: string };
/** A card (its id, or "this") or a block (its bid). */
export type LinkTarget = { card: string } | { block: string };

export type Cond = { not?: boolean } & (
  | { k: "tag"; v: string[] }
  | { k: "task"; v: string[] }
  | { k: "priority"; v: string[]; min?: boolean }
  | { k: DateKey; v: DateCond }
  | { k: "text"; v: string }
  | { k: "in"; v: Place }
  | { k: "links"; v: LinkTarget }
  | { k: "group"; match: Match; where: Cond[] }
);

export const SORT_KEYS = ["due", "priority", "created", "updated", "day", "title"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const GROUP_KEYS = ["card", "day", "status"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export interface QuerySpec {
  v: number;
  title?: string;
  show?: Show;
  match: Match;
  where: Cond[];
  sort?: { by: SortKey; desc?: boolean }[];
  group?: GroupKey;
  view?: { mode?: ViewMode; limit?: number; collapsed?: boolean };
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;

export const emptySpec = (): QuerySpec => ({ v: SPEC_VERSION, match: "all", where: [] });

/** Every condition, those in groups too. */
export function allConds(where: Cond[]): Cond[] {
  return where.flatMap((c) => (c.k === "group" ? [c, ...allConds(c.where)] : [c]));
}

/** What the query lists: as chosen, else guessed from its conditions
 *  (§3.1): task conditions mean tasks; otherwise blocks. */
export function shownKind(spec: QuerySpec): Show {
  if (spec.show) return spec.show;
  const keys = new Set(allConds(spec.where).map((c) => c.k));
  if (["task", "priority", "due", "deadline", "scheduled"].some((k) => keys.has(k as Cond["k"]))) return "tasks";
  return "blocks";
}

/** The spec stored in a block, or null when it is not one this version
 *  can run (written by a newer Folio: shown as "update Folio", never
 *  rewritten). */
export function readSpec(raw: unknown): { spec: QuerySpec | null; newer: boolean } {
  if (typeof raw !== "string" || !raw) return { spec: emptySpec(), newer: false };
  try {
    const v = JSON.parse(raw) as QuerySpec;
    if (!v || typeof v !== "object" || !Array.isArray(v.where)) return { spec: emptySpec(), newer: false };
    if ((v.v ?? 1) > SPEC_VERSION || !known(v.where)) return { spec: null, newer: true };
    return { spec: { ...v, match: v.match === "any" ? "any" : "all" }, newer: false };
  } catch {
    return { spec: emptySpec(), newer: false };
  }
}

const KINDS = new Set<string>(["tag", "task", "priority", ...DATE_KEYS, "text", "in", "links", "group"]);
const known = (where: Cond[]): boolean => where.every((c) => c && KINDS.has(c.k) && (c.k !== "group" || (Array.isArray(c.where) && known(c.where))));

export const writeSpec = (spec: QuerySpec): string => JSON.stringify({ ...spec, v: SPEC_VERSION });
