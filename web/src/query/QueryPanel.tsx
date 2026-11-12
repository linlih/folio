// A query's conditions, display and text (design/query.md §5.2): changes
// apply as they are made, each an ordinary edit of the block (⌘Z undoes).
// Under the block on a computer, a sheet from the bottom on a phone.

import { Popover } from "@base-ui/react/popover";
import { Plus, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TagInfo } from "../bindings/commands";
import { useTopics } from "../docs/topics";
import { titleCache } from "../editor/refs";
import i18n from "../i18n";
import { backend } from "../platform";
import { usePhone } from "../shell/phone";
import { namesFor, knownNames } from "./names";
import {
  DATE_KEYS,
  GROUP_KEYS,
  MAX_LIMIT,
  PRIORITIES,
  shownKind,
  SORT_KEYS,
  TASK_STATES,
  type Cond,
  type DateCond,
  type DateKey,
  type QuerySpec,
  type Show,
} from "./spec";
import { format, parse } from "./syntax";

export type PanelTab = "conds" | "display" | "text";

const lang = () => (i18n.language?.startsWith("zh") ? "zh" : "en");

/** Common queries for a new block (§2.1), as text. */
const PRESETS: { id: string; text: string; tag?: boolean }[] = [
  { id: "aboutThis", text: "task:open (in:this OR links:this) sort:due,priority" },
  { id: "dueSoon", text: "task:open due:<=+7d group:day sort:due" },
  { id: "newCards", text: "show:cards created:-7d.. sort:-created" },
  { id: "editedCards", text: "show:cards updated:-7d.. sort:-updated" },
  { id: "tagCards", text: "show:cards sort:-updated", tag: true },
  { id: "tagJournal", text: "show:blocks in:journal day:-7d.. sort:-day", tag: true },
];

const COND_KINDS = ["tag", "task", "priority", ...DATE_KEYS, "text", "in", "links"] as const;
type CondKind = (typeof COND_KINDS)[number];

function newCond(k: CondKind): Cond {
  switch (k) {
    case "tag":
      return { k, v: [] };
    case "task":
      return { k, v: ["open"] };
    case "priority":
      return { k, v: ["urgent", "high"] };
    case "text":
      return { k, v: "" };
    case "in":
      return { k, v: "this" };
    case "links":
      return { k, v: { card: "this" } };
    case "created":
    case "updated":
    case "day":
      return { k, v: { from: "-7d" } };
    default:
      return { k, v: { to: "+7d" } };
  }
}

