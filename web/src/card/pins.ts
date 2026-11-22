// Cards pinned to the sidebar. The pin is a field of the card (it syncs);
// this keeps the list the sidebar and card menus show, in the order the
// person put them (by `pinned_at`, design/query.md §13), and for a card
// with a query block what that query finds now.

import { LoroDoc } from "loro-crdt";
import { useEffect } from "react";
import { create } from "zustand";
import { docs } from "../app";
import type { CardRow } from "../bindings/commands";
import { firstQuerySpec, readMeta, setPinned, setTitle } from "../docs/card";
import { isJournalId, localDate } from "../docs/ids";
import { DOC_SAVED } from "../docs/persistence";
import i18n from "../i18n";
import { backend } from "../platform";
import { resolveQuery } from "../query/resolve";
import { readSpec, shownKind, type QuerySpec } from "../query/spec";
import { useShell } from "../shell/tabs";
import { firstDayOfWeek } from "../tasks/calendar";
import { CARDS_CHANGED, cardsChanged } from "./actions";
import { useTemplates } from "./templates";

/** What a pinned card's first query lists: how many (null while it asks
 *  for nothing yet), and whether any of them is a task past its date. */
export interface PinQuery {
  count: number | null;
  overdue: boolean;
}

interface Pins {
  cards: CardRow[];
  /** Cards with a query block, by id. */
  queries: Record<string, PinQuery>;
  load(): Promise<void>;
}

/** Read from each pinned card: when it was pinned (its place in the list)
 *  and its first query. Read again when the card is saved. */
const facts = new Map<string, { at: number; spec: string | null }>();

async function factsOf(id: string) {
  let f = facts.get(id);
  if (!f) {
    const bytes = await backend.docSnapshot(id);
    const doc = new LoroDoc();
    if (bytes) doc.import(bytes);
    f = { at: readMeta(doc).pinnedAt ?? 0, spec: firstQuerySpec(doc) };
    facts.set(id, f);
  }
  return f;
}

/** The query `spec` of card `cardId`, counted as the sidebar shows it. */
export async function countQuery(spec: QuerySpec, cardId: string): Promise<PinQuery> {
  if (spec.where.length === 0 && !spec.show) return { count: null, overdue: false };
  const ctx = {
    cardId,
    day: isJournalId(cardId) ? cardId.slice(8) : null,
    today: localDate(new Date()),
    firstDay: firstDayOfWeek(i18n.language),
    templates: useTemplates.getState().ids,
  };
  const all = resolveQuery(spec, ctx);
  all.limit = 1;
  const { total } = await backend.query(all);
  if (shownKind(spec) !== "tasks" || total === 0) return { count: total, overdue: false };
  // The same tasks, only those past their date.
  const late = resolveQuery({ ...spec, match: "all", where: [{ k: "group", match: spec.match, where: spec.where }, { k: "due", v: { is: "overdue" } }] }, ctx);
  late.limit = 1;
  return { count: total, overdue: (await backend.query(late)).total > 0 };
}

export const usePins = create<Pins>((set) => ({
  cards: [],
  queries: {},
  load: async () => {
    const cards = await backend.pinnedCards();
    set({ cards });
    const queries: Record<string, PinQuery> = {};
    await Promise.all(
      cards.map(async (c) => {
        const { spec: raw } = await factsOf(c.id).catch(() => ({ spec: null }));
        const spec = raw === null ? null : readSpec(raw).spec;
        if (raw === null) return;
        queries[c.id] = spec ? await countQuery(spec, c.id).catch(() => ({ count: null, overdue: false })) : { count: null, overdue: false };
      }),
    );
    // Only if the list is still the one counted.
    if (usePins.getState().cards === cards) set({ queries });
  },
}));

export const isPinned = (cards: CardRow[], id: string) => cards.some((c) => c.id === id);

/** Whether the card is in the trash (as its open replica says). */
async function inTrash(cardId: string): Promise<boolean> {
  const hub = docs();
  const h = await hub.open(cardId);
  try {
    return readMeta(h.doc).deletedAt !== null;
  } finally {
    await hub.release(cardId);
  }
}

