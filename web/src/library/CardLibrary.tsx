import { Brush, Layers, LayoutGrid, List, Plus, Search, Trash2, X, LibraryBig } from "lucide-react";
import { isTouch } from "../shell/phone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { CARDS_CHANGED, moveManyToTrash } from "../card/actions";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { applyQuery, DEFAULT_QUERY, isEmptyCard, type EditedWithin, type LibraryGrouping, type LibraryQuery, type LibraryView, type SortKey } from "./query";
import "./library.css";
import { EmptyState } from "../shell/EmptyState";
import { TopicPicker } from "../card/TopicRow";
import { setCardsTopic, useTopics } from "../docs/topics";
import { CARDS_MIME } from "../card/drag";
import { TopicGrid, TopicHeader } from "./TopicGrid";
import { keyLabel } from "../shell/shortcuts";

/** Sort and filter choices are remembered on this device. */
const QUERY_SETTING = "library.query";

/** All cards (design/ARCHITECTURE.md §8.4, after Heptabase's card library):
 *  search, sort, filter by last edit, multi-select, clean up empty cards.
 *  Whiteboard and tag filters arrive with whiteboards (M5) and tags (M6). */
export function CardLibrary({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const { open, setNotice } = useShell();
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_QUERY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const topic = useShell((s) => s.libraryTopic);
  const topicExists = useTopics((s) => !topic || s.topics.some((x) => x.id === topic));
  /** Which cards are in which topics. */
  const [pairs, setPairs] = useState<[string, string][]>([]);

  const reload = useCallback(async () => {
    try {
      const [all, inTopics] = await Promise.all([backend.listCards(5000), backend.cardTopicPairs()]);
      setCards(all);
      setPairs(inTopics);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  }, [setNotice, t]);

  // A topic deleted (here or on another device) leaves all cards showing.
  useEffect(() => {
    if (!topicExists) useShell.getState().setLibraryTopic(null);
  }, [topicExists]);

  // Another topic: what was selected belonged to the last view.
  useEffect(() => setSelected(new Set()), [topic]);

  // Titles and previews change in other tabs; read them again when shown.
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(CARDS_CHANGED, onChange);
    return () => window.removeEventListener(CARDS_CHANGED, onChange);
  }, [reload]);

  useEffect(() => {
    backend.getLocalSetting<Partial<LibraryQuery>>(QUERY_SETTING).then(
      (saved) =>
        saved &&
        setQuery((q) => ({ ...q, sort: saved.sort ?? q.sort, edited: saved.edited ?? q.edited, view: saved.view ?? q.view, grouping: saved.grouping ?? q.grouping })),
      () => {},
    );
  }, []);

  const update = (patch: Partial<LibraryQuery>) => {
    setQuery((q) => {
      const next = { ...q, ...patch };
      if (patch.sort || patch.edited || patch.view || patch.grouping) {
        void backend.setLocalSetting(QUERY_SETTING, { sort: next.sort, edited: next.edited, view: next.view, grouping: next.grouping });
      }
      return next;
    });
  };

  // Cards by topic, newest first (the tiles show the newest few).
  const byTopic = useMemo(() => {
    const byId = new Map((cards ?? []).map((c) => [c.id, c]));
    const out = new Map<string, CardRow[]>();
    for (const [card, t] of pairs) {
      const c = byId.get(card);
      if (c) out.set(t, [...(out.get(t) ?? []), c]);
    }
    for (const list of out.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [cards, pairs]);
  const topicCount = useTopics((s) => s.topics.length);
  // Home with topics shows their tiles and the cards in none; a search
  // always looks through every card.
  const searching = query.text.trim() !== "";
  const home = !topic && query.grouping === "topics" && !searching;
  const inView = useMemo(() => {
    if (!cards) return null;
    if (topic) return byTopic.get(topic) ?? [];
    if (!home) return cards;
    const filed = new Set(pairs.map(([c]) => c));
    return cards.filter((c) => !filed.has(c.id));
  }, [cards, topic, home, byTopic, pairs]);
  const shown = useMemo(() => (inView ? applyQuery(inView, query, i18n.language) : []), [inView, query, i18n.language]);
  const empties = useMemo(() => (cards ?? []).filter(isEmptyCard), [cards]);

  // Selection only holds cards that still exist.
  useEffect(() => {
    if (!cards) return;
    const ids = new Set(cards.map((c) => c.id));
    setSelected((s) => (([...s].every((id) => ids.has(id)) ? s : new Set([...s].filter((id) => ids.has(id))))));
  }, [cards]);

  async function newCard() {
    try {
      const id = await backend.createCard("");
      // Made while a topic shows: it belongs there.
      if (topic) await setCardsTopic([id], topic, true);
      await reload();
      open({ kind: "card", cardId: id }, null);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  }

  // On a touch screen a long press selects a card (and starts selecting),
  // instead of dragging it, which fingers use for scrolling.
  const touch = isTouch();
  function pressCard(e: React.MouseEvent, id: string) {
    if (!touch) return;
    e.preventDefault();
    toggle(id, false);
  }

  /** Click toggles; Shift+click selects the range from the last click. */
  function toggle(id: string, shift: boolean) {
    // Read the range start now: the updater below runs later, after
    // lastClicked has moved on to this card.
    const from = lastClicked.current ? shown.findIndex((c) => c.id === lastClicked.current) : -1;
    const to = shown.findIndex((c) => c.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(shown[i].id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClicked.current = id;
  }

  /** Dragging a card (or the selection it is part of) onto a topic tile. */
  const dragCards = (e: React.DragEvent, id: string) => {
    const ids = selected.has(id) ? [...selected] : [id];
    e.dataTransfer.setData(CARDS_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "link";
  };

  const trashSelected = async () => {
    const chosen = (cards ?? []).filter((c) => selected.has(c.id));
    setSelected(new Set());
    await moveManyToTrash(chosen);
  };

  /** A click opens the card; Shift or Cmd/Ctrl+click selects (Heptabase's
   *  grid). While cards are selected, a plain click selects too. Shift is
   *  taken, so Alt+click opens in the other pane here. */
  const clickCard = (c: CardRow, e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || selected.size > 0) toggle(c.id, e.shiftKey);
    else open({ kind: "card", cardId: c.id }, c.title || null, e.altKey);
  };

  // Cmd/Ctrl+Backspace moves the selection to the trash; Esc clears it.
  useEffect(() => {
    if (!active || selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input:not([type='checkbox']), textarea, select, [contenteditable='true']")) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        void trashSelected();
      } else if (e.key === "Escape") setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const now = new Date();
  const sameDay = (ms: number) => new Date(ms).toDateString() === now.toDateString();
  const timeFmt = new Intl.DateTimeFormat(i18n.language, { timeStyle: "short" });
  const dateFmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const when = (ms: number | null) => (ms === null ? "" : sameDay(ms) ? timeFmt.format(ms) : dateFmt.format(ms));
  const selecting = selected.size > 0;

  return (
    <div className={`page library${query.view === "grid" ? " grid-view" : ""}`}>
      <header className="page-header">
        {topic ? <TopicHeader topicId={topic} /> : <h1>{t("library.title")}</h1>}
        {cards && <span className="page-meta">{t("library.count", { count: topic ? (inView?.length ?? 0) : cards.length })}</span>}
        <span className="library-header-actions">
          {empties.length > 0 && (
            <button className="button" title={t("library.cleanEmptyHint")} onClick={() => void moveManyToTrash(empties)}>
              <Brush size={14} />
              {t("library.cleanEmpty", { count: empties.length })}
            </button>
          )}
          <button className="button primary" onClick={newCard}>
            <Plus size={14} />
            {t("library.newCard")}
          </button>
        </span>
      </header>

      {/* While cards are selected, the selection bar takes the toolbar's
          place at the same height, so the list never jumps under the
          pointer. */}
      {selecting ? (
        <div className="library-selection" role="toolbar">
          <span>{t("library.selected", { count: selected.size })}</span>
          <button className="button" onClick={() => setSelected(new Set(shown.map((c) => c.id)))}>
            {t("library.selectAll")}
          </button>
          <TopicPicker taken={topic ? [topic] : []} onPick={(id) => {
              const chosen = [...selected];
              setSelected(new Set());
              void setCardsTopic(chosen, id, true);
            }} className="button">
            <Layers size={14} />
            {t("topics.add")}
          </TopicPicker>
          {topic && (
            <button
              className="button"
              onClick={() => {
                const chosen = [...selected];
                setSelected(new Set());
                void setCardsTopic(chosen, topic, false);
              }}
            >
              {t("topics.removeSelected")}
            </button>
          )}
          <button className="button danger" onClick={() => void trashSelected()}>
            <Trash2 size={14} />
            {t("library.moveToTrash")}
          </button>
          <button className="icon-button" aria-label={t("library.clearSelection")} onClick={() => setSelected(new Set())}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="library-toolbar">
          <label className="library-search">
            <Search size={14} strokeWidth={1.75} />
            <input
              type="search"
              value={query.text}
              placeholder={t("library.search")}
              onChange={(e) => update({ text: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && update({ text: "" })}
            />
          </label>
          <label className="library-select">
            <span>{t("library.edited")}</span>
            <select value={query.edited} onChange={(e) => update({ edited: e.target.value as EditedWithin })}>
              {(["all", "today", "week", "month"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`library.within.${k}`)}
                </option>
              ))}
            </select>
          </label>
          {!topic && (
            <span className="segmented library-grouping" role="radiogroup" aria-label={t("library.grouping")}>
              {(["topics", "all"] as LibraryGrouping[]).map((g) => (
                <button key={g} role="radio" aria-checked={query.grouping === g} className={query.grouping === g ? "on" : undefined} onClick={() => update({ grouping: g })}>
                  {t(`library.groupBy.${g}`)}
                </button>
              ))}
            </span>
          )}
          <span className="library-views" role="group" aria-label={t("library.view")}>
            {(["grid", "list"] as LibraryView[]).map((v) => (
              <button
                key={v}
                className={`icon-button${query.view === v ? " on" : ""}`}
                aria-pressed={query.view === v}
                title={t(`library.views.${v}`)}
                aria-label={t(`library.views.${v}`)}
                onClick={() => update({ view: v })}
              >
                {v === "grid" ? <LayoutGrid size={15} strokeWidth={1.75} /> : <List size={15} strokeWidth={1.75} />}
              </button>
            ))}
          </span>
          <label className="library-select">
            <span>{t("library.sort")}</span>
            <select value={query.sort} onChange={(e) => update({ sort: e.target.value as SortKey })}>
              {(["updated", "created", "title"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`library.sortBy.${k}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {home && cards && cards.length > 0 && <TopicGrid byTopic={byTopic} when={when} />}
      {home && cards && cards.length > 0 && inView && (inView.length > 0 || topicCount === 0) && (
        <h2 className="library-section">{topicCount > 0 ? t("library.unfiled", { count: inView.length }) : t("library.cards")}</h2>
      )}
      {topic && inView?.length === 0 && <EmptyState icon={<Layers size={28} strokeWidth={1.5} />} title={t("topics.noCards")} hint={t("topics.noCardsHint")} />}
      {!topic && cards?.length === 0 && (
        <EmptyState
          icon={<LibraryBig size={28} strokeWidth={1.5} />}
          title={t("library.empty")}
          hint={isTouch() ? t("library.emptyHintTouch") : t("library.emptyHint", { key: keyLabel("Mod+N") })}
        />
      )}
      {(searching || query.edited !== "all") && inView && inView.length > 0 && shown.length === 0 && <p className="empty">{t("library.noMatch")}</p>}
      {shown.length > 0 && query.view === "grid" && (
        <ul className={`library-grid${selecting ? " selecting" : ""}`}>
          {shown.map((c) => (
            <li key={c.id} className={`library-tile${selected.has(c.id) ? " selected" : ""}`} draggable={!touch} onDragStart={(e) => dragCards(e, c.id)} onContextMenu={(e) => pressCard(e, c.id)}>
              <button className="library-tile-open" onClick={(e) => clickCard(c, e)}>
                <span className={`library-title${c.title ? "" : " untitled"}`}>{c.title || t("library.untitled")}</span>
                <span className="library-tile-text">{c.preview || t("library.noText")}</span>
                <time className="library-tile-date" title={t("library.sortBy.updated")}>
                  {when(c.updatedAt)}
                </time>
              </button>
              <input
                type="checkbox"
                className="library-check"
                checked={selected.has(c.id)}
                aria-label={t("library.select", { title: c.title || t("library.untitled") })}
                onClick={(e) => toggle(c.id, e.shiftKey)}
                readOnly
              />
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && query.view === "list" && (
        <ul className={`library-list${selecting ? " selecting" : ""}`}>
          {shown.map((c) => (
            <li key={c.id} className={`library-row${selected.has(c.id) ? " selected" : ""}`} draggable={!touch} onDragStart={(e) => dragCards(e, c.id)} onContextMenu={(e) => pressCard(e, c.id)}>
              <input
                type="checkbox"
                className="library-check"
                checked={selected.has(c.id)}
                aria-label={t("library.select", { title: c.title || t("library.untitled") })}
                onClick={(e) => toggle(c.id, e.shiftKey)}
                readOnly
              />
              <button className="library-open" onClick={(e) => clickCard(c, e)}>
                <span className={`library-title${c.title ? "" : " untitled"}`}>{c.title || t("library.untitled")}</span>
                {c.preview && <span className="library-preview">{c.preview}</span>}
              </button>
              <span className="library-dates">
                <time title={t("library.sortBy.updated")}>{when(c.updatedAt)}</time>
                <time className="created" title={t("library.sortBy.created")}>
                  {t("library.createdOn", { date: when(c.createdAt) })}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
