// The query text syntax (design/query.md §3.3): words separated by spaces,
// each a condition, a setting or text to look for. Keywords in English or
// Chinese; full-width punctuation from a Chinese input method is read as
// its ASCII twin. parse() and format() round-trip: format(parse(t)) gives
// back the same spec.

import {
  DATE_KEYS,
  GROUP_KEYS,
  MAX_LIMIT,
  PERIODS,
  PRIORITIES,
  SORT_KEYS,
  SPEC_VERSION,
  TASK_STATES,
  type Cond,
  type DateCond,
  type DateKey,
  type GroupKey,
  type LinkTarget,
  type Period,
  type Place,
  type QuerySpec,
  type Show,
  type SortKey,
  type ViewMode,
} from "./spec";

export type Lang = "zh" | "en";

/** Ids for names in the text, and names for ids when writing it. */
export interface Names {
  /** Cards with this title (exact, any case). */
  cards(title: string): string[];
  cardTitle(id: string): string | null;
  /** Topics with this name, or "Parent › Name" path. */
  topics(name: string): string[];
  topicName(id: string): string | null;
}

export const noNames: Names = { cards: () => [], cardTitle: () => null, topics: () => [], topicName: () => null };

export type ParseError = { at: [number, number]; code: string; params?: Record<string, string | number> };
export type ParseResult = { ok: true; spec: QuerySpec } | { ok: false; error: ParseError };

// ---- words: English and Chinese ----

type Pair = readonly [en: string, zh: string];
const pairs = <K extends string>(m: Record<K, Pair>) => m;

const KEYS = pairs({
  tag: ["tag", "标签"],
  task: ["task", "任务"],
  priority: ["priority", "优先级"],
  due: ["due", "到期"],
  deadline: ["deadline", "截止"],
  scheduled: ["scheduled", "计划"],
  created: ["created", "创建"],
  updated: ["updated", "修改"],
  day: ["day", "日期"],
  in: ["in", "在"],
  links: ["links", "链接"],
  show: ["show", "显示"],
  view: ["view", "显示为"],
  sort: ["sort", "排序"],
  group: ["group", "分组"],
  limit: ["limit", "条数"],
  title: ["title", "标题"],
});
type Key = keyof typeof KEYS;

const STATES = pairs({ open: ["open", "未完成"], done: ["done", "已完成"], canceled: ["canceled", "已取消"], backlog: ["backlog", "待规划"], todo: ["todo", "待办"], doing: ["doing", "进行中"], review: ["review", "审核中"], any: ["any", "全部"] });
const PRIOS = pairs({ none: ["none", "无"], low: ["low", "低"], medium: ["medium", "中"], high: ["high", "高"], urgent: ["urgent", "紧急"] });
const SHOWS = pairs({ tasks: ["tasks", "任务"], blocks: ["blocks", "块"], cards: ["cards", "卡片"] });
const VIEWS = pairs({ list: ["list", "列表"], table: ["table", "表格"], board: ["board", "看板"] });
const PLACES = pairs({ cards: ["cards", "卡片"], journal: ["journal", "日记"], inbox: ["inbox", "收集箱"], this: ["this", "本卡"] });
const SORTS = pairs({ due: ["due", "到期"], priority: ["priority", "优先级"], created: ["created", "创建"], updated: ["updated", "修改"], day: ["day", "日期"], title: ["title", "标题"] });
const GROUPS = pairs({ card: ["card", "卡片"], day: ["day", "日期"], status: ["status", "状态"] });
const DAYS = pairs({ today: ["today", "今天"], yesterday: ["yesterday", "昨天"], tomorrow: ["tomorrow", "明天"], page: ["page", "本页"] });
const PERIOD_WORDS = pairs({
  "this-week": ["this-week", "本周"],
  "last-week": ["last-week", "上周"],
  "next-week": ["next-week", "下周"],
  "this-month": ["this-month", "本月"],
  "last-month": ["last-month", "上月"],
  "next-month": ["next-month", "下月"],
});
const SPECIAL = pairs({ overdue: ["overdue", "已过期"], none: ["none", "无"] });
const TOPIC: Pair = ["topic", "主题"];
const THIS: Pair = ["this", "本卡"];
const OR_WORDS = ["or", "或"];

/** The canonical name for `word` in `table`, either language, any case. */
function lookup<K extends string>(table: Record<K, Pair>, word: string): K | null {
  const w = word.toLowerCase();
  for (const [k, [en, zh]] of Object.entries(table) as [K, Pair][]) if (w === en || w === zh) return k;
  return null;
}
const say = (p: Pair, lang: Lang) => (lang === "zh" ? p[1] : p[0]);

