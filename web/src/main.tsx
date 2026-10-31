import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/base.css";
import { startDocs } from "./app";
import { applyTextSize, applyTextWidth, applyTheme, isTextSize, isTextWidth, isTheme, TEXT_SIZE_SETTING, TEXT_WIDTH_SETTING, THEME_SETTING } from "./design/theme";
import i18n, { initI18n, isLanguage, LANGUAGE_SETTING, systemLanguage } from "./i18n";
import { backend } from "./platform";
import { AppShell } from "./shell/AppShell";
import { useShell } from "./shell/tabs";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { receiveShares } from "./inbox/clip";
import { handleAndroidBack } from "./shell/androidBack";

/** The desktop app on macOS draws into the title bar (tauri.macos.conf.json):
 *  the traffic lights sit in the sidebar's top row, the tabs beside them. */
if (backend.kind === "tauri" && /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints === 0) {
  document.documentElement.dataset.titlebar = "overlay";
}

async function start() {
  const theme = await backend.getLocalSetting<string>(THEME_SETTING).catch(() => null);
  if (isTheme(theme)) applyTheme(theme);
  const [width, size] = await Promise.all([TEXT_WIDTH_SETTING, TEXT_SIZE_SETTING].map((k) => backend.getLocalSetting<string>(k).catch(() => null)));
  if (isTextWidth(width)) applyTextWidth(width);
  if (isTextSize(size)) applyTextSize(size);
  const saved = await backend.getLocalSetting<string>(LANGUAGE_SETTING).catch(() => null);
  await initI18n(isLanguage(saved) ? saved : systemLanguage());
  await startDocs();
  // The chosen library was not found and the default one is open: say so,
  // or the notes would seem gone (§5.7).
  void backend.libraryLocation().then((l) => l.missing && useShell.getState().setNotice(i18n.t("libraryPlace.missing", { path: l.missing })), () => {});
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </StrictMode>,
  );
  // Links shared to Folio from other apps go to the inbox.
  receiveShares();
  handleAndroidBack();
}

void start();
