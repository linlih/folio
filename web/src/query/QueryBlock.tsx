// A query block in a card (design/query.md §4, §5.1): a title line with
// what it lists and how many, then the results, kept current as cards
// change. Tasks can be ticked and moved here; anything else opens where it
// was written.

import { Menu } from "@base-ui/react/menu";
import { ChevronRight, Filter, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow, QueryRows, TaskRow } from "../bindings/commands";
import { byCard, Group } from "../card/Backlinks";
import { CARDS_CHANGED } from "../card/actions";
import { cardName, openAt } from "../card/reveal";
import { useTemplates } from "../card/templates";
import { isJournalId, localDate } from "../docs/ids";
import { DOC_SAVED } from "../docs/persistence";
import { useTopics } from "../docs/topics";
import { dateLabel } from "../editor/outliner/gutter";
import { titleCache } from "../editor/refs";
import i18n from "../i18n";
import { backend } from "../platform";
import { toSide, useShell } from "../shell/tabs";
import { firstDayOfWeek } from "../tasks/calendar";
import { replaceRow, TaskItem } from "../tasks/TaskItem";
import { knownNames } from "./names";
import { QueryPanel, type PanelTab } from "./QueryPanel";
import { resolveQuery } from "./resolve";
import { MAX_LIMIT, readSpec, shownKind, type GroupKey, type QuerySpec } from "./spec";
import { summary } from "./summary";
import { format } from "./syntax";
import "./query.css";

const lang = () => (i18n.language?.startsWith("zh") ? "zh" : "en");

/** Redraws when card titles or topics come in (names in the summary). */
function useNamesVersion() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => titleCache.subscribe(bump), []);
  useTopics((s) => s.topics);
  return bump;
}

export function QueryBlock({
  raw,
  cardId,
  editable,
  openPanel = false,
  onChange,
}: {
  raw: string;
  cardId: string | null;
  editable: boolean;
  openPanel?: boolean;
  /** The new conditions, or null to delete the block. */
  onChange: (spec: QuerySpec | null) => void;
}) {
  const { t } = useTranslation();
  const { spec, newer } = useMemo(() => readSpec(raw), [raw]);
  const templates = useTemplates((s) => s.ids);
  useNamesVersion();
  const [panel, setPanel] = useState<PanelTab | null>(openPanel && editable ? "conds" : null);
  const [all, setAll] = useState(false);
  const [localCollapsed, setLocalCollapsed] = useState<boolean | null>(null);
  const collapsed = localCollapsed ?? !!spec?.view?.collapsed;
  const [rows, setRows] = useState<QueryRows | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Tasks ticked here stay, struck through, until the block is drawn anew.
  const kept = useRef(new Map<string, { row: TaskRow; at: number }>());

  const names = knownNames();
  const title = spec ? summary(spec, lang(), names) : "";

  const empty = !!spec && spec.where.length === 0 && !spec.show;
  const load = useCallback(() => {
    // A new query lists nothing until it asks for something.
    if (!spec || (spec.where.length === 0 && !spec.show)) return setRows(null);
    const today = localDate(new Date());
    const q = resolveQuery(spec, {
      cardId,
      day: cardId && isJournalId(cardId) ? cardId.slice(8) : null,
      today,
      firstDay: firstDayOfWeek(i18n.language),
      templates,
    });
    if (all) q.limit = MAX_LIMIT;
    backend.query(q).then(
      (r) => {
        const tasks = [...r.tasks];
        for (const { row, at } of kept.current.values()) if (!tasks.some((x) => x.cardId === row.cardId && x.bid === row.bid)) tasks.splice(Math.min(at, tasks.length), 0, row);
        setRows({ ...r, tasks });
        setFailed(null);
      },
      (e) => setFailed(String(e)),
    );
  }, [spec, cardId, templates, all]);

  // Live: again when cards change, once it is on screen.
  useEffect(() => {
    if (!spec || collapsed) return;
    let visible = false;
    let stale = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (!visible) return void (stale = true);
      stale = false;
      load();
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 300);
    };
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((es) => {
            visible = es.some((e) => e.isIntersecting);
            if (visible && stale) run();
          })
        : null;
    if (io && box.current) io.observe(box.current);
    else (visible = true), run();
    window.addEventListener(CARDS_CHANGED, later);
    window.addEventListener(DOC_SAVED, later);
    return () => {
      clearTimeout(timer);
      io?.disconnect();
      window.removeEventListener(CARDS_CHANGED, later);
      window.removeEventListener(DOC_SAVED, later);
    };
  }, [spec, collapsed, load]);

  if (newer || !spec)
    return (
      <div className="query-inner query-newer" ref={box}>
        <div className="query-head">
          <Filter size={14} className="query-icon" />
          <span className="query-title">{t("query.newer")}</span>
        </div>
      </div>
    );

  const kind = shownKind(spec);
  const shown = rows ? (kind === "tasks" ? rows.tasks.length : kind === "blocks" ? rows.blocks.length : rows.cards.length) : 0;
  const total = rows ? Math.max(rows.total, shown) : null;
  const toggle = () => {
    if (editable) onChange({ ...spec, view: { ...spec.view, collapsed: !collapsed } });
    setLocalCollapsed(editable ? null : !collapsed);
  };
  const copyText = () => {
    void navigator.clipboard?.writeText(format(spec, lang(), names)).then(() => useShell.getState().setNotice(t("query.copied")));
  };
  const onTask = (was: TaskRow, changed: TaskRow | null) => {
    if (!rows) return;
    const at = rows.tasks.findIndex((r) => r.cardId === was.cardId && r.bid === was.bid);
    if (changed) kept.current.set(`${changed.cardId}:${changed.bid}`, { row: changed, at });
    setRows({ ...rows, tasks: replaceRow(rows.tasks, was, changed) });
  };
  return (
    <div className="query-inner" ref={box} data-collapsed={collapsed || undefined}>
      <div className="query-head">
        <button className="query-fold icon-button" aria-expanded={!collapsed} aria-label={t(collapsed ? "query.unfold" : "query.fold")} onClick={toggle}>
          <ChevronRight size={14} className={collapsed ? "" : "open"} />
        </button>
        <button className="query-title-button" disabled={!editable} onClick={() => setPanel(panel ? null : "conds")} title={editable ? t("query.edit") : undefined}>
          <Filter size={13} className="query-icon" />
          <span className="query-title">{empty ? t("query.untitled") : title}</span>
          {total !== null && !empty && <span className="query-count">{total}</span>}
        </button>
        <Menu.Root>
          <Menu.Trigger className="icon-button query-more" aria-label={t("query.menu")} title={t("query.menu")}>
            <MoreHorizontal size={15} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4}>
              <Menu.Popup className="popup">
                {editable && (
                  <>
                    <Menu.Item className="popup-item" onClick={() => setPanel("conds")}>{t("query.edit")}</Menu.Item>
                    <Menu.Item className="popup-item" onClick={() => setPanel("display")}>{t("query.display")}</Menu.Item>
                  </>
                )}
                <Menu.Item className="popup-item" onClick={copyText}>{t("query.copyText")}</Menu.Item>
                <Menu.Item className="popup-item" onClick={load}>{t("query.refresh")}</Menu.Item>
                {editable && (
                  <>
                    <Menu.Separator className="popup-separator" />
                    <Menu.Item className="popup-item danger" onClick={() => onChange(null)}>{t("query.delete")}</Menu.Item>
                  </>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {!collapsed && (
        <div className="query-body">
          {failed && <p className="query-note">{t("error.generic", { message: failed })}</p>}
          {empty && !failed ? (
            <button className="query-note query-start" disabled={!editable} onClick={() => setPanel("conds")}>
              {t("query.startHint")}
            </button>
          ) : rows && shown === 0 ? (
            <button className="query-note query-empty" disabled={!editable} onClick={() => setPanel("conds")}>
              <span>{t(`query.empty.${kind}`)}</span>
              <span className="query-empty-sum">{title}</span>
            </button>
          ) : (
            rows && <Results spec={spec} rows={rows} cardId={cardId} onTask={onTask} />
          )}
          {rows && !empty && rows.total > shown && (
            <button className="query-all" onClick={() => setAll(true)}>
              {rows.total > MAX_LIMIT && all ? t("query.tooMany", { max: MAX_LIMIT }) : t("query.showAll", { count: rows.total })}
            </button>
          )}
        </div>
      )}
      {panel && editable && <QueryPanel spec={spec} tab={panel} onTab={setPanel} onChange={onChange} onClose={() => setPanel(null)} anchor={box} />}
    </div>
  );
}

