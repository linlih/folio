// Commands for the ⌘K palette (type > first): everything the app can do
// from the keyboard, with its shortcut shown when it has one.

import { docs } from "../app";
import { applyTheme, THEME_SETTING, type Theme } from "../design/theme";
import i18n from "../i18n";
import { backend } from "../platform";
import { newCard, PANEL_COMBO, SIDEBAR_COMBO, togglePanel, toggleSidebar } from "./shortcuts";
import { useShell, type SettingsSection } from "./tabs";
import { newBoard } from "../docs/topics";

export interface Command {
  id: string;
  /** i18n key under `commands.` */
  label: string;
  combo?: string;
  run: () => void | Promise<void>;
}

const shell = () => useShell.getState();
const settings = (section: SettingsSection) => () => shell().setDialog({ kind: "settings", section });
const theme = (t: Theme) => () => {
  applyTheme(t);
  void backend.setLocalSetting(THEME_SETTING, t);
};
const report = (f: () => Promise<unknown>, done: string) => async () => {
  try {
    await f();
    shell().setNotice(i18n.t(done));
  } catch (e) {
    shell().setNotice(i18n.t("error.generic", { message: String(e) }));
  }
};

export const COMMANDS: Command[] = [
  { id: "newCard", label: "newCard", combo: "Mod+N", run: () => newCard() },
  { id: "journal", label: "journal", combo: "Mod+Shift+J", run: () => shell().open({ kind: "journal" }) },
  { id: "library", label: "library", combo: "Mod+Shift+L", run: () => shell().open({ kind: "library" }) },
  { id: "trash", label: "trash", run: () => shell().open({ kind: "trash" }) },
  { id: "inbox", label: "inbox", run: () => shell().open({ kind: "inbox" }) },
  { id: "tasks", label: "tasks", run: () => shell().open({ kind: "tasks" }) },
  { id: "boards", label: "boards", run: () => shell().open({ kind: "boards" }) },
  { id: "newBoard", label: "newBoard", run: async () => shell().open({ kind: "board", boardId: await newBoard(i18n.t("board.untitled")) }) },
  { id: "sidebar", label: "sidebar", combo: SIDEBAR_COMBO, run: toggleSidebar },
  { id: "panel", label: "panel", combo: PANEL_COMBO, run: togglePanel },
  { id: "split", label: "split", combo: "Mod+\\", run: () => shell().toggleSplit() },
  { id: "settings", label: "settings", run: settings("general") },
  { id: "sync", label: "syncSettings", run: settings("sync") },
  { id: "syncNow", label: "syncNow", run: report(() => backend.syncNow(), "commands.syncStarted") },
  {
    id: "backupNow",
    label: "backupNow",
    run: report(async () => {
      await docs().flushAll();
      await backend.backupNow();
    }, "commands.backupDone"),
  },
  { id: "export", label: "exportMarkdown", run: settings("backup") },
  { id: "ai", label: "aiAccess", run: settings("ai") },
  { id: "themeLight", label: "themeLight", run: theme("light") },
  { id: "themeDark", label: "themeDark", run: theme("dark") },
  { id: "themeSystem", label: "themeSystem", run: theme("system") },
  { id: "shortcuts", label: "shortcuts", combo: "Mod+/", run: () => shell().setDialog({ kind: "shortcuts" }) },
];

/** Commands whose name (in the current language, or the English id)
 *  contains every word of the query. */
export function findCommands(query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return COMMANDS.filter((c) => {
    const text = `${i18n.t(`commands.${c.label}`)} ${c.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
