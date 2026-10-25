// App-wide keyboard shortcuts, and the list the shortcuts dialog shows
// (Mod+/). Editing keys live with the editor (editor/outliner); they are
// listed here for the dialog only.

import { cardsChanged } from "../card/actions";
import { backend } from "../platform";
import { focusedPane, useShell } from "./tabs";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A key combination as `Mod+Shift+K`: Mod is ⌘ on macOS, Ctrl elsewhere. */
export function keyLabel(combo: string): string {
  const parts = combo.split("+");
  if (!isMac) return parts.map((p) => (p === "Mod" ? "Ctrl" : p === "Alt" ? "Alt" : p)).join("+");
  const sym: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", Enter: "↩", ArrowUp: "↑", ArrowDown: "↓", Tab: "⇥", Backspace: "⌫", Space: "Space" };
  return parts.map((p) => sym[p] ?? p).join("");
}

interface Global {
  combo: string;
  /** i18n key under `shortcuts.` */
  label: string;
  match: (e: KeyboardEvent, mod: boolean) => boolean;
  run: () => void;
}

const plain = (e: KeyboardEvent) => !e.altKey;

function cycleTab(dir: 1 | -1) {
  const s = useShell.getState();
  const pane = focusedPane(s);
  const i = pane.tabs.findIndex((t) => t.key === pane.active);
  const next = pane.tabs[(i + dir + pane.tabs.length) % pane.tabs.length];
  if (next) s.activate(next.key, pane.id);
}

/** Show or hide the sidebar: ⌃⌘S as in Finder, Mail and Notes; Ctrl+Alt+S
 *  elsewhere (⌘B and ⌘⇧S are bold and strikethrough in the editor). */
export const SIDEBAR_COMBO = isMac ? "Ctrl+Mod+S" : "Ctrl+Alt+S";

export const toggleSidebar = () => {
  const s = useShell.getState();
  s.setSidebarOpen(!s.sidebarOpen);
};

/** The details panel: ⌃⌘I beside ⌃⌘S for the sidebar (⌥⌘I opens the web
 *  inspector in development builds; ⌘⇧I is italic in the editor). */
export const PANEL_COMBO = isMac ? "Ctrl+Mod+I" : "Ctrl+Alt+I";

export const togglePanel = () => {
  const s = useShell.getState();
  s.setPanelOpen(!s.panelOpen);
};

export async function newCard() {
  const id = await backend.createCard("");
  cardsChanged();
  useShell.getState().open({ kind: "card", cardId: id }, null);
}

export const GLOBAL_SHORTCUTS: Global[] = [
  { combo: "Mod+K", label: "search", match: (e, m) => m && plain(e) && !e.shiftKey && e.key.toLowerCase() === "k", run: () => useShell.getState().setSearchOpen(true) },
  { combo: "Mod+N", label: "newCard", match: (e, m) => m && plain(e) && !e.shiftKey && e.key.toLowerCase() === "n", run: () => void newCard() },
  { combo: "Mod+Shift+J", label: "journal", match: (e, m) => m && plain(e) && e.shiftKey && e.code === "KeyJ", run: () => useShell.getState().open({ kind: "journal" }) },
  { combo: "Mod+Shift+L", label: "library", match: (e, m) => m && plain(e) && e.shiftKey && e.code === "KeyL", run: () => useShell.getState().open({ kind: "library" }) },
  {
    combo: "Mod+W",
    label: "closeTab",
    match: (e, m) => m && plain(e) && !e.shiftKey && e.key.toLowerCase() === "w",
    run: () => {
      const s = useShell.getState();
      s.close(focusedPane(s).active);
    },
  },
  { combo: "Ctrl+Tab", label: "nextTab", match: (e) => e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "Tab", run: () => cycleTab(1) },
  { combo: "Ctrl+Shift+Tab", label: "prevTab", match: (e) => e.ctrlKey && !e.metaKey && e.shiftKey && e.key === "Tab", run: () => cycleTab(-1) },
  { combo: "Mod+Shift+]", label: "nextTab", match: (e, m) => m && plain(e) && e.shiftKey && e.code === "BracketRight", run: () => cycleTab(1) },
  { combo: "Mod+Shift+[", label: "prevTab", match: (e, m) => m && plain(e) && e.shiftKey && e.code === "BracketLeft", run: () => cycleTab(-1) },
  { combo: "Mod+\\", label: "split", match: (e, m) => m && plain(e) && !e.shiftKey && (e.key === "\\" || e.code === "Backslash"), run: () => useShell.getState().toggleSplit() },
  {
    combo: SIDEBAR_COMBO,
    label: "sidebar",
    match: (e) => e.code === "KeyS" && !e.shiftKey && (isMac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey),
    run: toggleSidebar,
  },
  {
    combo: PANEL_COMBO,
    label: "panel",
    match: (e) => e.code === "KeyI" && !e.shiftKey && (isMac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey),
    run: togglePanel,
  },
  { combo: "Mod+/", label: "help", match: (e, m) => m && plain(e) && (e.key === "/" || e.code === "Slash"), run: () => useShell.getState().setDialog({ kind: "shortcuts" }) },
];

/** Runs the app-wide shortcut for `e`, if there is one. */
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const hit = GLOBAL_SHORTCUTS.find((s) => s.match(e, mod));
  if (!hit) return false;
  e.preventDefault();
  hit.run();
  return true;
}

/** What the shortcuts dialog lists, by group. */
export const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "app",
    items: [
      ["Mod+K", "search"],
      ["Mod+E", "capture"],
      ["Mod+Shift+Space", "captureAnywhere"],
      ["Mod+N", "newCard"],
      ["Mod+Shift+J", "journal"],
      ["Mod+Shift+L", "library"],
      [SIDEBAR_COMBO, "sidebar"],
      [PANEL_COMBO, "panel"],
      ["Mod+/", "help"],
    ],
  },
  {
    title: "tabs",
    items: [
      ["Mod+W", "closeTab"],
      ["Ctrl+Tab", "nextTab"],
      ["Ctrl+Shift+Tab", "prevTab"],
      ["Mod+\\", "split"],
      ["Mod+1", "leftPane"],
      ["Mod+2", "rightPane"],
    ],
  },
  {
    title: "blocks",
    items: [
      ["Tab", "indent"],
      ["Shift+Tab", "outdent"],
      ["Mod+Shift+ArrowUp", "moveUp"],
      ["Mod+Shift+ArrowDown", "moveDown"],
      ["Mod+Enter", "cycleTask"],
      ["Mod+ArrowUp", "collapse"],
      ["Mod+ArrowDown", "expand"],
      ["Mod+.", "focusBlock"],
      ["Mod+,", "unfocusBlock"],
      ["Esc", "selectBlocks"],
      ["Mod+Alt+Enter", "extract"],
    ],
  },
  {
    title: "text",
    items: [
      ["/", "slash"],
      ["[[", "cardLink"],
      ["((", "blockRef"],
      ["Mod+C", "copyRef"],
      ["Mod+Shift+V", "pastePlain"],
      ["Mod+Z", "undo"],
      ["Mod+Shift+Z", "redo"],
    ],
  },
];