/** Rows under headings by `by`, keeping their order. */
function grouped<T>(rows: T[], by: (r: T) => string): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = by(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out];
}

function taskGroup(r: TaskRow, by: GroupKey): string {
  const t = i18n.t.bind(i18n);
  if (by === "card") return cardName(r.cardId, r.cardTitle);
  if (by === "status") return t(`task.${r.status}`);
  const d = r.deadline ?? r.scheduled;
  return d ? dateLabel(d) : t("query.noDate");
}

function Results({ spec, rows, cardId, onTask }: { spec: QuerySpec; rows: QueryRows; cardId: string | null; onTask: (was: TaskRow, changed: TaskRow | null) => void }) {
  const kind = shownKind(spec);
  const today = localDate(new Date());
  if (kind === "tasks") {
    const list = (rs: TaskRow[]) => (
      <ul className="task-list">
        {rs.map((r) => (
          <TaskItem key={`${r.cardId}:${r.bid}`} row={r} today={today} onChange={(c) => onTask(r, c)} reschedule hideCard={r.cardId === cardId || spec.group === "card"} />
        ))}
      </ul>
    );
    if (!spec.group) return list(rows.tasks);
    return (
      <>
        {grouped(rows.tasks, (r) => taskGroup(r, spec.group!)).map(([head, rs]) => (
          <section key={head} className="query-group">
            <h4 className="query-group-head">{head}</h4>
            {list(rs)}
          </section>
        ))}
      </>
    );
  }
  if (kind === "blocks") {
    // A block shown under another one is not listed again on its own.
    const nested = new Set(rows.blocks.flatMap((r) => (r.children ?? []).map((c) => `${r.cardId}:${c.bid}`)));
    const shown = rows.blocks.filter((r) => !nested.has(`${r.cardId}:${r.bid}`));
    return (
      <section className="backlinks query-blocks">
        <ul>
          {byCard(shown).map((g) => (
            <Group key={g.cardId} group={g} />
          ))}
        </ul>
      </section>
    );
  }
  return (
    <ul className="query-cards">
      {rows.cards.map((c) => (
        <CardItem key={c.id} card={c} />
      ))}
    </ul>
  );
}

function CardItem({ card: c }: { card: CardRow }) {
  const title = cardName(c.id, c.title);
  return (
    <li>
      <button className="query-card" onClick={(e) => openAt(c.id, title, null, toSide(e))}>
        <span className="query-card-title">{title || i18n.t("library.untitled")}</span>
        {c.preview && <span className="query-card-preview">{c.preview}</span>}
        <span className="query-card-time">{dateLabel(localDate(new Date(c.updatedAt)))}</span>
      </button>
    </li>
  );
}
