import { Brush, FolderInput, Inbox, Layers, LayoutGrid, List, Plus, Search, Trash2, X, LibraryBig } from "lucide-react";
import { isTouch } from "../shell/phone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { CARDS_CHANGED, moveManyToTrash } from "../card/actions";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { applyQuery, DEFAULT_QUERY, isEmptyCard, withoutUnsorted, type EditedWithin, type LibraryGrouping, type LibraryQuery, type LibraryView, type SortKey } from "./query";
import "./library.css";
import { EmptyState } from "../shell/EmptyState";
import { TopicPicker } from "../card/TopicRow";
import { moveCards, setCardsTopic, useTopics } from "../docs/topics";
import { subTopics } from "../docs/workspace";
import { CARDS_MIME } from "../card/drag";
import { SubTopicStrip, TopicGrid, TopicHeader } from "./TopicGrid";
import { keyLabel } from "../shell/shortcuts";
import { INBOX_CHANGED } from "../inbox/clip";

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
  const topics = useTopics((s) => s.topics);
  /** The sub-topics of the topic shown. */
  const subs = useMemo(() => (topic ? subTopics(topics, topic).map((x) => x.id) : []), [topics, topic]);
  /** Inside a topic with sub-topics: show their cards too. */
  const [withSubs, setWithSubs] = useState(false);
  /** Naming a new sub-topic (asked for from the topic's menu). */
  const [addingSub, setAddingSub] = useState(false);

  /** Links in the inbox, not dealt with yet: they wait there, not here. */
  const [unsorted, setUnsorted] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [all, inTopics, inbox] = await Promise.all([backend.listCards(5000), backend.cardTopicPairs(), backend.inbox()]);
      const { cards, waiting } = withoutUnsorted(all, inTopics, inbox);
      setCards(cards);
      setUnsorted(waiting);
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
  useEffect(() => {
    setSelected(new Set());
    setAddingSub(false);
  }, [topic]);

  // Titles and previews change in other tabs; read them again when shown.
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(CARDS_CHANGED, onChange);
    window.addEventListener(INBOX_CHANGED, onChange);
    return () => {
      window.removeEventListener(CARDS_CHANGED, onChange);
      window.removeEventListener(INBOX_CHANGED, onChange);
    };
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
  // The same with each topic's sub-topics' cards, each card once: for tiles.
  const deepByTopic = useMemo(() => {
    const out = new Map<string, CardRow[]>();
    for (const x of topics) {
      const seen = new Map<string, CardRow>();
      for (const id of [x.id, ...subTopics(topics, x.id).map((s) => s.id)]) for (const c of byTopic.get(id) ?? []) seen.set(c.id, c);
      out.set(x.id, [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    }
    return out;
  }, [topics, byTopic]);
  const topicCount = topics.filter((x) => !x.parent).length;
  /** With sub-topics' cards showing: the sub-topics each card is in. */
  const subOf = useMemo(() => {
    const out = new Map<string, string[]>();
    if (!withSubs) return out;
    const names = new Map(topics.filter((x) => subs.includes(x.id)).map((x) => [x.id, x.name]));
    for (const [card, x] of pairs) if (names.has(x)) out.set(card, [...(out.get(card) ?? []), names.get(x)!]);
    return out;
  }, [withSubs, topics, subs, pairs]);
  // Home with topics shows their tiles and the cards in none; a search
  // always looks through every card.
  const searching = query.text.trim() !== "";
  const home = !topic && query.grouping === "topics" && !searching;
  const inView = useMemo(() => {
    if (!cards) return null;
    if (topic) return (withSubs && subs.length > 0 ? deepByTopic : byTopic).get(topic) ?? [];
    if (!home) return cards;
    const filed = new Set(pairs.map(([c]) => c));
    return cards.filter((c) => !filed.has(c.id));
  }, [cards, topic, home, byTopic, deepByTopic, withSubs, subs, pairs]);
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
        {topic ? <TopicHeader topicId={topic} onNewSub={() => setAddingSub(true)} /> : <h1>{t("library.title")}</h1>}
        {cards && <span className="page-meta">{t("library.count", { count: topic ? (deepByTopic.get(topic)?.length ?? 0) : cards.length })}</span>}
        {!topic && unsorted > 0 && (
          <button className="library-inbox-note" onClick={() => useShell.getState().open({ kind: "inbox" })}>
            <Inbox size={13} />
            {t("library.inboxWaiting", { count: unsorted })}
          </button>
        )}
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
            <TopicPicker
              taken={[topic]}
              title={t("topics.moveCards")}
              onPick={(id) => {
                const chosen = [...selected];
                setSelected(new Set());
                // Out of this topic, and of its sub-topics when their cards show.
                void moveCards(chosen, withSubs ? [topic, ...subs] : [topic], id);
              }}
              className="button"
            >
              <FolderInput size={14} />
              {t("topics.moveCards")}
            </TopicPicker>
          )}
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

      {home && cards && cards.length > 0 && <TopicGrid byTopic={deepByTopic} when={when} />}
      {topic && !topics.find((x) => x.id === topic)?.parent && (subs.length > 0 || addingSub) && (
        <SubTopicStrip parent={topic} adding={addingSub} onAdded={() => setAddingSub(false)} />
      )}
      {topic && subs.length > 0 && (
        <span className="segmented topic-scope" role="radiogroup" aria-label={t("topics.scope")}>
          {[false, true].map((all) => (
            <button key={String(all)} role="radio" aria-checked={withSubs === all} className={withSubs === all ? "on" : undefined} onClick={() => setWithSubs(all)}>
              {all ? t("topics.scopeAll") : t("topics.scopeHere")}
              <span className="topic-scope-count">{(all ? deepByTopic : byTopic).get(topic)?.length ?? 0}</span>
            </button>
          ))}
        </span>
      )}
      {topic && subs.length > 0 && !withSubs && inView?.length === 0 && <p className="empty topic-here-empty">{t("topics.noDirectCards")}</p>}
      {home && cards && cards.length > 0 && inView && (inView.length > 0 || topicCount === 0) && (
        <h2 className="library-section">{topicCount > 0 ? t("library.unfiled", { count: inView.length }) : t("library.cards")}</h2>
      )}
      {topic && subs.length === 0 && inView?.length === 0 && <EmptyState icon={<Layers size={28} strokeWidth={1.5} />} title={t("topics.noCards")} hint={t("topics.noCardsHint")} />}
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
                <span className="library-tile-foot">
                  <time className="library-tile-date" title={t("library.sortBy.updated")}>
                    {when(c.updatedAt)}
                  </time>
                  {subOf.has(c.id) && <span className="library-tile-topic">{subOf.get(c.id)!.join(t("topics.sep"))}</span>}
                </span>
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
                {subOf.has(c.id) && <span className="library-tile-topic">{subOf.get(c.id)!.join(t("topics.sep"))}</span>}
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