// ---- reading ----

/** Full-width punctuation outside quotes as ASCII. */
const WIDE: Record<string, string> = { "：": ":", "，": ",", "（": "(", "）": ")", "＞": ">", "＜": "<", "＝": "=", "－": "-", "＋": "+", "！": "!", "　": " ", "＃": "#", "［": "[", "］": "]", "【": "[", "】": "]", "。": "." };
const QUOTES = new Set(['"', "“", "”", "＂"]);

type Token = { text: string; at: [number, number]; quoted: boolean } | { paren: "(" | ")"; at: [number, number] };

/** Splits the text into words, parentheses and quoted phrases. A quote
 *  may start mid-word (`#"two words"`, `title:"…"`): the word runs on. */
function tokenize(src: string): Token[] | ParseError {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = WIDE[src[i]] ?? src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      out.push({ paren: ch, at: [i, i + 1] });
      i++;
      continue;
    }
    const start = i;
    let text = "";
    let quoted = false;
    while (i < src.length) {
      const c = WIDE[src[i]] ?? src[i];
      if (QUOTES.has(src[i])) {
        const close = src.slice(i + 1).search(/["“”＂]/);
        if (close < 0) return { at: [i, src.length], code: "unclosedQuote" };
        // Marked, so the word's keyword and operator are told from its value.
        text += "\u0000" + src.slice(i + 1, i + 1 + close) + "\u0001";
        quoted = true;
        i += close + 2;
        continue;
      }
      // A [[card title]] is one word, spaces and all.
      if (src.startsWith("[[", i) || src.startsWith("【【", i)) {
        const close = src.slice(i + 2).search(/\]\]|】】/);
        if (close >= 0) {
          text += "[[" + src.slice(i + 2, i + 2 + close) + "]]";
          i += close + 4;
          continue;
        }
      }
      if (/\s/.test(c) || c === "(" || c === ")") break;
      text += c;
      i++;
    }
    out.push({ text, at: [start, i], quoted });
  }
  return out;
}

/** A word with its quoted parts unmarked. */
const plain = (s: string) => s.replace(/[\u0000\u0001]/g, "");
/** The word's text before the first quote, where keys and operators are. */
const head = (s: string) => s.split("\u0000")[0];

const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const REL_RE = /^([+-])(\d{1,4})(d|天|w|周)$/i;

