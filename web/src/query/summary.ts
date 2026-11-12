// A query in a few words, for the block's title line when it has no title
// of its own: "Open tasks · About this card · Due within 7 days".

import i18n from "../i18n";
import { shownKind, type Cond, type DateCond, type QuerySpec } from "./spec";
import { format, type Lang, type Names, noNames } from "./syntax";

const t = (key: string, params?: Record<string, unknown>) => i18n.t(`query.sum.${key}`, params);

/** "+7d" → 7; anything else → null. */
const days = (d: string | undefined, sign: "+" | "-") => {
  const m = d ? /^([+-])(\d+)([dw])$/.exec(d) : null;
  return m && m[1] === sign ? Number(m[2]) * (m[3] === "w" ? 7 : 1) : null;
};

function datePhrase(kind: Cond["k"], v: DateCond, lang: Lang): string | null {
  // "day" (a journal day's date) has its phrases apart from the day names.
  const k = kind === "day" ? "journalDay" : kind;
  if ("is" in v) return t(`${k}.${v.is}`, { defaultValue: "" }) || null;
  if ("period" in v) return t(`${k}.period`, { period: t(`period.${v.period}`), defaultValue: "" }) || null;
  if (!v.xfrom && !v.xto) {
    const ahead = !v.from || v.from === "today" ? days(v.to, "+") : null;
    if (ahead !== null) return t(`${k}.within`, { count: ahead, defaultValue: "" }) || null;
    const back = !v.to ? days(v.from, "-") : null;
    if (back !== null) return t(`${k}.recent`, { count: back, defaultValue: "" }) || null;
    if (v.from && v.from === v.to && ["today", "page", "tomorrow", "yesterday"].includes(v.from)) return t(`${k}.on`, { day: t(`day.${v.from}`), defaultValue: "" }) || null;
  }
  void lang;
  return null;
}

function phrase(c: Cond, lang: Lang, names: Names): string {
  const not = c.not ? t("not") : "";
  switch (c.k) {
    case "tag":
      return not + c.v.map((x) => `#${x}`).join(t("or"));
    case "task":
      return not + t("status", { list: c.v.map((s) => t(`state.${s}`)).join(t("and")) });
    case "text":
      return t(c.not ? "without" : "with", { text: c.v });
    case "in": {
      const v = c.v;
      return not + (typeof v === "string" ? t(`in.${v}`) : t("in.topic", { name: names.topicName(v.topic) ?? "…" }));
    }
    case "links": {
      const v = c.v;
      const target = "block" in v ? t("aBlock") : v.card === "this" ? t("thisCard") : `「${names.cardTitle(v.card) ?? "…"}」`;
      return not + t("links", { target });
    }
    case "group": {
      // The common pair: in this card, or linking to it.
      const [a, b] = c.where;
      if (c.match === "any" && c.where.length === 2 && !c.not && a.k === "in" && a.v === "this" && !a.not && b.k === "links" && "card" in b.v && b.v.card === "this" && !b.not)
        return t("aboutThis");
      return `${not}(${c.where.map((x) => phrase(x, lang, names)).join(c.match === "any" ? t("or") : t("and"))})`;
    }
    default: {
      if (c.k === "priority") break;
      const p = c.not ? null : datePhrase(c.k, c.v, lang);
      if (p) return p;
    }
  }
  // Anything without words of its own: as written.
  return format({ v: 1, match: "all", where: [c] }, lang, names);
}

/** The query's title: its own, or what it lists and the conditions. */
export function summary(spec: QuerySpec, lang: Lang, names: Names = noNames): string {
  if (spec.title) return spec.title;
  const kind = shownKind(spec);
  let where = spec.where;
  // "Open tasks" rather than "Tasks · status open".
  let head = t(`kind.${kind}`);
  const state = spec.match === "all" ? where.find((c) => c.k === "task" && !c.not && c.v.length === 1) : undefined;
  if (kind === "tasks" && state && state.k === "task") {
    head = t(`kindState.${state.v[0]}`, { defaultValue: head });
    where = where.filter((c) => c !== state);
  }
  const parts = where.map((c) => phrase(c, lang, names));
  return [head, ...(spec.match === "any" && parts.length > 1 ? [parts.join(t("or"))] : parts)].join(" · ");
}
