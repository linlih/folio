import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HeatDay, LibraryStats } from "../bindings/commands";
import { addDays, localDate } from "../docs/ids";
import { useTopics } from "../docs/topics";
import { firstDayOfWeek } from "../tasks/calendar";
import { formatSize } from "../editor/assets";
import { backend } from "../platform";
import { usePhone } from "../shell/phone";
import { useShell } from "../shell/tabs";
import "../shell/dialog.css";
import "../settings/settings.css";
import "./stats.css";

/** Library statistics (design/stats.md): the totals, the last 30 days, the
 *  days written month by month, the main topics and the library's size.
 *  Opened from the card library's count. */
export function StatsDialog() {
  const { t } = useTranslation();
  const phone = usePhone();
  const setDialog = useShell((s) => s.setDialog);
  const today = localDate(new Date());
  // A year of days: the longest range the calendar shows, and enough for
  // the 30 days before the last 30.
  const from = useMemo(() => {
    const [y, m] = today.split("-").map(Number);
    return localDate(new Date(y, m - 12, 1));
  }, [today]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    backend.libraryStats(from).then(
      (s) => live && setStats(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [from]);

  const body = failed ? <p className="dialog-empty">{t("stats.failed")}</p> : stats ? <StatsBody stats={stats} today={today} phone={phone} /> : <p className="dialog-empty">…</p>;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className={`dialog stats-dialog${phone ? " settings phone" : ""}`}>
          {phone ? (
            <>
              <header className="settings-bar">
                <span />
                <Dialog.Title className="settings-bar-title">{t("stats.title")}</Dialog.Title>
                <Dialog.Close className="settings-done">{t("dialog.done")}</Dialog.Close>
              </header>
              <div className="settings-scroll stats-scroll">{body}</div>
            </>
          ) : (
            <>
              <header className="dialog-header">
                <Dialog.Title className="dialog-title">{t("stats.title")}</Dialog.Title>
                <Dialog.Close className="icon-button" aria-label={t("dialog.close")}>
                  <X size={15} />
                </Dialog.Close>
              </header>
              <div className="stats-scroll">{body}</div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Months the calendar can show; the choice is kept on this device. */
const RANGES = [3, 6, 12] as const;
type Range = (typeof RANGES)[number];
const RANGE_KEY = "folio.stats.months";

function savedRange(phone: boolean): Range {
  try {
    const n = Number(localStorage.getItem(RANGE_KEY));
    if ((RANGES as readonly number[]).includes(n)) return n as Range;
  } catch {
    // No storage (private window): the default.
  }
  return phone ? 3 : 6;
}

/** What the last 30 days hold, from the days `heat` lists. `change` is
 *  against the 30 days before, null when the library is younger than that. */
export function recentDays(heat: HeatDay[], today: string, firstDay: string | null) {
  const start = addDays(today, -29);
  const before = addDays(today, -59);
  const byDate = new Map(heat.map((d) => [d.date, d]));
  let cards = 0;
  let earlier = 0;
  let journal = 0;
  for (const d of heat) {
    if (d.date >= start && d.date <= today) {
      cards += d.cards;
      if (d.journal) journal++;
    } else if (d.date >= before && d.date < start) earlier += d.cards;
  }
  // The longest run of days with something recorded.
  let streak = 0;
  let run = 0;
  for (let i = 0; i < 30; i++) {
    const d = byDate.get(addDays(start, i));
    run = d && (d.cards > 0 || d.journal) ? run + 1 : 0;
    streak = Math.max(streak, run);
  }
  const change = firstDay !== null && firstDay <= before ? cards - earlier : null;
  return { cards, change, journal, streak };
}

function StatsBody({ stats, today, phone }: { stats: LibraryStats; today: string; phone: boolean }) {
  const { t, i18n } = useTranslation();
  const n = (x: number) => x.toLocaleString(i18n.language);
  const [range, setRange] = useState<Range>(() => savedRange(phone));
  const choose = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, String(r));
    } catch {
      // Kept for this time only.
    }
  };
  const recent = recentDays(stats.heat, today, stats.firstDay);
  const topics = useTopics((s) => s.topics);
  const counts = useTopics((s) => s.counts);
  const top = topics
    .map((x) => ({ id: x.id, name: x.name, cards: counts[x.id] ?? 0 }))
    .filter((x) => x.cards > 0)
    .sort((a, b) => b.cards - a.cards)
    .slice(0, 5);
  const most = top[0]?.cards ?? 1;
  const openTopic = (id: string) => {
    useShell.getState().setDialog(null);
    useShell.getState().openTopic(id);
  };

  return (
    <>
      {stats.firstDay && <p className="stats-since">{t("stats.sinceDays", { date: longDate(stats.firstDay, i18n.language), count: stats.daysRecorded })}</p>}
      <div className="stats-totals">
        <Total value={n(stats.cards)} label={t("stats.cards", { count: stats.cards })} />
        <Total value={n(stats.words)} label={t("stats.words", { count: stats.words })} />
        <Total value={n(stats.files)} label={t("stats.files", { count: stats.files })} />
      </div>

      <h3 className="stats-head">{t("stats.recent")}</h3>
      <div className="stats-recent">
        <div>
          <b>{n(recent.cards)}</b>
          {recent.change !== null && recent.change !== 0 && (
            <small className={recent.change > 0 ? "up" : "down"} title={t("stats.changeTitle")}>
              {recent.change > 0 ? "↑" : "↓"} {n(Math.abs(recent.change))}
            </small>
          )}
          <span>{t("stats.recentCards", { count: recent.cards })}</span>
        </div>
        <div>
          <b>{n(recent.journal)}</b>
          <span>{t("stats.recentJournal", { count: recent.journal })}</span>
        </div>
        <div>
          <b>{n(recent.streak)}</b>
          <span>{t("stats.recentStreak", { count: recent.streak })}</span>
        </div>
      </div>

      <h3 className="stats-head">
        <span>{t("stats.calendar")}</span>
        <span className="stats-range" role="group" aria-label={t("stats.range")}>
          {RANGES.map((r) => (
            <button key={r} aria-pressed={r === range} onClick={() => choose(r)}>
              {r === 12 ? t("stats.rangeYear") : t("stats.rangeMonths", { count: r })}
            </button>
          ))}
        </span>
      </h3>
      <Calendar heat={stats.heat} firstDay={stats.firstDay} today={today} months={range} />

      {top.length > 0 && (
        <>
          <h3 className="stats-head">{t("stats.topics")}</h3>
          <ul className="stats-topics">
            {top.map((x) => (
              <li key={x.id}>
                <button onClick={() => openTopic(x.id)}>
                  <em>{x.name}</em>
                  <span className="stats-bar" style={{ width: `${(x.cards / most) * 100}%` }} />
                  <span className="stats-n">{n(x.cards)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {stats.libraryBytes > 0 && (
        <p className="stats-usage">
          <span>{t("stats.usage", { size: formatSize(stats.libraryBytes) })}</span>
          {stats.fileBytes > 0 && <span>{t("stats.filesUsage", { size: formatSize(stats.fileBytes) })}</span>}
        </p>
      )}
    </>
  );
}

function longDate(date: string, lang: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" });
}

/** The last `months` months as small calendars, from the library's first
 *  month on: a darker day had more cards made, or its journal written. */
function Calendar({ heat, firstDay, today, months }: { heat: HeatDay[]; firstDay: string | null; today: string; months: number }) {
  const { t, i18n } = useTranslation();
  const weekStart = firstDayOfWeek(i18n.language) % 7;
  const byDate = new Map(heat.map((d) => [d.date, d]));
  // The day under the pointer (or tapped), said above it.
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: "start" | "mid" | "end" } | null>(null);
  const [ty, tm] = today.split("-").map(Number);
  let first = new Date(ty, tm - months, 1);
  if (firstDay) {
    const [fy, fm] = firstDay.split("-").map(Number);
    const own = new Date(fy, fm - 1, 1);
    if (own > first) first = own;
  }
  const shown: Date[] = [];
  for (let m = first; m <= new Date(ty, tm - 1, 1); m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) shown.push(m);

  const say = (date: string) => {
    const d = byDate.get(date);
    const [y, m, dd] = date.split("-").map(Number);
    const parts = [new Date(y, m - 1, dd).toLocaleDateString(i18n.language, { month: "long", day: "numeric", weekday: "short" })];
    if (d && d.cards > 0) parts.push(t("stats.dayCards", { count: d.cards }));
    if (d?.journal) parts.push(t("stats.dayJournal"));
    if (parts.length === 1) parts.push(t("stats.dayNone"));
    return parts.join(" · ");
  };
  const show = (e: React.PointerEvent | React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("i[data-date]");
    const box = e.currentTarget as HTMLElement;
    if (!cell) return setTip(null);
    const c = cell.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const x = c.left + c.width / 2 - b.left;
    // Near an edge the tip opens inwards, so the dialog never cuts it.
    const side = x < b.width * 0.25 ? "start" : x > b.width * 0.75 ? "end" : "mid";
    setTip({ text: say(cell.dataset.date!), x, y: c.top - b.top, side });
  };

  return (
    <div className="stats-calendar" onPointerMove={show} onClick={show} onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}>
      {shown.map((m) => {
        const lead = (m.getDay() - weekStart + 7) % 7;
        const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
        return (
          <div key={m.getTime()}>
            <h4>{m.toLocaleDateString(i18n.language, { year: "numeric", month: "long" })}</h4>
            <div className="stats-month">
              {Array.from({ length: lead }, (_, i) => (
                <i key={`b${i}`} className="blank" />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const date = localDate(new Date(m.getFullYear(), m.getMonth(), i + 1));
                if (date > today) return <i key={date} className="later" />;
                const d = byDate.get(date);
                const amount = d ? d.cards + (d.journal ? 1 : 0) : 0;
                const level = amount === 0 ? 0 : amount === 1 ? 1 : amount <= 3 ? 2 : 3;
                return <i key={date} data-date={date} className={`l${level}${date === today ? " today" : ""}`} aria-label={say(date)} />;
              })}
            </div>
          </div>
        );
      })}
      {tip && (
        <div className={`stats-tip ${tip.side}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function Total({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