/** Ready-made date choices: for a task's dates, and for the others. */
const TASK_DATES: Record<string, DateCond> = {
  today: { from: "today", to: "today" },
  overdue: { is: "overdue" },
  within7: { to: "+7d" },
  "this-week": { period: "this-week" },
  "next-week": { period: "next-week" },
  "this-month": { period: "this-month" },
  none: { is: "none" },
};
const PAST_DATES: Record<string, DateCond> = {
  today: { from: "today", to: "today" },
  recent7: { from: "-7d" },
  recent30: { from: "-30d" },
  "this-week": { period: "this-week" },
  "last-week": { period: "last-week" },
  "this-month": { period: "this-month" },
  "last-month": { period: "last-month" },
};
const choicesFor = (k: DateKey) => (k === "created" || k === "updated" || k === "day" ? { ...PAST_DATES, ...(k === "day" ? { page: { from: "page", to: "page" } } : {}) } : TASK_DATES);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function QueryPanel({
  spec,
  tab,
  onTab,
  onChange,
  onClose,
  anchor,
}: {
  spec: QuerySpec;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onChange: (spec: QuerySpec) => void;
  onClose: () => void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const phone = usePhone();
  const fresh = spec.where.length === 0 && !spec.show;
  // On a phone the keyboard would cover the sheet: the editor lets go.
  useEffect(() => {
    if (phone && document.activeElement instanceof HTMLElement && document.activeElement.closest(".ProseMirror")) document.activeElement.blur();
  }, [phone]);
  const content = (
    <div className="query-panel" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="query-tabs" role="tablist">
        {(["conds", "display", "text"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className="query-tab" onClick={() => onTab(k)}>
            {t(`query.panel.${k}`)}
          </button>
        ))}
        <button className="button query-done" onClick={onClose}>
          {t("query.panel.done")}
        </button>
      </div>
      <div className="query-page">
        {tab === "conds" && (
          <>
            {fresh && <Presets onPick={onChange} />}
            <Conditions spec={spec} onChange={onChange} />
          </>
        )}
        {tab === "display" && <Display spec={spec} onChange={onChange} />}
        {tab === "text" && <TextTab spec={spec} onChange={onChange} onClose={onClose} />}
      </div>
    </div>
  );
  if (phone)
    return createPortal(
      <div className="query-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="query-sheet">{content}</div>
      </div>,
      document.body,
    );
  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} collisionPadding={12} collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}>
          <Popover.Popup className="popup query-popup" initialFocus={false}>
            {content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Presets({ onPick }: { onPick: (spec: QuerySpec) => void }) {
  const { t } = useTranslation();
  return (
    <div className="query-presets">
      <div className="query-label">{t("query.panel.presets")}</div>
      {PRESETS.map((p) => (
        <button
          key={p.id}
          className="query-preset"
          onClick={() => {
            const r = parse(p.text);
            if (!r.ok) return;
            onPick(p.tag ? { ...r.spec, where: [{ k: "tag", v: [] }, ...r.spec.where] } : r.spec);
          }}
        >
          {t(`query.preset.${p.id}`)}
        </button>
      ))}
    </div>
  );
}

function Select<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <select className="query-select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Conditions({ spec, onChange }: { spec: QuerySpec; onChange: (spec: QuerySpec) => void }) {
  const { t } = useTranslation();
  const show = shownKind(spec);
  const setWhere = (where: Cond[]) => onChange({ ...spec, where });
  return (
    <div className="query-conds">
      <div className="query-line">
        <span>{t("query.panel.find")}</span>
        <Select<Show> value={show} options={(["tasks", "blocks", "cards"] as const).map((v) => ({ value: v, label: t(`query.sum.kind.${v}`) }))} onChange={(v) => onChange({ ...spec, show: v })} />
        <span>{t("query.panel.matching")}</span>
        <Select value={spec.match} options={[{ value: "all", label: t("query.panel.all") }, { value: "any", label: t("query.panel.any") }]} onChange={(v) => onChange({ ...spec, match: v })} />
        <span>{t("query.panel.conditions")}</span>
      </div>
      <CondList where={spec.where} onChange={setWhere} canGroup />
    </div>
  );
}

function CondList({ where, onChange, canGroup }: { where: Cond[]; onChange: (where: Cond[]) => void; canGroup: boolean }) {
  const { t } = useTranslation();
  const set = (i: number, c: Cond | null) => onChange(c ? where.map((x, j) => (j === i ? c : x)) : where.filter((_, j) => j !== i));
  return (
    <>
      <ul className="query-cond-list">
        {where.map((c, i) =>
          c.k === "group" ? (
            <li key={i} className="query-cond-group">
              <div className="query-line">
                {c.not && <span className="query-not">{t("query.panel.not")}</span>}
                <Select value={c.match} options={[{ value: "all", label: t("query.panel.groupAll") }, { value: "any", label: t("query.panel.groupAny") }]} onChange={(m) => set(i, { ...c, match: m })} />
                <CondTools cond={c} onChange={(x) => set(i, x)} />
              </div>
              <CondList where={c.where} onChange={(w) => set(i, w.length ? { ...c, where: w } : null)} canGroup={false} />
            </li>
          ) : (
            <li key={i} className="query-cond">
              <CondRow cond={c} onChange={(x) => set(i, x)} />
            </li>
          ),
        )}
      </ul>
      <div className="query-add">
        <AddCond onAdd={(k) => onChange([...where, newCond(k)])} />
        {canGroup && (
          <button className="button query-add-group" onClick={() => onChange([...where, { k: "group", match: "any", where: [newCond("in"), newCond("links")] }])}>
            <Plus size={13} />
            {t("query.panel.addGroup")}
          </button>
        )}
      </div>
    </>
  );
}

