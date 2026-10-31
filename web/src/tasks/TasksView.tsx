import { SquareCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskRow } from "../bindings/commands";
import { CARDS_CHANGED } from "../card/actions";
import { localDate } from "../docs/ids";
import { backend } from "../platform";
import { EmptyState } from "../shell/EmptyState";
import { useShell } from "../shell/tabs";
import { groupTasks } from "./group";
import { TaskCalendar } from "./TaskCalendar";
import { replaceRow, TaskItem } from "./TaskItem";
import "./tasks.css";

type Mode = "open" | "closed" | "calendar";
const MODES: Mode[] = ["open", "closed", "calendar"];

/** Every task in the library (design/outliner.md "任务"): open ones by when
 *  they are due, the closed ones, or open ones on a calendar. A row opens
 *  its line in its card, and its circle finishes it (or opens it again). */
export function TasksView({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [mode, setMode] = useState<Mode>("open");
  const [rows, setRows] = useState<TaskRow[] | null>(null);

  const reload = useCallback(() => {
    backend.tasks(mode === "closed").then(setRows, (e) => setNotice(t("error.generic", { message: String(e) })));
  }, [mode, setNotice, t]);

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
  const change = (was: TaskRow) => (now: TaskRow | null) => setRows((rs) => (rs ? replaceRow(rs, was, now) : rs));

  const today = localDate(new Date());
  const item = (r: TaskRow) => <TaskItem key={`${r.cardId}/${r.bid}`} row={r} today={today} onChange={change(r)} />;

  return (
    <div className="page tasks">
      <header className="page-header">
        <h1 data-page-title>{t("tasks.title")}</h1>
        <div className="tasks-switch" role="tablist">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {t(`tasks.${m}`)}
            </button>
          ))}
        </div>
      </header>
      {mode === "calendar" && rows && <TaskCalendar rows={rows} today={today} onChange={(was, now) => change(was)(now)} />}
      {mode !== "calendar" && rows?.length === 0 && (
        <EmptyState icon={<SquareCheck size={28} strokeWidth={1.5} />} title={t(mode === "closed" ? "tasks.noneClosed" : "tasks.none")} hint={mode === "closed" ? undefined : t("tasks.noneHint")} />
      )}
      {mode === "closed" && rows && rows.length > 0 && <ul className="task-list">{rows.map(item)}</ul>}
      {mode === "open" &&
        rows &&
        groupTasks(rows, today).map(([g, list]) => (
          <section key={g} className="task-group" data-group={g}>
            <h2>
              {t(`tasks.group.${g}`)}
              <span className="task-count">{list.length}</span>
            </h2>
            <ul className="task-list">{list.map(item)}</ul>
          </section>
        ))}
    </div>
  );
}