export async function setPin(cardId: string, pinned: boolean) {
  try {
    // A card in the trash is never listed: pinning one (it was open in a
    // tab, say) takes it out of the trash first, and says so.
    const restore = pinned && (await inTrash(cardId));
    if (restore) await backend.restoreCard(cardId);
    // The host edits the card; an open replica takes the change in.
    await backend.pinCard(cardId, pinned);
    await docs().refresh([cardId]);
    if (restore) useShell.getState().setNotice(i18n.t("nav.pinRestored"));
  } catch (e) {
    useShell.getState().setNotice(i18n.t("error.generic", { message: String(e) }));
  }
  facts.delete(cardId);
  cardsChanged();
}

/** Pins a card from its query block: a card with no title yet is named
 *  after what the query lists, so the sidebar says something. */
export async function pinQueryCard(cardId: string, title: string) {
  const hub = docs();
  const h = await hub.open(cardId);
  try {
    if (!readMeta(h.doc).title.trim() && title) {
      setTitle(h.doc, title);
      await h.persistence.flush();
    }
  } finally {
    await hub.release(cardId);
  }
  await setPin(cardId, true);
}

/** Spacing given to pins when there is no room left between two. */
const STEP = 1000;

/** Where a pin goes between `prev` and `next` (their `pinned_at`), or
 *  null when they are too close: then every pin is placed anew. */
export function pinBetween(prev: number | null, next: number | null, now: number): number | null {
  if (prev === null && next === null) return now;
  if (prev === null) return next! - STEP;
  if (next === null) return Math.max(prev + 1, now);
  return next - prev >= 2 ? Math.floor((prev + next) / 2) : null;
}

async function writePin(id: string, at: number) {
  const hub = docs();
  const h = await hub.open(id);
  try {
    setPinned(h.doc, at);
    await h.persistence.flush();
  } finally {
    await hub.release(id);
  }
  facts.set(id, { ...(facts.get(id) ?? { spec: null }), at });
}

/** Moves pinned card `id` before `before` (null: to the end). Usually one
 *  card changes: its pin goes between its new neighbours' (it syncs like
 *  any edit, and older versions order by it as before). */
export async function movePin(id: string, before: string | null) {
  const { cards } = usePins.getState();
  const moved = cards.find((c) => c.id === id);
  if (!moved || id === before) return;
  const others = cards.filter((c) => c.id !== id);
  const at = before === null ? others.length : others.findIndex((c) => c.id === before);
  if (at < 0) return;
  const order = [...others.slice(0, at), moved, ...others.slice(at)];
  if (order.every((c, i) => c === cards[i])) return;
  usePins.setState({ cards: order });
  try {
    // Read fresh: another device may have moved a pin since.
    for (const c of order) facts.delete(c.id);
    const times = await Promise.all(order.map((c) => factsOf(c.id).then((f) => f.at)));
    const i = order.indexOf(moved);
    const pos = pinBetween(i > 0 ? times[i - 1] : null, i < order.length - 1 ? times[i + 1] : null, Date.now());
    if (pos !== null) await writePin(id, pos);
    else {
      // No room: spaced out again, from the first one's time.
      const base = Math.min(...times);
      for (const [k, c] of order.entries()) if (times[k] !== base + k * STEP) await writePin(c.id, base + k * STEP);
    }
  } catch (e) {
    useShell.getState().setNotice(i18n.t("error.generic", { message: String(e) }));
  }
  cardsChanged();
}

/** Keeps the pinned list current (cards trashed or renamed elsewhere). */
export function usePinsLoader() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void usePins.getState().load().catch(() => {});
    const soon = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) facts.delete(id);
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    const changed = () => {
      facts.clear();
      load();
    };
    load();
    window.addEventListener(CARDS_CHANGED, changed);
    window.addEventListener(DOC_SAVED, soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARDS_CHANGED, changed);
      window.removeEventListener(DOC_SAVED, soon);
    };
  }, []);
}
