import { SquareCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { TaskRow } from "../bindings/commands";
import { CARDS_CHANGED } from "../card/actions";
import { cardName, openAt } from "../card/reveal";
import { setTaskDone, TASK_ORIGIN } from "../docs/card";
import { localDate } from "../docs/ids";
import { dateLabel } from "../editor/outliner/gutter";
import { PRIORITY_ICON, STATUS_ICON, type Priority, type TaskStatus } from "../editor/outliner/statusIcons";
import { backend } from "../platform";
import { EmptyState } from "../shell/EmptyState";
import { toSide, useShell } from "../shell/tabs";
import { groupTasks } from "./group";
import "./tasks.css";

const CLOSED = new Set(["done", "canceled"]);

/** Every task in the library (design/outliner.md "任务"), open ones by when
 *  they are due, or the closed ones; a row opens its line in its card, and
 *  its circle finishes it (or opens it again). */
export function TasksView({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [closed, setClosed] = useState(false);
  const [rows, setRows] = useState<TaskRow[] | null>(null);

  const reload = useCallback(() => {
    backend.tasks(closed).then(setRows, (e) => setNotice(t("error.generic", { message: String(e) })));
  }, [closed, setNotice, t]);

  // Tasks change in cards open in other tabs: read them again when shown.
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);
  useEffect(() => {
    window.addEventListener(CARDS_CHANGED, reload);
    return () => window.removeEventListener(CARDS_CHANGED, reload);
  }, [reload]);

  // Finished here, a task stays in the list (struck through) until the list
  // is read again, so a slip of the finger is one more click to undo.
  async function toggle(row: TaskRow) {
    const done = !CLOSED.has(row.status);
    const hub = docs();
    try {
      const h = await hub.open(row.cardId);
      try {
        if (!setTaskDone(h.doc, row.bid, done)) return reload();
        h.doc.commit({ origin: TASK_ORIGIN });
        await h.persistence.flush();
      } finally {
        await hub.release(row.cardId);
      }
      setRows((rs) => rs?.map((r) => (r.cardId === row.cardId && r.bid === row.bid ? { ...r, status: done ? "done" : "todo" } : r)) ?? null);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  }

  const today = localDate(new Date());
  const row = (r: TaskRow) => {
    const status = r.status as TaskStatus;
    const finished = CLOSED.has(r.status);
    return (
      <li key={`${r.cardId}/${r.bid}`} className="task-row" data-closed={finished || undefined}>
        <button
          className={`icon-button task-status status-${status}`}
          title={t(finished ? "tasks.reopen" : "tasks.finish")}
          aria-label={t(finished ? "tasks.reopen" : "tasks.finish")}
          onClick={() => void toggle(r)}
          dangerouslySetInnerHTML={{ __html: STATUS_ICON[status] ?? STATUS_ICON.todo }}
        />
        <button className="task-main" onClick={(e) => openAt(r.cardId, cardName(r.cardId, r.cardTitle), r.bid, toSide(e))}>
          <span className="task-text">
            {r.priority && PRIORITY_ICON[r.priority as Priority] && (
              <span className={`task-priority priority-${r.priority}`} title={t(`priority.${r.priority}`)} dangerouslySetInnerHTML={{ __html: PRIORITY_ICON[r.priority as Priority] }} />
            )}
            {r.text || t("backlinks.emptyBlock")}
          </span>
          <span className="task-meta">
            <span className="task-card">{cardName(r.cardId, r.cardTitle)}</span>
            {(["scheduled", "deadline"] as const).map(
              (k) =>
                r[k] && (
                  <span key={k} className={`ol-date ${k}`} data-overdue={(!finished && k === "deadline" && r[k]! < today) || undefined}>
                    {t(`task.${k}`)} {dateLabel(r[k]!)}
                  </span>
                ),
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="page tasks">
      <header className="page-header">
        <h1 data-page-title>{t("tasks.title")}</h1>
        <div className="tasks-switch" role="tablist">
          {([false, true] as const).map((c) => (
            <button key={String(c)} role="tab" aria-selected={closed === c} onClick={() => setClosed(c)}>
              {t(c ? "tasks.closed" : "tasks.open")}
            </button>
          ))}
        </div>
      </header>
      {rows?.length === 0 && (
        <EmptyState icon={<SquareCheck size={28} strokeWidth={1.5} />} title={t(closed ? "tasks.noneClosed" : "tasks.none")} hint={closed ? undefined : t("tasks.noneHint")} />
      )}
      {rows &&
        rows.length > 0 &&
        (closed ? (
          <ul className="task-list">{rows.map(row)}</ul>
        ) : (
          groupTasks(rows, today).map(([g, list]) => (
            <section key={g} className="task-group" data-group={g}>
              <h2>
                {t(`tasks.group.${g}`)}
                <span className="task-count">{list.length}</span>
              </h2>
              <ul className="task-list">{list.map(row)}</ul>
            </section>
          ))
        ))}
    </div>
  );
}
