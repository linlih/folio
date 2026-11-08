import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { localDate } from "../docs/ids";
import { jumpToDay } from "../shell/journalJump";
import { useShell } from "../shell/tabs";
import { backend } from "../platform";
import { addMonths, firstDayOfWeek, monthOf } from "../tasks/calendar";

/** The calendar on the journal (§0.2 item 4): any day, past or future,
 *  opens in the journal; days with something written are marked. */
export function CalendarButton({ className, size = 15, children }: { className?: string; size?: number; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={className ?? "icon-button"} aria-label={t("journal.calendar")} title={t("journal.calendar")}>
        {children ?? <CalendarDays size={size} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={children ? "start" : "end"} sideOffset={6}>
          <Popover.Popup className="popup journal-calendar">
            <MonthCalendar
              onPick={(date) => {
                setOpen(false);
                useShell.getState().open({ kind: "journal" }, null);
                jumpToDay(date, null, true);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MonthCalendar({ onPick }: { onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const today = localDate(new Date());
  // The month shown, by its first day.
  const [shown, setShown] = useState(() => `${today.slice(0, 7)}-01`);
  const [written, setWritten] = useState<Set<string>>(new Set());
  const first = firstDayOfWeek(i18n.language);
  const grid = useMemo(() => monthOf(shown, first), [shown, first]);

  useEffect(() => {
    let stale = false;
    const from = grid[0];
    const to = grid[grid.length - 1];
    backend.journalDays(from, to).then(
      (days) => !stale && setWritten(new Set(days.filter((d) => d.lines?.length || d.text?.trim()).map((d) => d.date))),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [grid]);

  const title = new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long" }).format(new Date(`${shown}T12:00`));
  const weekday = new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" });
  const long = new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" });
  const go = (n: number) => setShown((m) => addMonths(m, n));
  const month = shown.slice(0, 7);

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="icon-button" aria-label={t("journal.prevYear")} title={t("journal.prevYear")} onClick={() => go(-12)}>
          <ChevronsLeft size={15} />
        </button>
        <button className="icon-button" aria-label={t("journal.prevMonth")} title={t("journal.prevMonth")} onClick={() => go(-1)}>
          <ChevronLeft size={15} />
        </button>
        <span className="calendar-title" aria-live="polite">
          {title}
        </span>
        <button className="icon-button" aria-label={t("journal.nextMonth")} title={t("journal.nextMonth")} onClick={() => go(1)}>
          <ChevronRight size={15} />
        </button>
        <button className="icon-button" aria-label={t("journal.nextYear")} title={t("journal.nextYear")} onClick={() => go(12)}>
          <ChevronsRight size={15} />
        </button>
      </div>
      <div className="calendar-grid" role="grid">
        {grid.slice(0, 7).map((d) => (
          <span key={`w${d}`} className="calendar-weekday" aria-hidden>
            {weekday.format(new Date(`${d}T12:00`))}
          </span>
        ))}
        {grid.map((d) => (
          <button
            key={d}
            className={`calendar-day${d.startsWith(month) ? "" : " outside"}${d === today ? " today" : ""}${written.has(d) ? " written" : ""}`}
            aria-label={long.format(new Date(`${d}T12:00`))}
            aria-current={d === today ? "date" : undefined}
            onClick={() => onPick(d)}
          >
            {Number(d.slice(8))}
          </button>
        ))}
      </div>
      <div className="calendar-foot">
        <button className="button" onClick={() => onPick(today)}>
          {t("journal.today")}
        </button>
      </div>
    </div>
  );
}