function AddCond({ onAdd }: { onAdd: (k: CondKind) => void }) {
  const { t } = useTranslation();
  return (
    <label className="button query-add-cond">
      <Plus size={13} />
      {t("query.panel.addCond")}
      <select value="" aria-label={t("query.panel.addCond")} onChange={(e) => e.target.value && onAdd(e.target.value as CondKind)}>
        <option value="" disabled>
          {t("query.panel.addCond")}
        </option>
        {COND_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`query.kinds.${k}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Not / delete, at a condition's end. */
function CondTools({ cond, onChange }: { cond: Cond; onChange: (c: Cond | null) => void }) {
  const { t } = useTranslation();
  return (
    <span className="query-cond-tools">
      <button className="query-chip" aria-pressed={!!cond.not} title={t("query.panel.negate")} onClick={() => onChange({ ...cond, not: !cond.not || undefined })}>
        {t("query.panel.not")}
      </button>
      <button className="icon-button query-remove" aria-label={t("query.panel.remove")} title={t("query.panel.remove")} onClick={() => onChange(null)}>
        <X size={13} />
      </button>
    </span>
  );
}

function CondRow({ cond: c, onChange }: { cond: Cond; onChange: (c: Cond | null) => void }) {
  const { t } = useTranslation();
  const kind = c.k as CondKind;
  return (
    <div className="query-line">
      <Select<CondKind> value={kind} label={t("query.panel.kind")} options={COND_KINDS.map((k) => ({ value: k, label: t(`query.kinds.${k}`) }))} onChange={(k) => onChange({ ...newCond(k), not: c.not })} />
      <span className="query-value">
        <ValueInput cond={c} onChange={onChange} />
      </span>
      <CondTools cond={c} onChange={onChange} />
    </div>
  );
}

function Chips({ values, all, label, onChange }: { values: string[]; all: readonly string[]; label: (v: string) => string; onChange: (v: string[]) => void }) {
  return (
    <span className="query-chips">
      {all.map((v) => (
        <button key={v} className="query-chip" aria-pressed={values.includes(v)} onClick={() => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])}>
          {label(v)}
        </button>
      ))}
    </span>
  );
}

function ValueInput({ cond: c, onChange }: { cond: Cond; onChange: (c: Cond) => void }) {
  const { t } = useTranslation();
  switch (c.k) {
    case "tag":
      return <TagPicker tags={c.v} onChange={(v) => onChange({ ...c, v })} />;
    case "task":
      return <Chips values={c.v} all={TASK_STATES.filter((s) => s !== "any")} label={(s) => t(`query.sum.state.${s}`)} onChange={(v) => onChange({ ...c, v: v.length ? v : ["any"] })} />;
    case "priority":
      return <Chips values={c.v} all={[...PRIORITIES].reverse()} label={(p) => t(`priority.${p}`)} onChange={(v) => onChange({ k: "priority", not: c.not, v })} />;
    case "text":
      return <input className="query-input" value={c.v} placeholder={t("query.panel.textHint")} onChange={(e) => onChange({ ...c, v: e.target.value })} />;
    case "in":
      return <PlaceInput cond={c} onChange={onChange} />;
    case "links":
      return <LinkInput cond={c} onChange={onChange} />;
    case "group":
      return null;
    default:
      return <DateInput k={c.k} v={c.v} onChange={(v) => onChange({ ...c, v } as Cond)} />;
  }
}

function DateInput({ k, v, onChange }: { k: DateKey; v: DateCond; onChange: (v: DateCond) => void }) {
  const { t } = useTranslation();
  const choices = choicesFor(k);
  const current = Object.entries(choices).find(([, x]) => same(x, v))?.[0] ?? "custom";
  const range = "from" in v || "to" in v ? (v as { from?: string; to?: string }) : {};
  const abs = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");
  return (
    <>
      <Select
        value={current}
        options={[...Object.keys(choices).map((id) => ({ value: id, label: t(`query.dates.${id}`) })), { value: "custom", label: t("query.dates.custom") }]}
        onChange={(id) => onChange(id === "custom" ? { from: abs(range.from) || undefined, to: abs(range.to) || undefined } : choices[id])}
      />
      {current === "custom" && (
        <span className="query-range">
          <input type="date" className="query-input" aria-label={t("query.dates.from")} value={abs(range.from)} onChange={(e) => onChange({ ...range, from: e.target.value || undefined })} />
          <span>–</span>
          <input type="date" className="query-input" aria-label={t("query.dates.to")} value={abs(range.to)} onChange={(e) => onChange({ ...range, to: e.target.value || undefined })} />
        </span>
      )}
    </>
  );
}

function TagPicker({ tags, onChange }: { tags: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [known, setKnown] = useState<TagInfo[]>([]);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void backend.tags(200).then(setKnown, () => {});
    if (tags.length === 0) input.current?.focus();
    // Once, when it shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = () => {
    const name = draft.replace(/^#/, "").trim().toLowerCase();
    if (name && !tags.includes(name)) onChange([...tags, name]);
    setDraft("");
  };
  const listId = useMemo(() => `query-tags-${Math.random().toString(36).slice(2)}`, []);
  return (
    <span className="query-tags">
      {tags.map((tag) => (
        <span key={tag} className="query-tag">
          #{tag}
          <button aria-label={t("query.panel.remove")} onClick={() => onChange(tags.filter((x) => x !== tag))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        className="query-input"
        list={listId}
        value={draft}
        placeholder={t("query.panel.tagHint")}
        onChange={(e) => {
          const v = e.target.value;
          // Picked from the list: added at once.
          if (known.some((k) => k.key === v.trim().toLowerCase()) && v.length - draft.length > 1) {
            const name = v.trim().toLowerCase();
            if (!tags.includes(name)) onChange([...tags, name]);
            return setDraft("");
          }
          setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" || e.key === ",") e.preventDefault(), add();
          if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={add}
      />
      <datalist id={listId}>
        {known
          .filter((k) => !tags.includes(k.key))
          .map((k) => (
            <option key={k.key} value={k.key}>
              #{k.name}
            </option>
          ))}
      </datalist>
    </span>
  );
}

function PlaceInput({ cond: c, onChange }: { cond: Extract<Cond, { k: "in" }>; onChange: (c: Cond) => void }) {
  const { t } = useTranslation();
  const topics = useTopics((s) => s.topics);
  const v = c.v;
  const kind = typeof v === "string" ? v : "topic";
  return (
    <>
      <Select
        value={kind}
        options={(["this", "cards", "journal", "inbox", "topic"] as const).map((p) => ({ value: p, label: t(`query.places.${p}`) }))}
        onChange={(p) => onChange({ ...c, v: p === "topic" ? { topic: topics[0]?.id ?? "" } : p })}
      />
      {typeof v !== "string" && (
        <Select value={v.topic} options={topics.map((tp) => ({ value: tp.id, label: tp.name }))} onChange={(id) => onChange({ ...c, v: { topic: id } })} />
      )}
    </>
  );
}

function LinkInput({ cond: c, onChange }: { cond: Extract<Cond, { k: "links" }>; onChange: (c: Cond) => void }) {
  const { t } = useTranslation();
  const v = c.v;
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!q.trim()) return setHits([]);
    let live = true;
    void backend.search(q, 20).then((rs) => {
      if (!live) return;
      const seen = new Set<string>();
      setHits(rs.filter((h) => h.bid === null && !seen.has(h.cardId) && seen.add(h.cardId)).slice(0, 8).map((h) => ({ id: h.cardId, title: h.cardTitle })));
    });
    return () => void (live = false);
  }, [q]);
  if ("block" in v) return <span className="query-fixed">{t("query.sum.aBlock")}</span>;
  const title = v.card === "this" ? t("query.sum.thisCard") : (titleCache.get(v.card)?.text ?? "…");
  return (
    <span className="query-link">
      <button className="query-chip" aria-pressed={v.card === "this"} onClick={() => onChange({ ...c, v: { card: "this" } })}>
        {t("query.sum.thisCard")}
      </button>
      {v.card !== "this" && <span className="query-fixed">「{title}」</span>}
      <span className="query-search">
        <input className="query-input" value={q} placeholder={t("query.panel.cardHint")} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
          <span className="popup query-hits">
            {hits.map((h) => (
              <button
                key={h.id}
                className="popup-item"
                onClick={() => {
                  onChange({ ...c, v: { card: h.id } });
                  setQ("");
                }}
              >
                {h.title || t("library.untitled")}
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="query-field">
      <span className="query-label">{label}</span>
      {children}
    </label>
  );
}

function Display({ spec, onChange }: { spec: QuerySpec; onChange: (spec: QuerySpec) => void }) {
  const { t } = useTranslation();
  const show = shownKind(spec);
  const sort = spec.sort ?? [];
  const setSort = (i: number, by: string, desc: boolean) => {
    const next = [...sort];
    if (by === "") next.splice(i);
    else next[i] = { by: by as (typeof SORT_KEYS)[number], desc: desc || undefined };
    onChange({ ...spec, sort: next.length ? next : undefined });
  };
  const sortKeys = SORT_KEYS.filter((k) => show === "tasks" || (k !== "due" && k !== "priority"));
  return (
    <div className="query-display">
      <Field label={t("query.panel.title")}>
        <input className="query-input" value={spec.title ?? ""} placeholder={t("query.panel.titleHint")} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} />
      </Field>
      <Field label={t("query.panel.show")}>
        <Select<Show> value={show} options={(["tasks", "blocks", "cards"] as const).map((v) => ({ value: v, label: t(`query.sum.kind.${v}`) }))} onChange={(v) => onChange({ ...spec, show: v })} />
      </Field>
      {[0, 1].map((i) =>
        i > sort.length ? null : (
          <Field key={i} label={t(i === 0 ? "query.panel.sort" : "query.panel.thenBy")}>
            <span className="query-line">
              <Select
                value={sort[i]?.by ?? ""}
                options={[{ value: "", label: t(i === 0 ? "query.panel.sortDefault" : "query.panel.none") }, ...sortKeys.map((k) => ({ value: k, label: t(`query.sorts.${k}`) }))]}
                onChange={(by) => setSort(i, by, !!sort[i]?.desc)}
              />
              {sort[i] && (
                <Select
                  value={sort[i].desc ? "desc" : "asc"}
                  options={[{ value: "asc", label: t("query.panel.asc") }, { value: "desc", label: t("query.panel.desc") }]}
                  onChange={(d) => setSort(i, sort[i].by, d === "desc")}
                />
              )}
            </span>
          </Field>
        ),
      )}
      {show === "tasks" && (
        <Field label={t("query.panel.group")}>
          <Select
            value={spec.group ?? ""}
            options={[{ value: "", label: t("query.panel.none") }, ...GROUP_KEYS.map((g) => ({ value: g, label: t(`query.groups.${g}`) }))]}
            onChange={(g) => onChange({ ...spec, group: (g || undefined) as QuerySpec["group"] })}
          />
        </Field>
      )}
      <Field label={t("query.panel.limit")}>
        <input
          type="number"
          className="query-input query-limit"
          min={1}
          max={MAX_LIMIT}
          value={spec.view?.limit ?? 20}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (n >= 1 && n <= MAX_LIMIT) onChange({ ...spec, view: { ...spec.view, limit: n === 20 ? undefined : n } });
          }}
        />
      </Field>
    </div>
  );
}

function TextTab({ spec, onChange, onClose }: { spec: QuerySpec; onChange: (spec: QuerySpec) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState(() => format(spec, lang(), knownNames()));
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const edit = (text: string) => {
    setSrc(text);
    const n = ++seq.current;
    void namesFor(text).then((names) => {
      if (n !== seq.current) return;
      const r = parse(text, names);
      if (!r.ok) {
        const near = r.error.params?.near;
        return setError(t(`query.err.${r.error.code}`, { ...r.error.params, near: typeof near === "string" ? near : "" }));
      }
      setError(null);
      // Collapsed or not is the block's, not the text's.
      const next = { ...r.spec, view: { ...r.spec.view, ...(spec.view?.collapsed ? { collapsed: true } : {}) } };
      if (!same(next, spec)) onChange(next);
    });
  };
  return (
    <div className="query-text">
      <textarea
        ref={area}
        className="query-source"
        value={src}
        spellCheck={false}
        rows={3}
        aria-invalid={!!error}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), onClose())}
      />
      {error ? <p className="query-error">{error}</p> : <p className="query-hint">{t("query.panel.textTip")}</p>}
    </div>
  );
}
