import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell } from "../shell/tabs";
import { useUpdates } from "./updates";
import "./update.css";

/** A card at the bottom right when a new version is out: what changed,
 *  and update now, later or skip this version. Settings shows it in place
 *  instead, since the dialog would cover it. */
export function UpdatePrompt({ inline = false }: { inline?: boolean }) {
  const { t } = useTranslation();
  const { found, prompt, status, progress, error, allowing, install, openInBrowser, later, skip } = useUpdates();
  const inSettings = useShell((s) => s.dialog?.kind === "settings");
  if (!found || !prompt || inSettings !== inline) return null;
  const busy = status === "downloading" || status === "restarting";
  return (
    <div className={`update-prompt${inline ? " inline" : ""}`} role={inline ? "group" : "dialog"} aria-label={t("update.title", { version: found.version })}>
      <div className="update-head">
        <Download size={16} />
        <strong>{t("update.title", { version: found.version })}</strong>
        {!busy && (
          <button className="icon-button" aria-label={t("update.later")} title={t("update.later")} onClick={later}>
            <X size={14} />
          </button>
        )}
      </div>
      {found.notes && <div className="update-notes">{found.notes}</div>}
      {status === "downloading" && (
        <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}>
          <span style={{ width: progress === null ? "30%" : `${Math.round(progress * 100)}%` }} className={progress === null ? "unknown" : undefined} />
        </div>
      )}
      {status === "ready" && allowing && <p className="update-hint">{t("update.allow")}</p>}
      {error && (status === "error" || status === "ready") && <p className="update-error">{t("update.failed", { message: error })}</p>}
      <div className="update-actions">
        {status === "error" && found.how === "package" && (
          <button className="button" onClick={() => void openInBrowser()}>
            {t("update.browser")}
          </button>
        )}
        {!busy && status !== "ready" && (
          <button className="button" onClick={() => void skip()}>
            {t("update.skip")}
          </button>
        )}
        <button className="button primary" disabled={busy} onClick={() => void install()}>
          {status === "downloading" ? t("update.downloading")
            : status === "restarting" ? t("update.restarting")
            : status === "ready" ? t("update.install")
            : found.how === "package" ? t("update.download")
            : t("update.now")}
        </button>
      </div>
    </div>
  );
}
