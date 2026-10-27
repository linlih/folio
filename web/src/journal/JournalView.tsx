import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyMarkdown, exportCardMarkdown } from "../card/markdown";
import { useTranslation } from "react-i18next";
import { addDays, journalId, localDate } from "../docs/ids";
import type { Editor } from "@tiptap/core";
import { CardEditor } from "../editor/CardEditor";
import { belowText, continueAtEnd } from "../editor/outliner/feel";
import { extractExtension } from "../editor/extract";
import { openTag, TAG_STOP } from "../editor/tag";
import { toSide, useShell } from "../shell/tabs";
import { backend } from "../platform";
import "./journal.css";

const PAGE = 14;
/** Pixels before the end of the stream at which the next page loads. */
const LOAD_MARGIN = 400;
/** Days with a mounted editor at once (§5.2a); the rest show indexed text. */
const MAX_EDITORS = 5;
/** Days further than this from the visible part of the stream are only
 *  placeholders of their last height (§5.2a virtualisation). */
const RENDER_MARGIN = "1500px 0px";
/** A placeholder's height before its day was ever measured. */
const ESTIMATED_DAY_HEIGHT = 120;

function useToday() {
  const [today, setToday] = useState(() => localDate(new Date()));
  useEffect(() => {
    // The day changes at local midnight, or when the clock or time zone does.
    const check = () => setToday(localDate(new Date()));
    const timer = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

/** The continuous journal: today first, earlier days below (§0.2, §5.2a). */
export function JournalView() {
  const { t, i18n } = useTranslation();
  const open = useShell((s) => s.open);
  const today = useToday();
  const [count, setCount] = useState(PAGE);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  // Most recently used first; today starts with an editor.
  const [editing, setEditing] = useState<string[]>([today]);
  const sentinel = useRef<HTMLDivElement>(null);
  const editors = useRef(new Map<string, Editor>());
  const page = useRef<HTMLDivElement>(null);
  // Days near the visible part, rendered in full; their last heights.
  const [near, setNear] = useState<Set<string>>(() => new Set(Array.from({ length: PAGE }, (_, i) => addDays(today, -i))));
  const heights = useRef(new Map<string, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());

  /** A click on the empty part of a day's area writes at its end. */
  function clickArea(date: string, e: React.MouseEvent) {
    const editor = editors.current.get(date);
    if (!editor || editor.isDestroyed || !belowText(editor, e)) return;
    e.preventDefault();
    continueAtEnd(editor, true);
  }

  const days = Array.from({ length: count }, (_, i) => addDays(today, -i));
  const oldest = days[days.length - 1];

  const loadTexts = useCallback(async (from: string, to: string) => {
    const rows = await backend.journalDays(from, to);
    setTexts((prev) => {
      const next = new Map(prev);
      for (let d = from; d <= to; d = addDays(d, 1)) next.delete(d);
      for (const r of rows) next.set(r.date, r.text);
      return next;
    });
  }, []);

  // Each page of days is read once, when it is added; edited days are read
  // again when their editor goes (edit, below).
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    const from = oldest;
    const to = loaded.current && loaded.current > from && loaded.current <= today ? addDays(loaded.current, -1) : today;
    loaded.current = from;
    void loadTexts(from, to);
  }, [oldest, today, loadTexts]);

  // Which days are near the visible part of the stream.
  useEffect(() => {
    const root = page.current?.closest(".view") ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          let next: Set<string> | null = null;
          for (const e of entries) {
            const date = (e.target as HTMLElement).dataset.date!;
            if (e.isIntersecting === prev.has(date)) continue;
            next ??= new Set(prev);
            if (e.isIntersecting) next.add(date);
            else {
              heights.current.set(date, e.boundingClientRect.height);
              next.delete(date);
            }
          }
          return next ?? prev;
        });
      },
      { root, rootMargin: RENDER_MARGIN },
    );
    observer.current = io;
    sections.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const sectionRef = (date: string) => (el: HTMLElement | null) => {
    const known = sections.current.get(date);
    if (known && known !== el) observer.current?.unobserve(known);
    if (el) {
      sections.current.set(date, el);
      observer.current?.observe(el);
    } else sections.current.delete(date);
  };

  useEffect(() => {
    setEditing((e) => (e.includes(today) ? e : [today, ...e].slice(0, MAX_EDITORS)));
  }, [today]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // Relative to the tab's scroll area: the window's margin would not reach
    // past the area's clipping, and short windows would stop loading.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setCount((c) => c + PAGE);
    }, { root: el.closest(".view"), rootMargin: `${LOAD_MARGIN}px` });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The observer only reports changes: when a new page still leaves the end
  // of the stream in reach (a tall window, short days), load another.
  useEffect(() => {
    const el = sentinel.current;
    const root = el?.closest(".view");
    if (!el || !root) return;
    const frame = requestAnimationFrame(() => {
      // A hidden tab measures everything as 0: it would load forever.
      if (root.clientHeight === 0 || el.getClientRects().length === 0) return;
      if (el.getBoundingClientRect().top - root.getBoundingClientRect().bottom < LOAD_MARGIN) setCount((c) => c + PAGE);
    });
    return () => cancelAnimationFrame(frame);
  }, [count, near]);

  function edit(date: string) {
    setEditing((e) => {
      const next = [date, ...e.filter((d) => d !== date)];
      const evicted = next.slice(MAX_EDITORS);
      // An evicted editor saves on unmount; then its text is read back.
      for (const d of evicted) setTimeout(() => void loadTexts(d, d), 500);
      return next.slice(0, MAX_EDITORS);
    });
  }

  const thisYear = today.slice(0, 4);
  const heading = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Intl.DateTimeFormat(i18n.language, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: date.startsWith(thisYear) ? undefined : "numeric",
    }).format(new Date(y, m - 1, d));
  };

  return (
    <div className="page journal" ref={page}>
      {days.map((date) => {
        const text = texts.get(date);
        const live = editing.includes(date);
        if (!live && !near.has(date)) {
          return (
            <section
              key={date}
              ref={sectionRef(date)}
              data-date={date}
              className="journal-day placeholder"
              style={{ height: heights.current.get(date) ?? ESTIMATED_DAY_HEIGHT }}
              aria-hidden
            />
          );
        }
        return (
          <section key={date} ref={sectionRef(date)} data-date={date} className={`journal-day${date === today ? " today" : ""}`}>
            <h2 className="journal-date">
              {heading(date)}
              {date === today && <span className="journal-today">{t("journal.today")}</span>}
              <DayMenu date={date} />
            </h2>
            {live ? (
              <div className="journal-body" onMouseDown={(e) => clickArea(date, e)}>
                <CardEditor
                  docId={journalId(date)}
                  mode="outline"
                  placeholder={date === today ? t("journal.placeholder") : ""}
                  autoFocus={date !== today}
                  onOpenCard={(id, title, side) => open({ kind: "card", cardId: id }, title, side)}
                  extensions={(h) => [extractExtension(h)]}
                  onReady={(editor) => editors.current.set(date, editor)}
                />
              </div>
            ) : (
              <ReadOnlyDay text={text} onEdit={() => edit(date)} emptyLabel={t("journal.empty")} />
            )}
          </section>
        );
      })}
      <div ref={sentinel} className="journal-more" aria-hidden />
    </div>
  );
}

