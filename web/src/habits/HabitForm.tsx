// Making or changing a habit: its name and mark, what counts as done
// (a check, or an amount against a target) and when it is due. Every
// choice is a row of buttons in the app's own style, not a system menu.

import { Dialog } from "@base-ui/react/dialog";
import { Minus, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HABIT_COLORS, type Habit, type HabitInput, type Schedule } from "../docs/habits";
import { createHabit, updateHabit } from "./store";
import "../shell/dialog.css";

const ICONS = ["📖", "🏃", "💧", "🧘", "💪", "🛌", "🥗", "✍️", "🚭", "☕", "🌱"];

export const blankHabit = (): HabitInput => ({ name: "", icon: "", color: HABIT_COLORS[0], schedule: { kind: "daily" }, target: null, unit: "", limit: "atLeast" });

/** A row of choices, one of them on. */
function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="habit-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="habit-field">
      <span className="habit-field-label">{label}</span>
      <div className="habit-field-control">{children}</div>
    </div>
  );
}

export function HabitForm({ habit, onClose }: { habit: Habit | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [h, setH] = useState<HabitInput>(habit ?? blankHabit());
  const [target, setTarget] = useState(habit?.target ?? 1);
  const set = (patch: Partial<HabitInput>) => setH((x) => ({ ...x, ...patch }));
  const measured = h.target !== null;
  const days = h.schedule.kind === "days" ? h.schedule.days : [];
  const setSchedule = (s: Schedule) => set({ schedule: s });
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
  const step = (d: number) => setTarget((n) => Math.max(1, Math.round((n + d) * 100) / 100));

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
          <Dialog.Description className="sr-only">{t("habits.formHint")}</Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="habit-form-top" data-color={h.color}>
              <span className="habit-form-preview" aria-hidden>
                {h.icon || <span className="habit-badge-dot" />}
              </span>
              <input className="habit-form-name" autoFocus value={h.name} placeholder={t("habits.namePlaceholder")} aria-label={t("habits.name")} onChange={(e) => set({ name: e.target.value })} />
            </div>

            <Field label={t("habits.icon")}>
              <div className="habit-form-icons" role="radiogroup" aria-label={t("habits.icon")}>
                <button type="button" role="radio" aria-checked={h.icon === ""} className="habit-form-noicon" onClick={() => set({ icon: "" })}>
                  {t("habits.noIcon")}
                </button>
                {ICONS.map((i) => (
                  <button key={i} type="button" role="radio" aria-checked={h.icon === i} onClick={() => set({ icon: i })}>
                    {i}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t("habits.color")}>
              <div className="habit-form-colors" role="radiogroup" aria-label={t("habits.color")}>
                {HABIT_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={h.color === c} aria-label={t(`habits.colors.${c}`)} data-color={c} onClick={() => set({ color: c })} />
                ))}
              </div>
            </Field>

            <Field label={t("habits.goal")}>
              <Segmented
                label={t("habits.goal")}
                value={measured ? "amount" : "check"}
                options={[
                  { value: "check", label: t("habits.kind.check") },
                  { value: "amount", label: t("habits.kind.amount") },
                ]}
                onChange={(v) => set({ target: v === "amount" ? target : null })}
              />
              {measured && (
                <div className="habit-form-target">
                  <Segmented
                    label={t("habits.limitLabel")}
                    value={h.limit}
                    options={[
                      { value: "atLeast", label: t("habits.atLeast") },
                      { value: "atMost", label: t("habits.atMost") },
                    ]}
                    onChange={(limit) => set({ limit })}
                  />
                  <div className="habit-stepper">
                    <button type="button" aria-label={t("habits.less")} onClick={() => step(-1)}>
                      <Minus size={13} />
                    </button>
                    <input
                      inputMode="decimal"
                      value={String(target)}
                      aria-label={t("habits.target")}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/[^\d.]/g, ""));
                        setTarget(Number.isFinite(n) ? n : 0);
                      }}
                    />
                    <button type="button" aria-label={t("habits.more")} onClick={() => step(1)}>
                      <Plus size={13} />
                    </button>
                  </div>
                  <input className="habit-form-unit" value={h.unit} placeholder={t("habits.unitPlaceholder")} aria-label={t("habits.unit")} onChange={(e) => set({ unit: e.target.value })} />
                </div>
              )}
            </Field>

            <Field label={t("habits.when")}>
              <Segmented
                label={t("habits.when")}
                value={h.schedule.kind}
                options={(["daily", "days", "weekly"] as const).map((k) => ({ value: k, label: t(`habits.schedule.${k}`) }))}
                onChange={(k) => setSchedule(k === "daily" ? { kind: "daily" } : k === "days" ? { kind: "days", days: days.length ? days : [1, 2, 3, 4, 5] } : { kind: "weekly", times: 3 })}
              />
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
                <div className="habit-form-times">
                  <Segmented
                    label={t("habits.schedule.weekly")}
                    value={h.schedule.times}
                    options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: n }))}
                    onChange={(times) => setSchedule({ kind: "weekly", times })}
                  />
                  <span className="habit-form-suffix">{t("habits.timesAfter")}</span>
                </div>
              )}
            </Field>

            <div className="habit-form-actions">
              <button type="button" className="button" onClick={onClose}>
                {t("dialog.cancel")}
              </button>
              <button type="submit" className="button primary" disabled={!valid}>
                {t(habit ? "dialog.save" : "habits.create")}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
