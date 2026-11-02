// The habits (打卡) in the Tasks tab, centred on one day as Habitify,
// TickTick and Streaks are: a strip of the last days to pick it, then a
// card a habit with one button to check it; what is done moves below.
// Opened, a card shows the habit's streaks, strength and calendar.

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronRight, Flame, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { habitsForDay, habitStats, meets, weekday, weekStart, type Habit } from "../docs/habits";
import { addDays } from "../docs/ids";
import { EmptyState } from "../shell/EmptyState";
import { HabitDay } from "./HabitDay";
import { HabitForm } from "./HabitForm";
import { archiveHabit, deleteHabit, habitStart, moveHabit, setInJournal, useHabits } from "./store";
import "./habits.css";

/** Days in the strip. */
const DAYS = 7;
/** Weeks in a habit's calendar. */
const WEEKS = 18;

const finished = (h: Habit, day: string) => h.log[day] === "skip" || meets(h, h.log[day]);

export function HabitsView({ today }: { today: string }) {
  const { t } = useTranslation();
  const { habits, inJournal, loaded } = useHabits();
  const [editing, setEditing] = useState<Habit | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // A day picked yesterday is not kept past midnight.
  const day = picked && picked <= today ? picked : today;
  const active = habits.filter((h) => h.archivedAt === null);
  const archived = habits.filter((h) => h.archivedAt !== null);
  const due = habitsForDay(active, day, habitStart);
  const todo = due.filter((h) => !finished(h, day));
  const done = due.filter((h) => finished(h, day));
  const resting = active.filter((h) => !due.includes(h) && habitStart(h) <= day);

  const card = (h: Habit, i: number, list: Habit[], checkable = true) => (
    <HabitCard
      key={h.id}
      habit={h}
      day={day}
      today={today}
      checkable={checkable}
      open={openId === h.id}
      onToggle={() => setOpenId(openId === h.id ? null : h.id)}
      onEdit={() => setEditing(h)}
      onUp={i > 0 ? () => void moveHabit(h.id, list[i - 1].id) : undefined}
      onDown={i < list.length - 1 ? () => void moveHabit(h.id, list[i + 2]?.id ?? null) : undefined}
    />
  );
  // Moving is among all of them, in their order.
  const ordered = (list: Habit[]) => list.map((h) => card(h, active.indexOf(h), active));

  return (
    <div className="habits">
      <div className="habits-bar">
        <label className="habits-journal">
          <input type="checkbox" role="switch" className="switch" checked={inJournal} onChange={(e) => void setInJournal(e.target.checked)} />
          {t("habits.inJournal")}
        </label>
        <button className="button primary habits-new" onClick={() => setEditing("new")}>
          <Plus size={14} /> {t("habits.new")}
        </button>
      </div>
      {loaded && active.length === 0 && archived.length === 0 && (
        <EmptyState icon={<Repeat size={28} strokeWidth={1.5} />} title={t("habits.none")} hint={t("habits.noneHint")} />
      )}
      {active.length > 0 && (
        <>
          <DayStrip habits={active} day={day} today={today} onPick={setPicked} />
          <DaySummary due={due.length} done={done.length} day={day} today={today} />
          {todo.length > 0 && <div className="habit-cards">{ordered(todo)}</div>}
          {done.length > 0 && (
            <section className="habit-section" data-section="done">
              <h3>{t("habits.doneSection", { count: done.length })}</h3>
              <div className="habit-cards">{ordered(done)}</div>
            </section>
          )}
          {resting.length > 0 && (
            <section className="habit-section" data-section="rest">
              <h3>{t(day === today ? "habits.restToday" : "habits.restDay", { count: resting.length })}</h3>
              <div className="habit-cards">{resting.map((h) => card(h, active.indexOf(h), active, false))}</div>
            </section>
          )}
        </>
      )}
      {archived.length > 0 && (
        <section className="habit-section habits-archived">
          <button className="habits-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <ChevronRight size={13} /> {t("habits.archived", { count: archived.length })}
          </button>
          {showArchived && <div className="habit-cards">{archived.map((h, i) => card(h, i, archived, false))}</div>}
        </section>
      )}
      {editing && <HabitForm habit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** The last days, each with a bar of how much of it is done. */
function DayStrip({ habits, day, today, onPick }: { habits: Habit[]; day: string; today: string; onPick: (d: string) => void }) {
  const { t } = useTranslation();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));
  return (
    <div className="habit-strip" role="tablist" aria-label={t("habits.pickDay")}>
      {days.map((d) => {
        const due = habitsForDay(habits, d, habitStart);
        const done = due.filter((h) => finished(h, d)).length;
        const share = due.length ? done / due.length : 0;
        return (
          <button key={d} role="tab" aria-selected={d === day} className="habit-strip-day" data-today={d === today || undefined} data-all={(due.length > 0 && done === due.length) || undefined} onClick={() => onPick(d)}>
            <small>{d === today ? t("habits.today") : t(`habits.weekdays.${weekday(d)}`)}</small>
            <b>{Number(d.slice(8))}</b>
            <span className="habit-strip-bar" aria-label={`${done}/${due.length}`}>
              <span style={{ width: `${share * 100}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The picked day: its name and how much of it is done. */
function DaySummary({ due, done, day, today }: { due: number; done: number; day: string; today: string }) {
  const { t } = useTranslation();
  const name = day === today ? t("habits.today") : day === addDays(today, -1) ? t("habits.yesterday") : t("habits.dayName", { month: Number(day.slice(5, 7)), day: Number(day.slice(8)), weekday: t(`habits.weekdays.${weekday(day)}`) });
  return (
    <div className="habit-summary" data-all={(due > 0 && done === due) || undefined}>
      <h2>{name}</h2>
      <span>{due === 0 ? t("habits.nothingDue") : done === due ? t("habits.allDone") : t("habits.doneOf", { done, total: due })}</span>
    </div>
  );
}

function HabitCard({
  habit,
  day,
  today,
  checkable,
  open,
  onToggle,
  onEdit,
  onUp,
  onDown,
}: {
  habit: Habit;
  day: string;
  today: string;
  checkable: boolean;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { t } = useTranslation();
  const stats = habitStats(habit, today, habitStart(habit));
  const weekly = habit.schedule.kind === "weekly";
  const value = habit.log[day];
  const amount = typeof value === "number" ? value : 0;
  const measured = habit.target !== null;
  return (
    <div className="habit-card" data-color={habit.color} data-open={open || undefined} data-finished={(checkable && finished(habit, day)) || undefined} data-archived={habit.archivedAt !== null || undefined}>
      <div className="habit-card-line">
        {checkable && measured && (
          <span className="habit-card-progress" aria-hidden>
            <span style={{ width: `${Math.min(100, (amount / habit.target!) * 100)}%` }} />
          </span>
        )}
        <button className="habit-card-main" aria-expanded={open} onClick={onToggle}>
          <HabitBadge habit={habit} />
          <span className="habit-title">
            <span className="habit-title-text">{habit.name}</span>
            <span className="habit-meta">
              {checkable && measured ? (
                <span className="habit-amount-text">
                  {amount} / {habit.target} {habit.unit}
                </span>
              ) : (
                <span>{scheduleText(t, habit)}</span>
              )}
              {checkable && weekly && <span>{t("habits.weekOf", { done: stats.week.done, goal: stats.week.goal })}</span>}
              {stats.streak > 0 && (
                <span className="habit-streak">
                  <Flame size={11} /> {t(weekly ? "habits.streakWeeks" : "habits.streakDays", { count: stats.streak })}
                </span>
              )}
            </span>
          </span>
        </button>
        {checkable && <HabitDay habit={habit} date={day} today={today} />}
      </div>
      {open && (
        <div className="habit-detail" data-color={habit.color}>
          <div className="habit-stats">
            <Stat label={t("habits.stats.streak")} value={String(stats.streak)} unit={t(weekly ? "habits.weeksUnit" : "habits.daysUnit", { count: stats.streak })} />
            <Stat label={t("habits.stats.best")} value={String(stats.best)} unit={t(weekly ? "habits.weeksUnit" : "habits.daysUnit", { count: stats.best })} />
            <Stat label={t("habits.stats.strength")} value={`${Math.round(stats.strength * 100)}%`} bar={stats.strength} color={habit.color} />
            <Stat label={t("habits.stats.week")} value={`${stats.week.done}/${stats.week.goal}`} />
            <Stat label={t("habits.stats.total")} value={String(stats.total)} />
          </div>
          <Calendar habit={habit} today={today} />
          <div className="habit-legend" data-color={habit.color} aria-hidden>
            <span><i data-state="done" />{t("habits.state.done")}</span>
            <span><i data-state="partial" />{t("habits.state.partial")}</span>
            <span><i data-state="skip" />{t("habits.state.skip")}</span>
            <span><i data-state="missed" />{t("habits.state.missed")}</span>
          </div>
          <Notes habit={habit} />
          <div className="habit-actions">
            <button className="button" onClick={onEdit}>
              <Pencil size={13} /> {t("habits.edit")}
            </button>
            {onUp && (
              <button className="icon-button" title={t("habits.moveUp")} aria-label={t("habits.moveUp")} onClick={onUp}>
                <ArrowUp size={14} />
              </button>
            )}
            {onDown && (
              <button className="icon-button" title={t("habits.moveDown")} aria-label={t("habits.moveDown")} onClick={onDown}>
                <ArrowDown size={14} />
              </button>
            )}
            <span className="habit-actions-gap" />
            <button className="button" onClick={() => void archiveHabit(habit.id, habit.archivedAt === null ? Date.now() : null)}>
              {habit.archivedAt === null ? <Archive size={13} /> : <ArchiveRestore size={13} />} {t(habit.archivedAt === null ? "habits.archive" : "habits.unarchive")}
            </button>
            <DeleteButton onDelete={() => void deleteHabit(habit.id)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The habit's mark: its emoji, or its colour, on a tint of its colour. */
function HabitBadge({ habit }: { habit: Habit }) {
  return (
    <span className="habit-badge" data-color={habit.color} aria-hidden>
      {habit.icon ? <span className="habit-badge-icon">{habit.icon}</span> : <span className="habit-badge-dot" />}
    </span>
  );
}

function scheduleText(t: (k: string, o?: Record<string, unknown>) => string, h: Habit): string {
  const when =
    h.schedule.kind === "daily"
      ? t("habits.schedule.daily")
      : h.schedule.kind === "weekly"
        ? t("habits.timesAWeek", { count: h.schedule.times })
        : h.schedule.days.map((d) => t(`habits.weekdays.${d}`)).join(" ");
  if (h.target === null) return when;
  return `${when} · ${t(h.limit === "atMost" ? "habits.atMostOf" : "habits.atLeastOf", { target: h.target, unit: h.unit })}`;
}

function Stat({ label, value, unit, bar, color }: { label: string; value: string; unit?: string; bar?: number; color?: string }) {
  return (
    <div className="habit-stat">
      <span className="habit-stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <span className="habit-stat-label">{label}</span>
      {bar !== undefined && (
        <span className="habit-stat-bar" data-color={color}>
          <span style={{ width: `${Math.round(bar * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

/** The last weeks, a column a week (Monday on top), every day checkable. */
function Calendar({ habit, today }: { habit: Habit; today: string }) {
  const { t } = useTranslation();
  const first = addDays(weekStart(today), -7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, w) => addDays(first, w * 7));
  return (
    <div className="habit-cal" aria-label={t("habits.calendar")}>
      <div className="habit-cal-days" aria-hidden>
        {[1, 3, 5, 7].map((d) => (
          <span key={d} style={{ gridRow: d }}>
            {t(`habits.weekdays.${d}`)}
          </span>
        ))}
      </div>
      <div className="habit-cal-grid">
        {weeks.map((monday) => (
          <div key={monday} className="habit-cal-week">
            <span className="habit-cal-month" aria-hidden>
              {Number(monday.slice(8)) <= 7 ? t("habits.month", { month: Number(monday.slice(5, 7)) }) : ""}
            </span>
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(monday, i);
              return <HabitDay key={d} habit={habit} date={d} today={today} variant="mini" />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Notes({ habit }: { habit: Habit }) {
  const notes = Object.entries(habit.notes)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 5);
  if (notes.length === 0) return null;
  return (
    <ul className="habit-notes">
      {notes.map(([d, n]) => (
        <li key={d}>
          <time>{d}</time> {n}
        </li>
      ))}
    </ul>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const { t } = useTranslation();
  const [sure, setSure] = useState(false);
  return sure ? (
    <button className="button danger" autoFocus onBlur={() => setSure(false)} onClick={onDelete}>
      {t("habits.confirmDelete")}
    </button>
  ) : (
    <button className="icon-button" title={t("habits.delete")} aria-label={t("habits.delete")} onClick={() => setSure(true)}>
      <Trash2 size={14} />
    </button>
  );
}
