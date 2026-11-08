import { CalendarDays, ChevronRight, FileText, Hash, Layers, Plus, Search, TextQuote } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow, SearchFilter, SearchHit, TagInfo } from "../bindings/commands";
import { openTag } from "../editor/tag";
import { cardsChanged } from "../card/actions";
import { cardName, openAt } from "../card/reveal";
import { isJournalId } from "../docs/ids";
import { topicPath, useTopics } from "../docs/topics";
import { backend } from "../platform";
import { findCommands, type Command } from "../shell/commands";
import { keyLabel } from "../shell/shortcuts";
import { toSide, useShell } from "../shell/tabs";
import { filterNames, matches, usePinyin, withPinyinTitles } from "./pinyin";
import "./search.css";

/** A piece of text around the first match, with the match marked. */
export function snippet(text: string, query: string, room = 60): { before: string; match: string; after: string } {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return { before: text.slice(0, room * 2), match: "", after: "" };
  const start = Math.max(0, i - room);
  return {
    before: (start > 0 ? "…" : "") + text.slice(start, i),
    match: text.slice(i, i + q.length),
    after: text.slice(i + q.length, i + q.length + room * 2),
  };
}

/** Time filters: changed within the last so many days, or this year. */
const TIMES = ["any", "week", "month", "year"] as const;
type Time = (typeof TIMES)[number];

/** The filter bar's choices as the host's filter. */
export function toFilter(scope: SearchFilter["scope"], time: Time, tag: string, newest: boolean, now = new Date()): SearchFilter {
  const day = 86_400_000;
  const since =
    time === "week" ? now.getTime() - 7 * day : time === "month" ? now.getTime() - 30 * day : time === "year" ? new Date(now.getFullYear(), 0, 1).getTime() : null;
  return { scope, tag: tag || null, since, newestFirst: newest };
}

/** Whether the filter narrows anything (sorting alone does not). */
export const filtering = (f: SearchFilter) => (f.scope ?? "all") !== "all" || !!f.tag || f.since != null;

interface Row {
  key: string;
  icon: "card" | "journal" | "block" | "new" | "tag" | "command" | "topic";
  title: string;
  topicId?: string;
  hit?: SearchHit;
  command?: Command;
}

/** A query starting with > lists commands instead of searching; 》 is what
 *  the same key types in Chinese punctuation mode. */
const COMMAND_PREFIX = /^\s*[>》]/;

/** Global search (Cmd+K): card titles first, then blocks (design/ARCHITECTURE
 *  §8 M2). Enter opens the card, at the block for block hits. */