/** A day's actions, behind "⋯" on its date (shown on hover). */
function DayMenu({ date }: { date: string }) {
  const { t } = useTranslation();
  return (
    <Menu.Root>
      <Menu.Trigger className="icon-button journal-day-menu" aria-label={t("markdown.dayMenu")} title={t("markdown.dayMenu")}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="popup">
            <Menu.Item className="popup-item" onClick={() => void copyMarkdown(journalId(date))}>
              {t("markdown.copy")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => void exportCardMarkdown(journalId(date), date)}>
              {t("markdown.export")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A day without a mounted editor: the indexed text, one line per block;
 *  leading tabs are outline depth. A click starts editing. */
function ReadOnlyDay({ text, onEdit, emptyLabel }: { text?: string; onEdit: () => void; emptyLabel: string }) {
  const lines = text ? text.split("\n") : [];
  return (
    <div
      className="prose journal-static"
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onEdit())}
    >
      {lines.length === 0 ? (
        <p className="journal-empty">{emptyLabel}</p>
      ) : (
        lines.map((line, i) => {
          const depth = line.length - line.replace(/^\t+/, "").length;
          return (
            <div key={i} className="journal-line" style={{ paddingLeft: `${1.1 + depth * 1.4}em` }}>
              <LineText text={line.slice(depth)} />
            </div>
          );
        })
      )}
    </div>
  );
}

/** Tags in the indexed text (`#name`) look and open as in the editor. */
const TAG_IN_TEXT = new RegExp(`(^|\\s)#([^${TAG_STOP}]+)`, "g");

function LineText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TAG_IN_TEXT)) {
    const start = m.index + m[1].length;
    parts.push(text.slice(at, start));
    const name = m[2];
    parts.push(
      <span
        key={start}
        className="tag-pill"
        onClick={(e) => {
          e.stopPropagation();
          openTag(name, toSide(e));
        }}
      >
        #{name}
      </span>,
    );
    at = start + 1 + name.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
