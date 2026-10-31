import { useTranslation } from "react-i18next";
import type { TaskRow } from "../bindings/commands";
import { cardName, openAt } from "../card/reveal";
import { dateLabel } from "../editor/outliner/gutter";
import { PRIORITY_ICON, STATUS_ICON, type Priority, type TaskStatus } from "../editor/outliner/statusIcons";
import { useShell, toSide } from "../shell/tabs";
import { CLOSED, moveTask, toggleTask } from "./actions";

/** One task in a list: its circle finishes it (or opens it again), the
 *  rest opens its line in its card. With `reschedule`, a date button moves
 *  it to another day. `onChange` gets the row as it is after a change, or
 *  null when the task is no longer there. */
export function TaskItem({ row: r, today, onChange, reschedule = false, hideCard = false }: { row: TaskRow; today: string; onChange: (row: TaskRow | null) => void; reschedule?: boolean; hideCard?: boolean }) {
  const { t } = useTranslation();
  const status = r.status as TaskStatus;
  const finished = CLOSED.has(r.status);
  const fail = (e: unknown) => useShell.getState().setNotice(t("error.generic", { message: String(e) }));
  return (
    <li className="task-row" data-closed={finished || undefined}>
      <button
        className={`icon-button task-status status-${status}`}
        title={t(finished ? "tasks.reopen" : "tasks.finish")}
        aria-label={t(finished ? "tasks.reopen" : "tasks.finish")}
        onClick={() => toggleTask(r).then(onChange, fail)}
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
          {!hideCard && <span className="task-card">{cardName(r.cardId, r.cardTitle)}</span>}
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
      {reschedule && (
        // The system's date picker, over the button.
        <label className="icon-button task-move" title={t("tasks.move")}>
          <span>{t("tasks.move")}</span>
          <input
            type="date"
            aria-label={t("tasks.move")}
            value={r.deadline ?? r.scheduled ?? ""}
            onChange={(e) => e.target.value && moveTask(r, e.target.value).then(onChange, fail)}
          />
        </label>
      )}
    </li>
  );
}

/** A list's rows after `changed` (null: gone) replaced the row it was. */
export const replaceRow = (rows: TaskRow[], was: TaskRow, changed: TaskRow | null) =>
  changed ? rows.map((r) => (r.cardId === was.cardId && r.bid === was.bid ? changed : r)) : rows.filter((r) => !(r.cardId === was.cardId && r.bid === was.bid));
