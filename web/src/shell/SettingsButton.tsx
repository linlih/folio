import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell } from "./tabs";

/** Opens the settings window (settings/SettingsDialog.tsx). */
export function SettingsButton() {
  const { t } = useTranslation();
  const open = useShell((s) => s.dialog?.kind === "settings");
  return (
    <button className="nav-item" aria-current={open ? "page" : undefined} onClick={() => useShell.getState().setDialog({ kind: "settings", section: "general" })}>
      <Settings size={15} strokeWidth={1.75} />
      <span>{t("nav.settings")}</span>
    </button>
  );
}
