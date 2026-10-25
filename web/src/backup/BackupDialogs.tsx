import { ArchiveRestore, FolderOpen, History } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { BackupInfo } from "../bindings/commands";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import "./backup.css";

function useWhen() {
  const { i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  return (ms: number) => fmt.format(ms);
}

const size = (bytes: number) => (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Settings → Backup and restore: the backups, back up now, and restoring
 *  the whole library (design/ARCHITECTURE.md §5.4). */
export function BackupsPanel() {
  const { t } = useTranslation();
  const when = useWhen();
  const setNotice = useShell((s) => s.setNotice);
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const reload = () => backend.listBackups().then(setList, (e) => setNotice(t("error.generic", { message: String(e) })));
  useEffect(() => void reload(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const backupNow = async () => {
    setBusy(true);
    try {
      await docs().flushAll();
      await backend.backupNow();
      await reload();
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const restoreAll = async (name: string) => {
    try {
      await docs().flushAll();
      await backend.restoreLibrary(name);
      // Everything open in memory belongs to the replaced library.
      window.location.reload();
    } catch (e) {
      setConfirm(null);
      setNotice(t("error.generic", { message: String(e) }));
    }
  };

  return (
    <>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy} onClick={() => void backupNow()}>
          <History size={14} />
          {t("backup.now")}
        </button>
        {backend.kind === "tauri" && (
          <button className="button" onClick={() => void backend.revealBackups()}>
            <FolderOpen size={14} />
            {t("backup.reveal")}
          </button>
        )}
      </div>
      {list?.length === 0 && <p className="dialog-empty">{t("backup.none")}</p>}
      {list && list.length > 0 && (
        <ul className="backup-list">
          {list.map((b) => (
            <li key={b.name} className="backup-row">
              <span className="backup-when">
                {when(b.createdAt)}
                {b.safety && <span className="backup-tag">{t(b.reason === "upgrade" ? "backup.upgrade" : "backup.safety")}</span>}
              </span>
              <span className="backup-size">{b.size > 0 ? size(b.size) : ""}</span>
              {confirm !== b.name && (
                <button
                  className="button"
                  disabled={backend.kind !== "tauri"}
                  title={backend.kind !== "tauri" ? t("settings.diagnosticsUnavailable") : undefined}
                  onClick={() => {
                    setConfirm(b.name);
                    setTyped("");
                  }}
                >
                  <ArchiveRestore size={14} />
                  {t("backup.restoreAll")}
                </button>
              )}
              {/* Replacing everything is rare and drastic: the warning says
                  what is lost, and the word must be typed to go ahead. */}
              {confirm === b.name && (
                <div className="backup-confirm">
                  <p>{t("backup.confirmAll", { date: when(b.createdAt) })}</p>
                  <div className="backup-confirm-actions">
                    <input
                      autoFocus
                      value={typed}
                      placeholder={t("backup.typeToConfirm", { word: t("backup.confirmWord") })}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && typed.trim() === t("backup.confirmWord") && void restoreAll(b.name)}
                    />
                    <button className="button" onClick={() => setConfirm(null)}>
                      {t("dialog.cancel")}
                    </button>
                    <button className="button danger" disabled={typed.trim() !== t("backup.confirmWord")} onClick={() => void restoreAll(b.name)}>
                      {t("backup.restoreAllNow")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
