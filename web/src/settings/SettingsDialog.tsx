import { Dialog } from "@base-ui/react/dialog";
import { Archive, Bot, Cloud, Info, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { AppInfo } from "../bindings/commands";
import { BackupsPanel } from "../backup/BackupDialogs";
import {
  applyTextSize,
  applyTextWidth,
  applyTheme,
  isTextSize,
  isTextWidth,
  isTheme,
  TEXT_SIZE_SETTING,
  TEXT_SIZES,
  TEXT_WIDTH_SETTING,
  TEXT_WIDTHS,
  THEME_SETTING,
  THEMES,
  type TextSize,
  type TextWidth,
  type Theme,
} from "../design/theme";
import { changeLanguage, isLanguage, LANGUAGE_SETTING, LANGUAGES } from "../i18n";
import { McpPanel } from "../mcp/McpDialogs";
import { backend } from "../platform";
import { keyLabel } from "../shell/shortcuts";
import { useShell, type SettingsSection } from "../shell/tabs";
import { SyncPanel } from "../sync/SyncPanel";
import { LibraryLocationRow } from "./LibraryLocationRow";
import { AUTO_SETTING, useUpdates } from "../update/updates";
import "../shell/dialog.css";
import "./settings.css";

const SECTIONS: { id: SettingsSection; icon: ReactNode }[] = [
  { id: "general", icon: <SlidersHorizontal size={15} strokeWidth={1.75} /> },
  { id: "sync", icon: <Cloud size={15} strokeWidth={1.75} /> },
  { id: "backup", icon: <Archive size={15} strokeWidth={1.75} /> },
  { id: "ai", icon: <Bot size={15} strokeWidth={1.75} /> },
  { id: "about", icon: <Info size={15} strokeWidth={1.75} /> },
];

/** What each section says under its title (the old dialogs' texts). */
const DESCRIPTION: Record<SettingsSection, string | null> = {
  general: null,
  sync: "sync.description",
  backup: "backup.description",
  ai: "mcp.description",
  about: null,
};

/** Settings in one window with its sections on the left, like Claude's
 *  (it replaced a menu of separate dialogs). */
export function SettingsDialog({ section }: { section: SettingsSection }) {
  const { t } = useTranslation();
  const setDialog = useShell((s) => s.setDialog);
  const go = (id: SettingsSection) => setDialog({ kind: "settings", section: id });
  const description = DESCRIPTION[section];
  return (
    <Dialog.Root open onOpenChange={(open) => !open && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog settings">
          <nav className="settings-nav" aria-label={t("settings.title")}>
            <Dialog.Title className="settings-heading">{t("settings.title")}</Dialog.Title>
            {SECTIONS.map((s) => (
              <button key={s.id} className="nav-item" aria-current={s.id === section ? "page" : undefined} onClick={() => go(s.id)}>
                {s.icon}
                <span>{t(`settings.sections.${s.id}`)}</span>
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <header className="dialog-header">
              <h2 className="dialog-title">{t(`settings.sections.${section}`)}</h2>
              <Dialog.Close className="icon-button" aria-label={t("dialog.close")}>
                <X size={15} />
              </Dialog.Close>
            </header>
            {description ? <Dialog.Description className="dialog-description">{t(description)}</Dialog.Description> : <div className="settings-gap" />}
            <div className="settings-content">
              {section === "general" && <GeneralPanel />}
              {section === "sync" && <SyncPanel />}
              {section === "backup" && (
                <>
                  <LibraryLocationRow />
                  <ExportRow />
                  <BackupsPanel />
                </>
              )}
              {section === "ai" && <McpPanel />}
              {section === "about" && <AboutPanel />}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** A small segmented control. */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GeneralPanel() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<Theme>("system");
  const [width, setWidth] = useState<TextWidth>("medium");
  const [size, setSize] = useState<TextSize>("medium");
  useEffect(() => {
    void backend.getLocalSetting<string>(THEME_SETTING).then((v) => isTheme(v) && setTheme(v), () => {});
    void backend.getLocalSetting<string>(TEXT_WIDTH_SETTING).then((v) => isTextWidth(v) && setWidth(v), () => {});
    void backend.getLocalSetting<string>(TEXT_SIZE_SETTING).then((v) => isTextSize(v) && setSize(v), () => {});
  }, []);
  return (
    <>
      <Row label={t("settings.language")}>
        <Choice
          value={i18n.language}
          options={LANGUAGES.map((l) => ({ value: l.code as string, label: l.label }))}
          onChange={async (v) => {
            if (!isLanguage(v)) return;
            await changeLanguage(v);
            await backend.setLocalSetting(LANGUAGE_SETTING, v);
          }}
        />
      </Row>
      <Row label={t("settings.appearance")}>
        <Choice
          value={theme}
          options={THEMES.map((v) => ({ value: v, label: t(`settings.theme.${v}`) }))}
          onChange={(v) => {
            setTheme(v);
            applyTheme(v);
            void backend.setLocalSetting(THEME_SETTING, v);
          }}
        />
      </Row>
      <Row label={t("settings.textWidth")} hint={t("settings.textWidthHint")}>
        <Choice
          value={width}
          options={(Object.keys(TEXT_WIDTHS) as TextWidth[]).map((v) => ({ value: v, label: t(`settings.width.${v}`) }))}
          onChange={(v) => {
            setWidth(v);
            applyTextWidth(v);
            void backend.setLocalSetting(TEXT_WIDTH_SETTING, v);
          }}
        />
      </Row>
      <Row label={t("settings.textSize")}>
        <Choice
          value={size}
          options={(Object.keys(TEXT_SIZES) as TextSize[]).map((v) => ({ value: v, label: t(`settings.size.${v}`) }))}
          onChange={(v) => {
            setSize(v);
            applyTextSize(v);
            void backend.setLocalSetting(TEXT_SIZE_SETTING, v);
          }}
        />
      </Row>
    </>
  );
}

function ExportRow() {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  async function exportMarkdown() {
    try {
      // Latest edits first: the export reads what is saved.
      await docs().flushAll();
      const date = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(":", "");
      const result = await backend.exportMarkdown(t("settings.exportFolder", { date }), t("library.untitled"));
      if (result) setNotice(t("settings.exportDone", { cards: result.cards, journals: result.journals, dir: result.dir }));
      else if (backend.kind === "memory") setNotice(t("settings.diagnosticsUnavailable"));
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  }
  return (
    <Row label={t("settings.exportTitle")} hint={t("settings.exportHint")}>
      <button className="button" onClick={() => void exportMarkdown()}>
        {t("settings.exportMarkdown")}
      </button>
    </Row>
  );
}

/** Checking for a new version now, and whether to check by itself. */
function UpdateRows() {
  const { t } = useTranslation();
  const { status, found, error, check } = useUpdates();
  const [auto, setAuto] = useState(true);
  useEffect(() => void backend.getLocalSetting<boolean>(AUTO_SETTING).then((v) => setAuto(v !== false), () => {}), []);
  const said =
    status === "checking" ? t("update.checking")
    : status === "uptodate" ? t("update.uptodate")
    : status === "available" && found ? t("update.available", { version: found.version })
    : status === "unsupported" ? t("update.unsupported")
    : status === "error" && error ? t("update.error", { message: error })
    : t("update.hint");
  return (
    <>
      <Row label={t("update.row")} hint={said}>
        <button
          className="button"
          disabled={status === "checking" || status === "downloading"}
          onClick={async () => {
            await check();
            // Found by asking: offered even if it was skipped before.
            if (useUpdates.getState().found) useUpdates.setState({ prompt: true });
          }}
        >
          {t("update.check")}
        </button>
      </Row>
      {backend.kind === "tauri" && (
        <Row label={t("update.auto")} hint={t("update.autoHint")}>
          <Choice
            value={auto ? "on" : "off"}
            options={[
              { value: "on", label: t("update.on") },
              { value: "off", label: t("update.off") },
            ]}
            onChange={(v) => {
              setAuto(v === "on");
              void backend.setLocalSetting(AUTO_SETTING, v === "on");
            }}
          />
        </Row>
      )}
    </>
  );
}

function AboutPanel() {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const setDialog = useShell((s) => s.setDialog);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void backend.appInfo().then(setInfo, () => {}), []);
  async function exportDiagnostics() {
    try {
      const path = await backend.exportDiagnostics();
      setNotice(path ? t("settings.diagnosticsSaved", { path }) : t("settings.diagnosticsUnavailable"));
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
    }
  }
  return (
    <>
      <Row label={t("settings.version")}>
        <code className="settings-value">{info?.version ?? "…"}</code>
      </Row>
      <UpdateRows />
      <Row label={t("settings.dataDir")}>
        <code className="settings-value" title={info?.dataDir}>
          {info?.dataDir ?? "…"}
        </code>
      </Row>
      <Row label={t("settings.diagnosticsTitle")} hint={t("settings.diagnosticsHint")}>
        <button className="button" onClick={() => void exportDiagnostics()}>
          {t("settings.diagnostics")}
        </button>
      </Row>
      <Row label={t("shortcuts.title")}>
        <button className="button" onClick={() => setDialog({ kind: "shortcuts" })}>
          {t("settings.showShortcuts", { key: keyLabel("Mod+/") })}
        </button>
      </Row>
    </>
  );
}