/** A single day, as stored. */
function dayToken(w: string): string | null {
  const named = lookup(DAYS, w);
  if (named) return named;
  const rel = REL_RE.exec(w);
  if (rel) return `${rel[1]}${rel[2]}${/^(w|周)$/i.test(rel[3]) ? "w" : "d"}`;
  if (DATE_RE.test(w)) {
    const [y, m, d] = w.split("-").map(Number);
    const t = new Date(y, m - 1, d);
    if (t.getMonth() !== m - 1 || t.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

function dateCond(value: string): DateCond | null {
  const period = lookup(PERIOD_WORDS, value);
  if (period) return { period };
  const special = lookup(SPECIAL, value);
  if (special) return { is: special };
  const range = value.split("..");
  if (range.length === 2) {
    const [a, b] = range;
    const from = a ? dayToken(a) : undefined;
    const to = b ? dayToken(b) : undefined;
    if (from === null || to === null || (!a && !b)) return null;
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  const op = /^(<=|>=|<|>)/.exec(value)?.[0];
  const day = dayToken(op ? value.slice(op.length) : value);
  if (!day) return null;
  if (op === "<=") return { to: day };
  if (op === "<") return { to: day, xto: true };
  if (op === ">=") return { from: day };
  if (op === ">") return { from: day, xfrom: true };
  return { from: day, to: day };
}

/** Edit distance, for "did you mean": a swap of two letters side by side
 *  counts as one edit, as typing slips usually are. */
function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[x.length][y.length];
}

/** The keyword `word` looks like a misspelling of, in the language it is
 *  written in. */
function nearKey(word: string): string | null {
  const w = word.toLowerCase();
  const zh = /[^\x00-\x7f]/.test(w);
  let best: string | null = null;
  let bestD = Infinity;
  for (const [en, cn] of Object.values(KEYS) as Pair[]) {
    const k = zh ? cn : en;
    const d = distance(w, k);
    if (d < bestD && d <= Math.max(1, Math.floor([...k].length / 3))) [best, bestD] = [k, d];
  }
  return best;
}

type Setting = Partial<Pick<QuerySpec, "show" | "sort" | "group" | "title">> & { mode?: ViewMode; limit?: number };

/** Reads the query text. Errors name the place (code units) and why. */
export function parse(src: string, names: Names = noNames): ParseResult {
  const toks = tokenize(src);
  if (!Array.isArray(toks)) return { ok: false, error: toks };
  const settings: Setting = {};
  const fail = (at: [number, number], code: string, params?: ParseError["params"]): ParseResult => ({ ok: false, error: { at, code, params } });

  // Words into conditions, with "OR" and groups kept as markers first.
  type Item = Cond | "or";
  const top: Item[] = [];
  let inner: Item[] | null = null;
  let innerNot = false;
  let innerAt: [number, number] = [0, 0];
  let negate = false;

  for (const t of toks) {
    const list = inner ?? top;
    if ("paren" in t) {
      if (t.paren === "(") {
        if (inner) return fail(t.at, "nested");
        inner = [];
        innerNot = negate;
        innerAt = t.at;
        negate = false;
      } else {
        if (!inner) return fail(t.at, "unopened");
        const g = group(inner);
        if ("code" in g) return fail(g.at ?? innerAt, g.code);
        top.push(innerNot ? { ...g, not: true } : g);
        inner = null;
      }
      continue;
    }
    let word = t.text;
    if (!t.quoted && OR_WORDS.includes(word.toLowerCase())) {
      list.push("or");
      continue;
    }
    let not = negate;
    negate = false;
    if (word.startsWith("-") && word.length > 1 && !REL_RE.test(word)) {
      not = true;
      word = word.slice(1);
    } else if (word === "-") {
      negate = true;
      continue;
    }
    const r = atom(word, t.quoted, names, settings);
    if (r === "setting") {
      if (not) return fail(t.at, "negatedSetting");
      continue;
    }
    if ("code" in r) return fail(t.at, r.code, r.params);
    list.push(not ? { ...r, not: true } : r);
  }
  if (inner) return fail(innerAt, "unclosed");

  const g = group(top);
  if ("code" in g) return fail(g.at ?? [0, src.length], g.code);
  const spec: QuerySpec = { v: SPEC_VERSION, match: g.match, where: g.where };
  if (settings.title) spec.title = settings.title;
  if (settings.show) spec.show = settings.show;
  if (settings.sort) spec.sort = settings.sort;
  if (settings.group) spec.group = settings.group;
  if (settings.mode || settings.limit) spec.view = { ...(settings.mode ? { mode: settings.mode } : {}), ...(settings.limit ? { limit: settings.limit } : {}) };
  return { ok: true, spec };

  /** Items joined by "OR" (looser) and spaces (tighter): a group, or a
   *  plain list. Only one level of groups is allowed in all. */
  function group(items: Item[]): { k: "group"; match: "all" | "any"; where: Cond[] } | { code: string; at?: [number, number] } {
    const branches: Cond[][] = [[]];
    for (const it of items) {
      if (it === "or") branches.push([]);
      else branches[branches.length - 1].push(it);
    }
    if (branches.some((b) => b.length === 0) && branches.length > 1) return { code: "emptyOr" };
    if (branches.length === 1) return { k: "group", match: "all", where: branches[0] };
    const where: Cond[] = [];
    for (const b of branches) {
      if (b.length === 1) where.push(b[0]);
      else if (b.some((c) => c.k === "group")) return { code: "nested" };
      else where.push({ k: "group", match: "all", where: b });
    }
    return { k: "group", match: "any", where };
  }
}

/** One word: a condition, a setting (applied to `settings`), or an error. */
function atom(word: string, quoted: boolean, names: Names, settings: Setting): Cond | "setting" | { code: string; params?: Record<string, string> } {
  const h = head(word);
  if (h.startsWith("#") && word.length > 1) {
    const tags = plain(word.slice(1)).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!tags.length) return { code: "emptyTag" };
    return { k: "tag", v: tags };
  }
  const colon = h.indexOf(":");
  if (colon > 0) {
    const keyWord = h.slice(0, colon);
    const value = plain(word.slice(colon + 1)).trim();
    const key = lookup(KEYS, keyWord);
    if (!key) {
      const near = nearKey(keyWord);
      if (near) return { code: "unknownKeyNear", params: { key: keyWord, near } };
      // A colon in ordinary text (a time, a link): look for it as typed.
      return { k: "text", v: plain(word) };
    }
    if (!value) return { code: "emptyValue", params: { key: keyWord } };
    return keyed(key, keyWord, value, names, settings);
  }
  if (!quoted && /^[^=<>!]+(=|!=|>=|<=|>|<)/.test(h)) return { code: "fieldsLater" };
  return { k: "text", v: plain(word) };
}

function keyed(key: Key, keyWord: string, value: string, names: Names, s: Setting): Cond | "setting" | { code: string; params?: Record<string, string> } {
  const bad = { code: "badValue", params: { key: keyWord, value } };
  const list = value.split(",").map((x) => x.trim()).filter(Boolean);
  switch (key) {
    case "tag":
      return { k: "tag", v: list.map((x) => x.replace(/^#/, "").toLowerCase()) };
    case "task": {
      const v = list.map((x) => lookup(STATES, x));
      return v.every(Boolean) ? { k: "task", v: v as string[] } : bad;
    }
    case "priority": {
      const min = value.startsWith(">=");
      const v = (min ? [value.slice(2)] : list).map((x) => lookup(PRIOS, x));
      return v.every(Boolean) && v.length ? { k: "priority", v: v as string[], ...(min ? { min } : {}) } : bad;
    }
    case "due":
    case "deadline":
    case "scheduled":
    case "created":
    case "updated":
    case "day": {
      const v = dateCond(value);
      if (!v) return bad;
      if ("is" in v && v.is === "overdue" && !["due", "deadline", "scheduled"].includes(key)) return bad;
      return { k: key, v };
    }
    case "in": {
      const place = lookup(PLACES, value);
      if (place) return { k: "in", v: place };
      const topic = /^([^:]+):(.+)$/.exec(value);
      if (topic && lookup({ topic: TOPIC }, topic[1])) {
        const ids = names.topics(topic[2].trim());
        if (ids.length === 0) return { code: "noTopic", params: { name: topic[2].trim() } };
        if (ids.length > 1) return { code: "manyTopics", params: { name: topic[2].trim() } };
        return { k: "in", v: { topic: ids[0] } };
      }
      return bad;
    }
    case "links": {
      if (lookup({ this: THIS }, value)) return { k: "links", v: { card: "this" } };
      const card = /^\[\[(.+)\]\]$/.exec(value);
      if (card) {
        const ids = names.cards(card[1].trim());
        if (ids.length === 0) return { code: "noCard", params: { name: card[1].trim() } };
        if (ids.length > 1) return { code: "manyCards", params: { name: card[1].trim(), count: String(ids.length) } };
        return { k: "links", v: { card: ids[0] } };
      }
      const block = /^\(\((.+)\)\)$/.exec(value);
      if (block) return { k: "links", v: { block: block[1].trim() } };
      return bad;
    }
    case "show": {
      const v = lookup(SHOWS, value);
      if (!v) return bad;
      s.show = v;
      return "setting";
    }
    case "view": {
      const v = lookup(VIEWS, value);
      if (!v) return bad;
      s.mode = v;
      return "setting";
    }
    case "sort": {
      if (list.length > 2) return { code: "twoSorts" };
      const sort: { by: SortKey; desc?: boolean }[] = [];
      for (const x of list) {
        const desc = x.startsWith("-");
        const by = lookup(SORTS, desc ? x.slice(1) : x);
        if (!by) return bad;
        sort.push(desc ? { by, desc } : { by });
      }
      s.sort = sort;
      return "setting";
    }
    case "group": {
      const v = lookup(GROUPS, value);
      if (!v) return bad;
      s.group = v;
      return "setting";
    }
    case "limit": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { code: "badLimit", params: { max: String(MAX_LIMIT) } };
      s.limit = n;
      return "setting";
    }
    case "title":
      s.title = value;
      return "setting";
  }
}

// ---- writing ----

/** Quotes a value that would not read back as one word. */
const q = (s: string) => (/^[^\s()"“”＂（）]+$/.test(s) && !/^(or|或)$/i.test(s) ? s : `"${s.replace(/["“”＂]/g, "")}"`);
const key = (k: Key, lang: Lang) => say(KEYS[k], lang) + ":";

function dayWord(d: string, lang: Lang): string {
  const named = DAYS[d as keyof typeof DAYS];
  if (named) return say(named, lang);
  const rel = /^([+-]\d+)([dw])$/.exec(d);
  if (rel && lang === "zh") return rel[1] + (rel[2] === "w" ? "周" : "天");
  return d;
}

function dateWord(v: DateCond, lang: Lang): string {
  if ("period" in v) return say(PERIOD_WORDS[v.period], lang);
  if ("is" in v) return say(SPECIAL[v.is], lang);
  const { from, to, xfrom, xto } = v;
  if (from && to && from === to && !xfrom && !xto) return dayWord(from, lang);
  if (from && to) return `${dayWord(from, lang)}..${dayWord(to, lang)}`;
  if (to) return `${xto ? "<" : "<="}${dayWord(to, lang)}`;
  if (from) return `${xfrom ? ">" : ">="}${dayWord(from, lang)}`;
  return "..";
}

function condWord(c: Cond, lang: Lang, names: Names): string {
  const neg = c.not ? "-" : "";
  switch (c.k) {
    case "tag":
      return neg + "#" + c.v.map(q).join(",");
    case "task":
      return neg + key("task", lang) + c.v.map((s) => say(STATES[s as keyof typeof STATES] ?? [s, s], lang)).join(",");
    case "priority":
      return neg + key("priority", lang) + (c.min ? ">=" : "") + c.v.map((p) => say(PRIOS[p as keyof typeof PRIOS] ?? [p, p], lang)).join(",");
    case "text":
      // Quoted when it would read as something else (a keyword, a tag).
      return neg + (/[:：#=<>]|^-/.test(c.v) || /^(or|或)$/i.test(c.v) ? `"${c.v.replace(/["“”＂]/g, "")}"` : q(c.v));
    case "in": {
      const v = c.v;
      const place = typeof v === "string" ? say(PLACES[v], lang) : `${say(TOPIC, lang)}:${q(names.topicName(v.topic) ?? v.topic)}`;
      return neg + key("in", lang) + place;
    }
    case "links": {
      const v = c.v;
      const target = "block" in v ? `((${v.block}))` : v.card === "this" ? say(THIS, lang) : `[[${names.cardTitle(v.card) ?? v.card}]]`;
      return neg + key("links", lang) + target;
    }
    case "group": {
      const inner = c.where.map((x) => condWord(x, lang, names));
      return `${neg}(${inner.join(c.match === "any" ? " OR " : " ")})`;
    }
    default:
      return neg + key(c.k, lang) + dateWord(c.v, lang);
  }
}

/** The query as text, in `lang`'s keywords; parse() reads it back to the
 *  same spec. */
export function format(spec: QuerySpec, lang: Lang, names: Names = noNames): string {
  const words: string[] = [];
  if (spec.match === "any") {
    // Branches joined by OR: an "all" group is its words, unbracketed.
    words.push(
      spec.where
        .map((c) => (c.k === "group" && c.match === "all" && !c.not ? c.where.map((x) => condWord(x, lang, names)).join(" ") : condWord(c, lang, names)))
        .join(" OR "),
    );
  } else {
    for (const c of spec.where) words.push(condWord(c, lang, names));
  }
  if (spec.show) words.push(key("show", lang) + say(SHOWS[spec.show], lang));
  if (spec.view?.mode) words.push(key("view", lang) + say(VIEWS[spec.view.mode], lang));
  if (spec.sort?.length) words.push(key("sort", lang) + spec.sort.map((s) => (s.desc ? "-" : "") + say(SORTS[s.by], lang)).join(","));
  if (spec.group) words.push(key("group", lang) + say(GROUPS[spec.group], lang));
  if (spec.view?.limit) words.push(key("limit", lang) + spec.view.limit);
  if (spec.title) words.push(key("title", lang) + `"${spec.title.replace(/["“”＂]/g, "")}"`);
  return words.filter(Boolean).join(" ");
}

/** The `[[titles]]` and `topic:names` the text names: looked up before
 *  parse(), which needs them at hand. */
export function namesIn(src: string): { cards: string[]; topics: string[] } {
  const cards = [...src.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
  const topics = [...src.matchAll(/(?:topic|主题)[:：]\s*(?:["“”]([^"“”]+)["“”]|([^\s()（）]+))/gi)].map((m) => (m[1] ?? m[2]).trim());
  return { cards, topics };
}

export const KEYWORDS = KEYS;
export const _test = { tokenize, dateCond, dayToken, nearKey };
export type { DateKey, GroupKey, LinkTarget, Period, Place, Show };
export { DATE_KEYS, GROUP_KEYS, PERIODS, PRIORITIES, SORT_KEYS, TASK_STATES };
