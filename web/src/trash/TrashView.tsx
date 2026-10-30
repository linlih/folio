import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { CARDS_CHANGED, cardsChanged } from "../card/actions";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { EmptyState } from "../shell/EmptyState";

export function TrashView() {
  const { t, i18n } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [rows, setRows] = useState<CardRow[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(() => {
    backend.listTrash().then(setRows, (e) => setNotice(t("error.generic", { message: String(e) })));
  }, [setNotice, t]);

  useEffect(() => {
    reload();
    window.addEventListener(CARDS_CHANGED, reload);
    return () => window.removeEventListener(CARDS_CHANGED, reload);
  }, [reload]);

  async function restore(row: CardRow) {
    await backend.restoreCard(row.id);
    setNotice(t("trash.restored", { title: row.title || t("library.untitled") }));
    cardsChanged();
  }

  // Deleting for good has no undo (§5.4), so it asks first.
  async function empty() {
    setConfirming(false);
    try {
      const gone = await backend.emptyTrash();
      const shell = useShell.getState();
      for (const id of gone) shell.forgetCard(id);
      setNotice(t("trash.emptied", { count: gone.length }));
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
    cardsChanged();
  }

  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="page trash">
      <header className="page-header">
        <h1>{t("trash.title")}</h1>
        {rows && rows.length > 0 && !confirming && (
          <button className="button danger" onClick={() => setConfirming(true)}>
            <Trash2 size={13} />
            {t("trash.emptyTrash")}
          </button>
        )}
        {confirming && rows && (
          <div className="topic-confirm">
            <p>{t("trash.emptyConfirm", { count: rows.length })}</p>
            <button className="button" onClick={() => setConfirming(false)}>
              {t("dialog.cancel")}
            </button>
            <button className="button danger" onClick={() => void empty()}>
              {t("trash.emptyTrash")}
            </button>
          </div>
        )}
      </header>
      {rows?.length === 0 && <EmptyState icon={<Trash2 size={28} strokeWidth={1.5} />} title={t("trash.empty")} hint={t("trash.emptyHint")} />}
      {rows && rows.length > 0 && (
        <>
          <p className="page-meta trash-hint">{t("trash.autoHint")}</p>
          <ul className="card-list">
            {rows.map((c) => (
              <li key={c.id} className="card-row static">
                <span className="card-title">{c.title || t("library.untitled")}</span>
                {c.preview && <span className="card-preview">{c.preview}</span>}
                <span className="card-time">
                  <time>{date.format(c.updatedAt)}</time>
                  <button className="button" onClick={() => void restore(c)}>
                    <RotateCcw size={13} />
                    {t("trash.restore")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
