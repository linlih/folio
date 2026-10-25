import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdates } from "./updates";
import "./update.css";

/** A card at the bottom right when a new version is out: what changed,
 *  and update now, later or skip this version. */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const { found, prompt, status, progress, error, install, later, skip } = useUpdates();
  if (!found || !prompt) return null;
  const busy = status === "downloading" || status === "restarting";
  return (
    <div className="update-prompt" role="dialog" aria-label={t("update.title", { version: found.version })}>
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
      {status === "error" && error && <p className="update-error">{t("update.failed", { message: error })}</p>}
      <div className="update-actions">
        {!busy && (
          <button className="button" onClick={() => void skip()}>
            {t("update.skip")}
          </button>
        )}
        <button className="button primary" disabled={busy} onClick={() => void install()}>
          {status === "downloading" ? t("update.downloading") : status === "restarting" ? t("update.restarting") : found.how === "download" ? t("update.download") : t("update.now")}
        </button>
      </div>
    </div>
  );
}