export function SearchPalette() {
  const { t, i18n } = useTranslation();
  const { searchOpen, setSearchOpen } = useShell();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  // Every card's title, to find by pinyin (the index matches as written).
  const [cards, setCards] = useState<CardRow[]>([]);
  const pinyin = usePinyin();
  const topics = useTopics((s) => s.topics);
  const [index, setIndex] = useState(0);
  const [scope, setScope] = useState<NonNullable<SearchFilter["scope"]>>("all");
  const [time, setTime] = useState<Time>("any");
  const [tag, setTag] = useState("");
  const [newest, setNewest] = useState(false);
  const filter = useMemo(() => toFilter(scope, time, tag, newest), [scope, time, tag, newest]);
  const filtered = filtering(filter);
  const dateFmt = useMemo(() => {
    const thisYear = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" });
    const other = new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "short", day: "numeric" });
    const year = new Date().getFullYear();
    return (ms: number) => (new Date(ms).getFullYear() === year ? thisYear : other).format(ms);
  }, [i18n.language]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!searchOpen) return;
    setQuery("");
    setHits([]);
    setIndex(0);
    setScope("all");
    setTime("any");
    setTag("");
    setNewest(false);
    backend.tags(500).then(setTags, () => setTags([]));
    backend.listCards(100_000).then(setCards, () => setCards([]));
    setTimeout(() => input.current?.focus());
  }, [searchOpen]);

  const commandMode = COMMAND_PREFIX.test(query);

  useEffect(() => {
    if (!searchOpen || commandMode) return;
    let stale = false;
    const timer = setTimeout(() => {
      backend.search(query, filtered && !query.trim() ? 100 : 40, filter).then((h) => !stale && (setHits(h), setIndex(0)), () => {});
    }, 90);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, searchOpen, commandMode, filter, filtered]);

  const rows = useMemo<Row[]>(() => {
    if (commandMode)
      return findCommands(query.replace(COMMAND_PREFIX, "")).map((c) => ({ key: `cmd:${c.id}`, icon: "command", title: t(`commands.${c.label}`), command: c }));
    // Tags whose name has the query (with or without its #), first.
    const tq = query.trim().replace(/^#/, "");
    const tagRows: Row[] = tq ? filterNames(tags, tq, (tag) => tag.name).slice(0, 5).map((tag) => ({ key: `tag:${tag.key}`, icon: "tag", title: tag.name })) : [];
    // Topics whose name or path ("AI › Course A") has the query, first.
    const q0 = query.trim();
    const topicRows: Row[] = q0
      ? topics
          .map((x) => ({ id: x.id, path: topicPath(topics, x.id) ?? x.name }))
          .filter((x) => matches(x.path, q0))
          .slice(0, 5)
          .map((x) => ({ key: `topic:${x.id}`, icon: "topic", title: x.path, topicId: x.id }))
      : [];
    // Narrowed or newest first: the host's results as they are (pinyin
    // matches know nothing of tags and times; topics and tags are no cards).
    const narrowed = filtered || filter.newestFirst;
    const found = narrowed ? hits : withPinyinTitles(hits, cards, query);
    const out: Row[] = [...(narrowed ? [] : topicRows), ...(narrowed ? [] : tagRows), ...found.map((h): Row => ({
      key: `${h.cardId}:${h.bid ?? ""}`,
      icon: h.bid ? "block" : isJournalId(h.cardId) ? "journal" : "card",
      title: cardName(h.cardId, h.cardTitle),
      hit: h,
    }))];
    const q = query.trim();
    if (q && !narrowed && !hits.some((h) => !h.bid && h.cardTitle === q)) out.push({ key: "new", icon: "new", title: t("search.newCard", { title: q }) });
    return out;
  }, [hits, cards, tags, topics, query, t, commandMode, pinyin, filtered, filter.newestFirst]);

  const close = () => setSearchOpen(false);

  /** `side`: Shift+Enter or Shift+click, open in the other pane. */
  const choose = async (row: Row | undefined, side = false) => {
    if (!row) return;
    close();
    if (row.command) {
      void row.command.run();
    } else if (row.topicId) {
      useShell.getState().openTopic(row.topicId, side);
    } else if (row.icon === "tag") {
      openTag(row.title, side);
    } else if (row.icon === "new") {
      const id = await backend.createCard(query.trim());
      cardsChanged();
      openAt(id, query.trim(), null, side);
    } else if (row.hit) openAt(row.hit.cardId, row.title, row.hit.bid, side);
  };

  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!searchOpen) return null;
  const icons = { card: FileText, journal: CalendarDays, block: TextQuote, new: Plus, tag: Hash, command: ChevronRight, topic: Layers };
  const sectionOf = (row: Row | undefined) =>
    !row ? null : row.icon === "block" ? "blocks" : row.icon === "tag" ? "tags" : row.icon === "topic" ? "topics" : row.icon === "command" ? "commands" : row.icon === "new" ? null : "cards";
  return (
    <div className="search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search-panel" role="dialog" aria-label={t("nav.search")}>
        <label className="search-field">
          <Search size={16} strokeWidth={1.75} />
          <input
            ref={input}
            value={query}
            placeholder={t("search.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, rows.length - 1));
              else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
              else if (e.key === "Enter") void choose(rows[index], toSide(e));
              else if (e.key === "Escape") close();
              else return;
              e.preventDefault();
            }}
          />
          <kbd>Esc</kbd>
        </label>
        {!commandMode && (
          <div className="search-filters">
            <div className="segmented" role="radiogroup" aria-label={t("search.filter.scope")}>
              {(["all", "cards", "journal"] as const).map((v) => (
                <button key={v} role="radio" aria-checked={scope === v} className={scope === v ? "on" : undefined} onClick={() => setScope(v)}>
                  {t(`search.filter.${v}`)}
                </button>
              ))}
            </div>
            <select className={`search-select${time !== "any" ? " on" : ""}`} value={time} aria-label={t("search.filter.time")} onChange={(e) => setTime(e.target.value as Time)}>
              {TIMES.map((v) => (
                <option key={v} value={v}>
                  {t(`search.filter.${v}`)}
                </option>
              ))}
            </select>
            <select className={`search-select${tag ? " on" : ""}`} value={tag} aria-label={t("search.filter.tag")} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t("search.filter.anyTag")}</option>
              {tags.map((x) => (
                <option key={x.key} value={x.key}>
                  #{x.name}
                </option>
              ))}
            </select>
            <select className={`search-select${newest ? " on" : ""}`} value={newest ? "newest" : "best"} aria-label={t("search.filter.sort")} onChange={(e) => setNewest(e.target.value === "newest")}>
              <option value="best">{t("search.filter.best")}</option>
              <option value="newest">{t("search.filter.newest")}</option>
            </select>
          </div>
        )}
        {!query.trim() && !filtered && <p className="search-hint">{t("search.commandHint")}</p>}
        {(query.trim() || filtered) && (
          <ul className="search-results" ref={list} role="listbox">
            {rows.length === 0 && <li className="search-empty">{t("search.none")}</li>}
            {rows.map((row, i) => {
              const Icon = icons[row.icon];
              const s = row.hit?.bid ? snippet(row.hit.text, query) : null;
              // Titles and blocks under their own headings, so a block that
              // reads like a title is not taken for another card.
              const section = sectionOf(row);
              const prevSection = sectionOf(rows[i - 1]);
              return (
                <li key={row.key}>
                  {section && section !== prevSection && <div className="search-section">{t(`search.${section}`)}</div>}
                  <button
                    className={`search-row${i === index ? " active" : ""}`}
                    onMouseEnter={() => setIndex(i)}
                    onClick={(e) => void choose(row, toSide(e))}
                  >
                    <Icon size={15} strokeWidth={1.75} />
                    <span className="search-main">
                      {s ? (
                        <span className="search-snippet">
                          {s.before}
                          <mark>{s.match}</mark>
                          {s.after}
                        </span>
                      ) : (
                        <span className="search-title">{row.icon === "tag" ? `#${row.title}` : row.title}</span>
                      )}
                      {s && <span className="search-in">{t("search.inCard", { title: row.title })}</span>}
                    </span>
                    {row.hit?.updatedAt != null && <span className="search-date">{dateFmt(row.hit.updatedAt)}</span>}
                    {row.command?.combo && <kbd className="search-combo">{keyLabel(row.command.combo)}</kbd>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
