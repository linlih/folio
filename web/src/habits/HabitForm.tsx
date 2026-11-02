// Making or changing a habit: its name and mark, what counts as done
// (a check, or an amount against a target) and when it is due.

import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HABIT_COLORS, type Habit, type HabitInput, type Schedule } from "../docs/habits";
import { createHabit, updateHabit } from "./store";
import "../shell/dialog.css";

const ICONS = ["📖", "🏃", "💧", "🧘", "💪", "🛌", "🥗", "✍️", "🎸", "🚭", "☕", "🌱"];

export const blankHabit = (): HabitInput => ({ name: "", icon: "", color: HABIT_COLORS[0], schedule: { kind: "daily" }, target: null, unit: "", limit: "atLeast" });

export function HabitForm({ habit, onClose }: { habit: Habit | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [h, setH] = useState<HabitInput>(habit ?? blankHabit());
  const [targetText, setTargetText] = useState(habit?.target ? String(habit.target) : "");
  const set = (patch: Partial<HabitInput>) => setH((x) => ({ ...x, ...patch }));
  const measured = h.target !== null;
  const days = h.schedule.kind === "days" ? h.schedule.days : [];
  const setSchedule = (s: Schedule) => set({ schedule: s });
  const target = Number(targetText);
  const valid = h.name.trim() !== "" && (!measured || target > 0) && (h.schedule.kind !== "days" || days.length > 0);

  const save = async () => {
    if (!valid) return;
    let schedule = h.schedule;
    // Every day of the week chosen is every day.
    if (schedule.kind === "days" && schedule.days.length === 7) schedule = { kind: "daily" };
    const out = { ...h, schedule, target: measured ? target : null };
    if (habit) await updateHabit(habit.id, out);
    else await createHabit(out);
    onClose();
  };

  const toggleDay = (d: number) => setSchedule({ kind: "days", days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort() });

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog habit-form">
          <header className="dialog-header">
            <Dialog.Title className="dialog-title">{t(habit ? "habits.edit" : "habits.new")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("dialog.close")}>
              <X size={15} />
            </Dialog.Close>
          </header>
          <Dialog.Description className="dialog-description">{t("habits.formHint")}</Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="habit-form-name">
              <input className="habit-form-icon" value={h.icon} maxLength={4} placeholder="🙂" aria-label={t("habits.icon")} onChange={(e) => set({ icon: e.target.value })} />
              <input autoFocus value={h.name} placeholder={t("habits.namePlaceholder")} aria-label={t("habits.name")} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="habit-form-icons">
              {ICONS.map((i) => (
                <button key={i} type="button" aria-pressed={h.icon === i} onClick={() => set({ icon: h.icon === i ? "" : i })}>
                  {i}
                </button>
              ))}
            </div>
            <div className="habit-form-colors" role="radiogroup" aria-label={t("habits.color")}>
              {HABIT_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={h.color === c} aria-label={t(`habits.colors.${c}`)} data-color={c} onClick={() => set({ color: c })} />
              ))}
            </div>

            <fieldset className="habit-form-field">
              <legend>{t("habits.goal")}</legend>
              <div className="habit-seg" role="radiogroup">
                <button type="button" role="radio" aria-checked={!measured} onClick={() => set({ target: null })}>
                  {t("habits.kind.check")}
                </button>
                <button type="button" role="radio" aria-checked={measured} onClick={() => (set({ target: target > 0 ? target : 1 }), !targetText && setTargetText("1"))}>
                  {t("habits.kind.amount")}
                </button>
              </div>
              {measured && (
                <div className="habit-form-target">
                  <select value={h.limit} aria-label={t("habits.limitLabel")} onChange={(e) => set({ limit: e.target.value as HabitInput["limit"] })}>
                    <option value="atLeast">{t("habits.atLeast")}</option>
                    <option value="atMost">{t("habits.atMost")}</option>
                  </select>
                  <input inputMode="decimal" value={targetText} aria-label={t("habits.target")} onChange={(e) => setTargetText(e.target.value.replace(/[^\d.]/g, ""))} />
                  <input value={h.unit} placeholder={t("habits.unitPlaceholder")} aria-label={t("habits.unit")} onChange={(e) => set({ unit: e.target.value })} />
                  <span>{t("habits.perDay")}</span>
                </div>
              )}
            </fieldset>

            <fieldset className="habit-form-field">
              <legend>{t("habits.when")}</legend>
              <div className="habit-seg" role="radiogroup">
                {(["daily", "days", "weekly"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={h.schedule.kind === k}
                    onClick={() => setSchedule(k === "daily" ? { kind: "daily" } : k === "days" ? { kind: "days", days: days.length ? days : [1, 2, 3, 4, 5] } : { kind: "weekly", times: 3 })}
                  >
                    {t(`habits.schedule.${k}`)}
                  </button>
                ))}
              </div>
              {h.schedule.kind === "days" && (
                <div className="habit-form-days">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>
                      {t(`habits.weekdays.${d}`)}
                    </button>
                  ))}
                </div>
              )}
              {h.schedule.kind === "weekly" && (
                <label className="habit-form-times">
                  {t("habits.timesBefore")}
                  <select value={h.schedule.times} onChange={(e) => setSchedule({ kind: "weekly", times: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  {t("habits.timesAfter")}
                </label>
              )}
            </fieldset>

            <div className="dialog-actions">
              <button type="button" className="button" onClick={onClose}>
                {t("dialog.cancel")}
              </button>
              <button type="submit" className="button primary" disabled={!valid}>
                {t("dialog.save")}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
