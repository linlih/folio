// One habit on one day: a tap checks it (a measured habit asks how much);
// the right-click menu, or a long press, also skips it or adds a note.

import { Popover } from "@base-ui/react/popover";
import { Check, Minus, Plus, StickyNote } from "lucide-react";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dayState, meets, type Habit } from "../docs/habits";
import { chooseFrom } from "../editor/outliner/popover";
import { habitStart, setCheck, setNote, toggle } from "./store";

type Asking = null | "amount" | "note";

export function HabitDay({
  habit,
  date,
  today,
  variant = "cell",
  children,
}: {
  habit: Habit;
  date: string;
  today: string;
  /** A square in a row of days, a small square in a calendar, or a chip
   *  with the habit's name (the journal). */
  variant?: "cell" | "mini" | "chip";
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const state = dayState(habit, date, today, habitStart(habit));
  const value = habit.log[date];
  const amount = typeof value === "number" ? value : 0;
  const future = date > today;
  const measured = habit.target !== null;
  const note = habit.notes[date];

  const tap = () => {
    if (future) return;
    if (measured) setAsking("amount");
    else void toggle(habit, date);
  };

  const menu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (future) return;
    const at = new DOMRect(e.clientX, e.clientY, 1, 1);
    const done = meets(habit, value);
    const choice = await chooseFrom({ getBoundingClientRect: () => at }, [
      ...(measured ? [{ value: "amount", label: t("habits.enterAmount") }] : [{ value: done ? "clear" : "done", label: t(done ? "habits.undo" : "habits.markDone") }]),
      { value: value === "skip" ? "clear" : "skip", label: t(value === "skip" ? "habits.unskip" : "habits.skip") },
      { value: "note", label: t(note ? "habits.editNote" : "habits.addNote") },
      ...(measured && value !== undefined && value !== "skip" ? [{ value: "clear", label: t("habits.clear") }] : []),
    ]);
    if (choice === "done") void setCheck(habit.id, date, measured ? habit.target : 1);
    else if (choice === "clear") void setCheck(habit.id, date, null);
    else if (choice === "skip") void setCheck(habit.id, date, "skip");
    else if (choice === "amount" || choice === "note") setAsking(choice);
  };

  const label = `${habit.name} · ${date} · ${t(`habits.state.${state}`)}${measured && amount ? ` · ${amount}/${habit.target} ${habit.unit}` : ""}${note ? ` · ${note}` : ""}`;

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`habit-day ${variant}`}
        data-state={state}
        data-color={habit.color}
        data-date={date}
        style={state === "partial" && habit.target ? ({ "--p": `${Math.min(100, (amount / habit.target) * 100)}%` } as CSSProperties) : undefined}
        disabled={future}
        aria-label={label}
        aria-pressed={state === "done"}
        title={label}
        onClick={tap}
        onContextMenu={(e) => void menu(e)}
      >
        {variant === "chip" ? (
          <>
            <span className="habit-day-box">{state === "done" ? <Check size={12} strokeWidth={3} /> : state === "skip" ? <Minus size={12} /> : null}</span>
            {children}
            {measured && (
              <span className="habit-day-amount">
                {amount}/{habit.target}
                {habit.unit && ` ${habit.unit}`}
              </span>
            )}
            {note && <StickyNote size={11} className="habit-day-note" />}
          </>
        ) : variant === "cell" ? (
          state === "done" ? (
            <Check size={15} strokeWidth={3} />
          ) : state === "skip" ? (
            <Minus size={14} />
          ) : state === "partial" ? (
            <span className="habit-day-num">{amount}</span>
          ) : null
        ) : null}
        {variant === "cell" && note && <span className="habit-day-dot" />}
      </button>
      {asking && (
        <Popover.Root open onOpenChange={(open) => !open && setAsking(null)}>
          <Popover.Portal>
            <Popover.Positioner className="habit-pop-positioner" anchor={ref} side="bottom" align="center" sideOffset={6}>
              <Popover.Popup className="popup habit-pop">
                {asking === "amount" ? (
                  <AmountForm habit={habit} initial={amount} onDone={(v) => (setAsking(null), v !== undefined && void setCheck(habit.id, date, v))} />
                ) : (
                  <NoteForm initial={note ?? ""} onDone={(v) => (setAsking(null), v !== undefined && void setNote(habit.id, date, v))} />
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}

const onEnter = (f: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
    e.preventDefault();
    f();
  }
};

/** How much of a measured habit was done: typed, or stepped. */
function AmountForm({ habit, initial, onDone }: { habit: Habit; initial: number; onDone: (v?: number | null) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial ? String(initial) : "");
  const n = Math.max(0, Number(text) || 0);
  const step = (d: number) => setText(String(Math.max(0, Math.round((n + d) * 100) / 100)));
  const save = () => onDone(n > 0 ? n : null);
  return (
    <div className="habit-amount">
      <div className="habit-pop-title">
        {habit.name}
        <small>{t(habit.limit === "atMost" ? "habits.atMostOf" : "habits.atLeastOf", { target: habit.target, unit: habit.unit })}</small>
      </div>
      <div className="habit-amount-row">
        <button type="button" className="icon-button" aria-label={t("habits.less")} onClick={() => step(-1)}>
          <Minus size={14} />
        </button>
        <input autoFocus inputMode="decimal" value={text} placeholder="0" onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))} onKeyDown={onEnter(save)} aria-label={t("habits.amount")} />
        <button type="button" className="icon-button" aria-label={t("habits.more")} onClick={() => step(1)}>
          <Plus size={14} />
        </button>
        {habit.unit && <span className="habit-amount-unit">{habit.unit}</span>}
      </div>
      <div className="habit-pop-actions">
        {habit.limit === "atLeast" && (
          <button type="button" className="button" onClick={() => onDone(habit.target)}>
            {t("habits.fill", { target: habit.target })}
          </button>
        )}
        <button type="button" className="button primary" onClick={save}>
          {t("dialog.save")}
        </button>
      </div>
    </div>
  );
}

function NoteForm({ initial, onDone }: { initial: string; onDone: (v?: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  return (
    <div className="habit-note">
      <textarea autoFocus rows={3} value={text} placeholder={t("habits.notePlaceholder")} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && onDone(text)} />
      <div className="habit-pop-actions">
        <button type="button" className="button primary" onClick={() => onDone(text)}>
          {t("dialog.save")}
        </button>
      </div>
    </div>
  );
}
