import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notes } from "../app";
import { dateLabel } from "../editor/outliner/gutter";
import { useShell } from "../shell/tabs";

/** Writes a task from the task page: into the journal of `date`, scheduled
 *  for that day, so it is listed under that day. Stays open for the next
 *  one; Escape (or the page's + again) puts it away. */
export function NewTask({ date, onDate, onAdded, onClose }: { date: string; onDate: (d: string) => void; onAdded: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  const save = async () => {
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      await notes().addTask(date, value, "human");
      setText("");
      onAdded();
    } catch (e) {
      useShell.getState().setNotice(t("error.generic", { message: String(e) }));
    } finally {
      setSaving(false);
      field.current?.focus();
    }
  };

  return (
    <div className="new-task">
      <span className="new-task-circle" aria-hidden />
      <input
        ref={field}
        value={text}
        placeholder={t("tasks.addPlaceholder")}
        aria-label={t("tasks.add")}
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter that ends a Chinese composition is the input method's.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      {/* The system's date picker, over the day's name. */}
      <label className="icon-button task-move" title={t("tasks.move")}>
        <span>{dateLabel(date)}</span>
        <input type="date" aria-label={t("tasks.move")} value={date} onChange={(e) => e.target.value && onDate(e.target.value)} />
      </label>
    </div>
  );
}
