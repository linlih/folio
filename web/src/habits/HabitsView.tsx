// The habits (打卡) in the Tasks tab: each with its last days to check at a
// glance (as in Loop), and opened, its streaks, strength and calendar.

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronRight, Flame, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { habitsForDay, habitStats, meets, weekStart, type Habit } from "../docs/habits";
import { addDays } from "../docs/ids";
import { EmptyState } from "../shell/EmptyState";
import { HabitDay } from "./HabitDay";
import { HabitForm } from "./HabitForm";
import { archiveHabit, deleteHabit, habitStart, moveHabit, setInJournal, useHabits } from "./store";
import "./habits.css";

/** Days shown in each row (the narrowest screens show fewer). */
const DAYS = 7;
/** Weeks in a habit's calendar. */
const WEEKS = 18;

export function HabitsView({ today }: { today: string }) {
  const { t } = useTranslation();
  const { habits, inJournal, loaded } = useHabits();
  const [editing, setEditing] = useState<Habit | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const active = habits.filter((h) => h.archivedAt === null);
  const archived = habits.filter((h) => h.archivedAt !== null);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));

  const row = (h: Habit, i: number, list: Habit[]) => (
    <HabitRow
      key={h.id}
      habit={h}
      days={days}
      today={today}
      open={openId === h.id}
      onToggle={() => setOpenId(openId === h.id ? null : h.id)}
      onEdit={() => setEditing(h)}
      onUp={i > 0 ? () => void moveHabit(h.id, list[i - 1].id) : undefined}
      onDown={i < list.length - 1 ? () => void moveHabit(h.id, list[i + 2]?.id ?? null) : undefined}
    />
  );

  return (
    <div className="habits">
      <div className="habits-bar">
        {active.length > 0 && <TodaySummary habits={active} today={today} />}
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
        <div className="habit-table" role="table" aria-label={t("habits.title")}>
          <div className="habit-head" role="row">
            <span role="columnheader" className="habit-head-name" />
            {days.map((d) => (
              <span key={d} role="columnheader" className="habit-head-day" data-today={d === today || undefined}>
                <small>{t(`habits.weekdays.${weekdayOf(d)}`)}</small>
                <b>{Number(d.slice(8))}</b>
              </span>
            ))}
          </div>
          {active.map(row)}
        </div>
      )}
      {archived.length > 0 && (
        <section className="habits-archived">
          <button className="habits-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <ChevronRight size={13} /> {t("habits.archived", { count: archived.length })}
          </button>
          {showArchived && <div className="habit-table">{archived.map(row)}</div>}
        </section>
      )}
      {editing && <HabitForm habit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const weekdayOf = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return ((new Date(y, m - 1, day).getDay() + 6) % 7) + 1;
};

function HabitRow({
  habit,
  days,
  today,
  open,
  onToggle,
  onEdit,
  onUp,
  onDown,
}: {
  habit: Habit;
  days: string[];
  today: string;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { t } = useTranslation();
  const stats = habitStats(habit, today, habitStart(habit));
  const weekly = habit.schedule.kind === "weekly";
  return (
    <div className="habit-row" role="rowgroup" data-open={open || undefined} data-archived={habit.archivedAt !== null || undefined}>
      <div className="habit-line" role="row">
        <button className="habit-name" role="rowheader" aria-expanded={open} onClick={onToggle}>
          <HabitBadge habit={habit} progress={stats.week.goal ? Math.min(1, stats.week.done / stats.week.goal) : 0} />
          <span className="habit-title">
            <span className="habit-title-text">{habit.name}</span>
            <span className="habit-meta">
              {scheduleText(t, habit)}
              {stats.streak > 0 && (
                <span className="habit-streak">
                  <Flame size={11} /> {t(weekly ? "habits.streakWeeks" : "habits.streakDays", { count: stats.streak })}
                </span>
              )}
            </span>
          </span>
        </button>
        {habit.archivedAt === null && days.map((d) => <HabitDay key={d} habit={habit} date={d} today={today} />)}
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

/** Today: how many of the habits due are done, as a bar. */
function TodaySummary({ habits, today }: { habits: Habit[]; today: string }) {
  const { t } = useTranslation();
  const due = habitsForDay(habits, today, habitStart);
  const done = due.filter((h) => meets(h, h.log[today])).length;
  if (due.length === 0) return <div className="habits-today">{t("habits.todayNone")}</div>;
  return (
    <div className="habits-today" data-all={done === due.length || undefined}>
      <span className="habits-today-text">{done === due.length ? t("habits.todayAll") : t("habits.todayProgress", { done, total: due.length })}</span>
      <span className="habits-today-bar">
        <span style={{ width: `${(done / due.length) * 100}%` }} />
      </span>
    </div>
  );
}

/** The habit's mark in a ring that fills as this week's goal is met. */
function HabitBadge({ habit, progress }: { habit: Habit; progress: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <span className="habit-badge" data-color={habit.color}>
      <svg viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r={r} className="habit-badge-track" />
        <circle cx="18" cy="18" r={r} className="habit-badge-fill" strokeDasharray={`${progress * c} ${c}`} />
      </svg>
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
