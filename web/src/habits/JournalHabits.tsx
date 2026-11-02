// The habits due on a journal day, checkable there; the Tasks tab's 打卡
// view turns this on or off for every device.

import { useTranslation } from "react-i18next";
import { habitsForDay } from "../docs/habits";
import { HabitDay } from "./HabitDay";
import { habitStart, useHabits } from "./store";
import "./habits.css";

export function JournalHabits({ date, today }: { date: string; today: string }) {
  const { t } = useTranslation();
  const { habits, inJournal } = useHabits();
  if (!inJournal || date > today) return null;
  const due = habitsForDay(habits, date, habitStart);
  if (due.length === 0) return null;
  return (
    <div className="journal-habits" role="group" aria-label={t("habits.title")}>
      {due.map((h) => (
        <HabitDay key={h.id} habit={h} date={date} today={today} variant="chip">
          {h.icon && <span className="habit-chip-icon">{h.icon}</span>}
          <span className="habit-chip-name">{h.name}</span>
        </HabitDay>
      ))}
    </div>
  );
}
