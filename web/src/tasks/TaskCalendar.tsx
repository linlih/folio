import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskRow } from "../bindings/commands";
import { addDays } from "../docs/ids";
import { usePhone } from "../shell/phone";
import { useShell } from "../shell/tabs";
import { CLOSED, moveTask } from "./actions";
import { addMonths, byDay, firstDayOfWeek, monthOf, weekOf } from "./calendar";
import { dueDate } from "./group";
import { TaskItem } from "./TaskItem";

/** Chips shown in a day of the month before "+N". */
const CHIPS = 3;

/** Open tasks on a month (or, first on a phone, a week): each day shows
 *  its tasks; a day picked lists them, each with a date button to move it.
 *  On a computer a task can be dragged to another day. Tasks with no date
 *  wait below, to be given one. */
export function TaskCalendar({ rows, today, onChange }: { rows: TaskRow[]; today: string; onChange: (was: TaskRow, now: TaskRow | null) => void }) {
  const { t, i18n } = useTranslation();
  const phone = usePhone();
  const [view, setView] = useState<"month" | "week">(phone ? "week" : "month");
  const [selected, setSelected] = useState(today);
  const first = firstDayOfWeek(i18n.language);
  const days = view === "month" ? monthOf(selected, first) : weekOf(selected, first);
  const tasks = useMemo(() => byDay(rows), [rows]);
  const undated = rows.filter((r) => !dueDate(r));
  const fmt = useMemo(() => {
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.language, o);
    return { month: f({ year: "numeric", month: "long" }), weekday: f({ weekday: "short" }), day: f({ month: "long", day: "numeric", weekday: "long" }) };
  }, [i18n.language]);
  const asDate = (d: string) => {
    const [y, m, dd] = d.split("-").map(Number);
    return new Date(y, m - 1, dd);
  };
  const step = (n: number) => setSelected((d) => (view === "month" ? addMonths(d, n) : addDays(d, 7 * n)));

  const move = (row: TaskRow, date: string) =>
    moveTask(row, date).then(
      (now) => onChange(row, now),
      (e) => useShell.getState().setNotice(t("error.generic", { message: String(e) })),
    );

  const chip = (r: TaskRow) => (
    <span
      key={`${r.cardId}/${r.bid}`}
      className="cal-chip"
      data-overdue={(!CLOSED.has(r.status) && dueDate(r)! < today) || undefined}
      data-closed={CLOSED.has(r.status) || undefined}
      onPointerDown={(e) => startChipDrag(e, r, (date) => void move(r, date))}
    >
      {r.text || t("backlinks.emptyBlock")}
    </span>
  );

  const list = tasks.get(selected) ?? [];
  // Today also lists what is overdue (it may be in a month not shown).
  const late = selected === today ? rows.filter((r) => !CLOSED.has(r.status) && (dueDate(r) ?? "9999") < today) : [];
  const item = (r: TaskRow) => <TaskItem key={`${r.cardId}/${r.bid}`} row={r} today={today} onChange={(now) => onChange(r, now)} reschedule />;

  return (
    <div className="cal" data-view={view}>
      <div className="cal-bar">
        <button className="icon-button" aria-label={t(`tasks.prev.${view}`)} title={t(`tasks.prev.${view}`)} onClick={() => step(-1)}>
          <ChevronLeft size={17} />
        </button>
        <span className="cal-title">{fmt.month.format(asDate(selected))}</span>
        <button className="icon-button" aria-label={t(`tasks.next.${view}`)} title={t(`tasks.next.${view}`)} onClick={() => step(1)}>
          <ChevronRight size={17} />
        </button>
        <button className="button cal-today" onClick={() => setSelected(today)}>
          {t("journal.today")}
        </button>
        <div className="tasks-switch cal-views" role="tablist">
          {(["week", "month"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>
              {t(`tasks.view.${v}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="cal-grid" role="grid">
        {days.slice(0, 7).map((d) => (
          <span key={`h${d}`} className="cal-weekday" role="columnheader">
            {fmt.weekday.format(asDate(d))}
          </span>
        ))}
        {days.map((d) => {
          const own = tasks.get(d) ?? [];
          return (
            <button
              key={d}
              className="cal-day"
              data-date={d}
              data-today={d === today || undefined}
              data-outside={(view === "month" && d.slice(0, 7) !== selected.slice(0, 7)) || undefined}
              aria-pressed={d === selected}
              aria-label={`${fmt.day.format(asDate(d))}${own.length ? `, ${t("tasks.count", { count: own.length })}` : ""}`}
              onClick={() => !dragJustEnded() && setSelected(d)}
            >
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-chips">
                {own.slice(0, CHIPS).map(chip)}
                {own.length > CHIPS && <span className="cal-more">+{own.length - CHIPS}</span>}
              </span>
              {own.length > 0 && <span className="cal-dot">{own.length}</span>}
            </button>
          );
        })}
      </div>

      {late.length > 0 && (
        <section className="task-group cal-list" data-group="overdue">
          <h2>
            {t("tasks.group.overdue")}
            <span className="task-count">{late.length}</span>
          </h2>
          <ul className="task-list">{late.map(item)}</ul>
        </section>
      )}
      <section className="task-group cal-list">
        <h2>
          {fmt.day.format(asDate(selected))}
          <span className="task-count">{list.length}</span>
        </h2>
        {list.length ? <ul className="task-list">{list.map(item)}</ul> : <p className="page-meta cal-none">{t("tasks.dayEmpty")}</p>}
      </section>
      {undated.length > 0 && (
        <details className="task-group cal-undated">
          <summary>
            <h2>
              {t("tasks.group.undated")}
              <span className="task-count">{undated.length}</span>
            </h2>
          </summary>
          <p className="page-meta">{t(phone ? "tasks.undatedHintTouch" : "tasks.undatedHint")}</p>
          <ul className="task-list">{undated.map(item)}</ul>
        </details>
      )}
    </div>
  );
}

// ---- dragging a task to another day (mouse only: on a touch screen a
// drag scrolls; the date button moves it there) ----

let endedAt = 0;
/** A click right after a drag ends is the drag's, not a pick of the day. */
const dragJustEnded = () => Date.now() - endedAt < 250;

function startChipDrag(e: React.PointerEvent, row: TaskRow, drop: (date: string) => void) {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  // No text selection while dragging (WebKit starts one otherwise).
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  const target = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>(".cal-day[data-date]") ?? null;
  const onMove = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      ghost = document.createElement("div");
      ghost.className = "cal-chip cal-ghost";
      ghost.textContent = (e.currentTarget as HTMLElement | null)?.textContent ?? row.text;
      document.body.append(ghost);
      document.body.classList.add("cal-dragging");
    }
    ghost.style.left = `${ev.clientX + 8}px`;
    ghost.style.top = `${ev.clientY + 6}px`;
    const now = target(ev.clientX, ev.clientY);
    if (now !== over) {
      over?.removeAttribute("data-drop");
      now?.setAttribute("data-drop", "");
      over = now;
    }
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    over?.removeAttribute("data-drop");
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("cal-dragging");
    endedAt = Date.now();
    const date = target(ev.clientX, ev.clientY)?.dataset.date;
    if (date && date !== dueDate(row)) drop(date);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
