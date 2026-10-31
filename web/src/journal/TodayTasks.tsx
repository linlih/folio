import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskRow } from "../bindings/commands";
import { CARDS_CHANGED } from "../card/actions";
import { journalId } from "../docs/ids";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { CLOSED } from "../tasks/actions";
import { dueDate } from "../tasks/group";
import { replaceRow, TaskItem } from "../tasks/TaskItem";
import "../tasks/tasks.css";

/** Open tasks due today or earlier, from other cards and days (today's own
 *  are in the editor above): under today's journal, as Logseq lists
 *  "scheduled and deadlines" (design/outliner.md "任务"). */
export function dueBy(rows: TaskRow[], today: string): TaskRow[] {
  const own = journalId(today);
  return rows
    .filter((r) => r.cardId !== own && !CLOSED.has(r.status) && (dueDate(r) ?? "9999") <= today)
    .sort((a, b) => dueDate(a)!.localeCompare(dueDate(b)!));
}

export function TodayTasks({ today }: { today: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<TaskRow[]>([]);
  // Read again whenever the journal is shown: tasks change in other tabs.
  const shown = useShell((s) => s.panes.some((p) => p.active === "journal"));
  const reload = useCallback(() => {
    backend.tasks(false).then((all) => setRows(dueBy(all, today)), () => {});
  }, [today]);
  useEffect(() => {
    if (shown) reload();
  }, [shown, reload]);
  useEffect(() => {
    window.addEventListener(CARDS_CHANGED, reload);
    return () => window.removeEventListener(CARDS_CHANGED, reload);
  }, [reload]);
  if (rows.length === 0) return null;
  const late = rows.filter((r) => dueDate(r)! < today).length;
  return (
    <section className="task-group today-tasks">
      <h2>
        {t("tasks.dueToday")}
        <span className="task-count">{rows.length}</span>
        {late > 0 && <span className="today-late">{t("tasks.late", { count: late })}</span>}
      </h2>
      <ul className="task-list">
        {rows.map((r) => (
          <TaskItem key={`${r.cardId}/${r.bid}`} row={r} today={today} onChange={(now) => setRows((rs) => replaceRow(rs, r, now))} />
        ))}
      </ul>
    </section>
  );
}
