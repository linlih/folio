// Tag databases (design/inbox-and-tags.md §3): a tag's fields live in the
// workspace document; each card keeps its values in `meta.props` (card.ts).
// The cards of a tag's database are the cards (not journal days) with the
// tag anywhere in them.
//
// `databases` is a root map; a tag's entry, its `fields`, a field's
// `options` and the `view` are mergeable maps, so two devices adding fields
// to the same tag at once both keep theirs. Fields and options are maps
// under their own new ids, edited per key (a rename on one device, a new
// option on another).

import { LoroMap, type LoroDoc } from "loro-crdt";
import type { TagCard } from "../bindings/commands";
import type { PropValue } from "./card";
import { uuidv7 } from "./ids";
import { TOPIC_ORIGIN } from "./workspace";

const DATABASES = "databases";

export type FieldType = "text" | "number" | "select" | "date" | "checkbox" | "url";
export const FIELD_TYPES: FieldType[] = ["select", "text", "number", "date", "checkbox", "url"];

export interface FieldOption {
  id: string;
  name: string;
  /** One of `OPTION_COLORS`. */
  color: string;
  order: number;
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  order: number;
  /** Choices of a select field, in order. */
  options: FieldOption[];
}

export type ViewMode = "table" | "board" | "blocks";

export interface DbView {
  mode: ViewMode;
  /** The select field the board groups by; null: the first one. */
  groupBy: string | null;
  /** "title", "updated", "created" or a field id. */
  sortBy: string;
  sortDesc: boolean;
}

export interface Database {
  fields: Field[];
  view: DbView;
}

/** In the order cards were made, new ones last (beside where they are
 *  typed): sorting by last edit would move a row while it is edited. */
export const DEFAULT_VIEW: DbView = { mode: "table", groupBy: null, sortBy: "created", sortDesc: false };

/** Option colours, by name: the stylesheet gives each its tint. */
export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** Tags match case-insensitively (as the index does). */
export const tagKey = (tag: string) => tag.trim().toLowerCase();

const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");
const num = (m: LoroMap, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : null);
const isType = (t: string): t is FieldType => (FIELD_TYPES as string[]).includes(t);

function entry(doc: LoroDoc, tag: string): LoroMap | null {
  const m = doc.getMap(DATABASES).get(tagKey(tag));
  return m instanceof LoroMap ? m : null;
}

const ensureEntry = (doc: LoroDoc, tag: string) => doc.getMap(DATABASES).ensureMergeableMap(tagKey(tag));

const byOrder = <T extends { order: number; id: string }>(a: T, b: T) => a.order - b.order || (a.id < b.id ? -1 : 1);

/** A tag's fields (not deleted, in order) and how it is shown. */
export function readDatabase(doc: LoroDoc, tag: string): Database {
  const db = entry(doc, tag);
  const fields: Field[] = [];
  const all = db?.get("fields");
  if (all instanceof LoroMap) {
    for (const id of all.keys()) {
      const f = all.get(id);
      if (!(f instanceof LoroMap) || num(f, "deleted_at") !== null) continue;
      const type = str(f, "type");
      const options: FieldOption[] = [];
      const opts = f.get("options");
      if (opts instanceof LoroMap) {
        for (const oid of opts.keys()) {
          const o = opts.get(oid);
          if (!(o instanceof LoroMap) || num(o, "deleted_at") !== null) continue;
          options.push({ id: oid, name: str(o, "name"), color: str(o, "color") || "gray", order: num(o, "order") ?? 0 });
        }
      }
      fields.push({ id, name: str(f, "name"), type: isType(type) ? type : "text", order: num(f, "order") ?? 0, options: options.sort(byOrder) });
    }
  }
  const v = db?.get("view");
  const mode = v instanceof LoroMap ? str(v, "mode") : "";
  const view: DbView = v instanceof LoroMap
    ? {
        mode: mode === "board" || mode === "blocks" ? mode : "table",
        groupBy: str(v, "group_by") || null,
        sortBy: str(v, "sort_by") || DEFAULT_VIEW.sortBy,
        sortDesc: v.get("sort_desc") === undefined ? DEFAULT_VIEW.sortDesc : v.get("sort_desc") === true,
      }
    : DEFAULT_VIEW;
  return { fields: fields.sort(byOrder), view };
}

