import { FolderInput, FolderOpen, FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { LibraryLocation, PickedFolder } from "../bindings/commands";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";

type Pending = { mode: "move" | "open"; folder: PickedFolder } | { mode: "default"; target: string };

/** Settings → where the library is: show it in Finder, move it elsewhere,
 *  or open another library (design/ARCHITECTURE.md §5.7). Nothing changes
 *  until the user has read what will happen and confirmed. */
export function LibraryLocationRow() {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [where, setWhere] = useState<LibraryLocation | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void backend.libraryLocation().then(setWhere, () => {}), []);
  const desktop = backend.kind === "tauri" && where && !where.fixed;

  const pick = async (mode: "move" | "open") => {
    try {
      const folder = await backend.pickLibraryFolder(mode);
      setPending(folder ? { mode, folder } : null);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  };

  const go = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      // What is being typed belongs to the library open now.
      await docs().flushAll();
      if (pending.mode === "open") await backend.openLibrary(pending.folder.path);
      else await backend.moveLibrary("folder" in pending ? pending.folder.path : pending.target);
      // Everything in memory belongs to the library that was open.
      window.location.reload();
    } catch (e) {
      setBusy(false);
      setPending(null);
      setNotice(t("error.generic", { message: String(e) }));
    }
  };

  // What will happen, in words, before anything does.
  const message = (() => {
    if (!pending || !where) return null;
    if (pending.mode === "default") return { text: t("libraryPlace.confirmDefault", { path: pending.target }), action: t("libraryPlace.move"), cloud: false };
    const f = pending.folder;
    if (pending.mode === "move") {
      if (f.problem) return { text: t(`libraryPlace.problem.${f.problem}`, { path: f.path }), action: null, cloud: false };
      return { text: t("libraryPlace.confirmMove", { path: f.target }), action: t("libraryPlace.move"), cloud: f.cloudSynced };
    }
    if (f.path === where.path) return { text: t("libraryPlace.problem.current"), action: null, cloud: false };
    if (f.kind === "library") return { text: t("libraryPlace.confirmOpen", { path: f.path }), action: t("libraryPlace.open"), cloud: f.cloudSynced };
    if (f.kind === "empty") return { text: t("libraryPlace.confirmNew", { path: f.path }), action: t("libraryPlace.create"), cloud: f.cloudSynced };
    return { text: t("libraryPlace.problem.other"), action: null, cloud: false };
  })();

  return (
    <div className="settings-row place-row">
      <div className="settings-row-label">
        <span>{t("settings.dataDir")}</span>
        <code className="settings-value place-path" title={where?.path}>
          {where?.path ?? "…"}
        </code>
        {where?.missing && <small className="place-warning">{t("libraryPlace.missing", { path: where.missing })}</small>}
        {where?.cloudSynced && <small className="place-warning">{t("libraryPlace.cloudNow")}</small>}
        {where?.fixed && backend.kind === "tauri" && <small>{t("libraryPlace.fixed")}</small>}
      </div>
      {desktop && (
        <div className="settings-row-control place-actions">
          <button className="button" onClick={() => void backend.revealLibrary()}>
            <FolderOpen size={14} />
            {t("libraryPlace.reveal")}
          </button>
          <button className="button" disabled={busy} onClick={() => void pick("move")}>
            <FolderInput size={14} />
            {t("libraryPlace.moveTo")}
          </button>
          <button className="button" disabled={busy} onClick={() => void pick("open")}>
            <FolderSearch size={14} />
            {t("libraryPlace.openOther")}
          </button>
          {!where.isDefault && where.defaultPath && (
            <button className="button" disabled={busy} onClick={() => setPending({ mode: "default", target: where.defaultPath! })}>
              {t("libraryPlace.backToDefault")}
            </button>
          )}
        </div>
      )}
      {message && (
        <div className="place-confirm" role="alertdialog" aria-label={t("settings.dataDir")}>
          <p>{message.text}</p>
          {message.cloud && <p className="place-warning">{t("libraryPlace.cloudWarning")}</p>}
          <div className="place-confirm-actions">
            <button className="button" disabled={busy} onClick={() => setPending(null)}>
              {message.action ? t("dialog.cancel") : t("dialog.close")}
            </button>
            {message.action && (
              <button className="button primary" disabled={busy} onClick={() => void go()}>
                {busy ? t("libraryPlace.working") : message.action}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
