import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notes } from "../app";
import { localDate } from "../docs/ids";
import { useShell } from "../shell/tabs";
import "./capture.css";

/** Quick capture (design/ARCHITECTURE.md §8 M2): a small box that appends
 *  what you type to today's journal, one block per line. Opens with Cmd+E
 *  in the app, or Cmd+Shift+Space from anywhere on the desktop. */
const OPEN_EVENT = "folio:quick-capture";
/** Opens quick capture (the phone's capture button). */
export const openQuickCapture = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function QuickCapture() {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    let unlisten: (() => void) | null = null;
    if (isTauri()) {
      void import("@tauri-apps/api/event").then(({ listen }) => listen("quick-capture", () => setOpen(true))).then((u) => (unlisten = u));
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => field.current?.focus());
  }, [open]);

  const save = async () => {
    const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (lines.length === 0) return setOpen(false);
    try {
      await notes().appendToJournal(localDate(new Date()), lines, "human");
      setText("");
      setOpen(false);
      setNotice(t("capture.saved", { count: lines.length }));
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  };

  if (!open) return null;
  return (
    <div className="capture-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="capture-panel" role="dialog" aria-label={t("capture.title")}>
        <div className="capture-head">{t("capture.title")}</div>
        <textarea
          ref={field}
          value={text}
          placeholder={t("capture.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          rows={4}
        />
        <div className="capture-foot">
          <span>{t("capture.hint")}</span>
          <button className="button primary" onClick={() => void save()}>
            {t("capture.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
