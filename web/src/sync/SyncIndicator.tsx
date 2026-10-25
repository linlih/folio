import { Cloud, CloudAlert, CloudOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell } from "../shell/tabs";
import { useSyncStatus } from "./status";

/** Sync at a glance, at the foot of the sidebar: synced, syncing, offline
 *  or failed; opens the sync settings. Nothing while sync is off. */
export function SyncIndicator() {
  const { t } = useTranslation();
  const [status] = useSyncStatus();
  if (!status?.enabled) return null;
  const time = (ms: number) => new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(ms));
  const [icon, label, tone] = status.error
    ? [<CloudAlert size={15} strokeWidth={1.75} />, t("sync.stateError", { message: status.error }), "error"]
    : status.syncing
      ? [<RefreshCw size={14} strokeWidth={1.75} className="spin" />, t("sync.stateSyncing"), ""]
      : !status.live && !status.lastSync
        ? [<CloudOff size={15} strokeWidth={1.75} />, t("sync.offline"), "muted"]
        : [<Cloud size={15} strokeWidth={1.75} />, status.lastSync ? t("sync.stateDone", { time: time(status.lastSync) }) : t("sync.stateStarting"), ""];
  const pending = status.pending > 0 ? ` · ${t("sync.pendingSome", { count: status.pending })}` : "";
  return (
    <button
      className={`icon-button sync-indicator${tone ? ` ${tone}` : ""}`}
      title={`${label}${pending}`}
      aria-label={`${label}${pending}`}
      onClick={() => useShell.getState().setDialog({ kind: "settings", section: "sync" })}
    >
      {icon}
    </button>
  );
}