/** Adds a field at the end; answers its id. */
export function addField(doc: LoroDoc, tag: string, name: string, type: FieldType, now = Date.now()): string {
  const fields = ensureEntry(doc, tag).ensureMergeableMap("fields");
  const order = Math.max(0, ...readDatabase(doc, tag).fields.map((f) => f.order + 1));
  const id = uuidv7(now);
  const f = fields.ensureMergeableMap(id);
  f.set("name", name.trim());
  f.set("type", type);
  f.set("order", order);
  f.set("created_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
  return id;
}

function field(doc: LoroDoc, tag: string, id: string): LoroMap | null {
  const all = entry(doc, tag)?.get("fields");
  const f = all instanceof LoroMap ? all.get(id) : null;
  return f instanceof LoroMap ? f : null;
}

export function renameField(doc: LoroDoc, tag: string, id: string, name: string) {
  const f = field(doc, tag, id);
  if (!f || !name.trim()) return;
  f.set("name", name.trim());
  doc.commit({ origin: TOPIC_ORIGIN });
}

/** Removes a field from the database. A marker, so a device that is
 *  offline sees it go too; the values stay on the cards, unseen. */
export function deleteField(doc: LoroDoc, tag: string, id: string, now = Date.now()) {
  const f = field(doc, tag, id);
  if (!f) return;
  f.set("deleted_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
}

/** Brings a removed field back (undo). */
export function restoreField(doc: LoroDoc, tag: string, id: string) {
  const f = field(doc, tag, id);
  if (!f) return;
  f.delete("deleted_at");
  doc.commit({ origin: TOPIC_ORIGIN });
}

/** Adds a choice to a select field, coloured in turn; answers its id. */
export function addOption(doc: LoroDoc, tag: string, fieldId: string, name: string, now = Date.now()): string | null {
  const f = field(doc, tag, fieldId);
  if (!f || !name.trim()) return null;
  const existing = readDatabase(doc, tag).fields.find((x) => x.id === fieldId)?.options ?? [];
  const id = uuidv7(now);
  const o = f.ensureMergeableMap("options").ensureMergeableMap(id);
  o.set("name", name.trim());
  o.set("color", OPTION_COLORS[(existing.length + 1) % OPTION_COLORS.length]);
  o.set("order", Math.max(0, ...existing.map((x) => x.order + 1)));
  doc.commit({ origin: TOPIC_ORIGIN });
  return id;
}

export function setView(doc: LoroDoc, tag: string, view: Partial<DbView>) {
  const v = ensureEntry(doc, tag).ensureMergeableMap("view");
  if (view.mode !== undefined) v.set("mode", view.mode);
  if (view.groupBy !== undefined) {
    if (view.groupBy) v.set("group_by", view.groupBy);
    else v.delete("group_by");
  }
  if (view.sortBy !== undefined) v.set("sort_by", view.sortBy);
  if (view.sortDesc !== undefined) v.set("sort_desc", view.sortDesc);
  doc.commit({ origin: TOPIC_ORIGIN });
}

// ---- rows ----

export interface DbRow extends Omit<TagCard, "props"> {
  values: Record<string, PropValue>;
}

export function toRow(c: TagCard): DbRow {
  let values: Record<string, PropValue> = {};
  try {
    const parsed = JSON.parse(c.props) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as Record<string, PropValue>;
  } catch {
    // An unreadable value shows as empty.
  }
  return { id: c.id, title: c.title, preview: c.preview, createdAt: c.createdAt, updatedAt: c.updatedAt, url: c.url, values };
}

/** Rows in the view's order; empty values last either way. A select field
 *  sorts by its options' order, not their names. */
export function sortRows(rows: DbRow[], fields: Field[], view: Pick<DbView, "sortBy" | "sortDesc">, locale: string): DbRow[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const f = fields.find((x) => x.id === view.sortBy);
  const key = (r: DbRow): string | number | null => {
    if (view.sortBy === "title") return r.title || null;
    if (view.sortBy === "updated") return r.updatedAt;
    if (view.sortBy === "created") return r.createdAt;
    if (!f) return null;
    const v = r.values[f.id];
    if (v === null || v === undefined || v === "") return null;
    if (f.type === "select") {
      const o = f.options.find((x) => x.id === v);
      return o ? o.order : null;
    }
    if (f.type === "checkbox") return v === true ? 1 : 0;
    if (f.type === "number") return typeof v === "number" ? v : Number(v);
    return String(v);
  };
  const dir = view.sortDesc ? -1 : 1;
  // Ties keep the order cards were made in, so editing one does not move it.
  const made = (a: DbRow, b: DbRow) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null) return x === y ? made(a, b) : x === null ? 1 : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    return c * dir || made(a, b);
  });
}

/** The board's columns: one per option of the select field, in order, then
 *  cards with no choice (or one since deleted). */
export function groupRows(rows: DbRow[], field: Field): { option: FieldOption | null; rows: DbRow[] }[] {
  const known = new Set(field.options.map((o) => o.id));
  const columns: { option: FieldOption | null; rows: DbRow[] }[] = field.options.map((o) => ({ option: o, rows: rows.filter((r) => r.values[field.id] === o.id) }));
  columns.push({ option: null, rows: rows.filter((r) => !known.has(String(r.values[field.id] ?? ""))) });
  return columns;
}

/** The select field a board groups by: the chosen one, or the first. */
export function boardField(db: Database): Field | null {
  const selects = db.fields.filter((f) => f.type === "select");
  return selects.find((f) => f.id === db.view.groupBy) ?? selects[0] ?? null;
}
