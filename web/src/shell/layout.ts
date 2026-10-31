// The main area's layout (panes, their tabs, the divider), kept on this
// device and restored at startup (design/ARCHITECTURE.md §0.2).

import { useEffect } from "react";
import { backend } from "../platform";
import { useShell, type Pane } from "./tabs";

const LAYOUT_SETTING = "shell.layout";
const SAVE_DELAY_MS = 400;
/** Tab kinds a saved layout may hold; others (removed since) are dropped. */
const KNOWN = new Set(["library", "journal", "trash", "tasks", "card", "tag", "boards", "board"]);

interface SavedLayout {
  panes: Pane[];
  focused: string;
  split: number;
  /** Absent in layouts saved before the sidebar could be hidden. */
  sidebar?: boolean;
  panel?: boolean;
}

/** Card tabs of cards that are gone (trashed, or deleted elsewhere) are
 *  dropped; the others get the titles cards have now. */
async function live(layout: SavedLayout): Promise<SavedLayout> {
  const cards = new Map((await backend.listCards(5000)).map((c) => [c.id, c.title]));
  const panes = layout.panes.map((p) => ({
    ...p,
    tabs: p.tabs
      .filter((t) => KNOWN.has(t.target.kind) && (t.target.kind !== "card" || cards.has(t.target.cardId)))
      .map((t) => (t.target.kind === "card" ? { ...t, title: cards.get(t.target.cardId) || null } : t)),
  }));
  return { ...layout, panes };
}

let markRestored: () => void = () => {};
const restoredOnce = new Promise<void>((resolve) => (markRestored = resolve));

/** Resolves once the startup layout is back, so a page opened at startup
 * (a share on Android) is not replaced by the restored tabs. */
export function layoutRestored(): Promise<void> {
  return restoredOnce;
}

export function useLayoutPersistence() {
  useEffect(() => {
    let restored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    backend
      .getLocalSetting<SavedLayout>(LAYOUT_SETTING)
      .then(async (saved) => {
        if (cancelled || !saved?.panes?.length) return;
        const layout = await live(saved);
        if (cancelled) return;
        useShell.getState().restore(layout);
        if (layout.sidebar === false) useShell.getState().setSidebarOpen(false);
        if (layout.panel) useShell.getState().setPanelOpen(true);
      })
      .catch(() => {})
      .finally(() => {
        restored = true;
        markRestored();
      });

    // Saved after restoring, so the startup layout never overwrites it.
    const unsubscribe = useShell.subscribe((s, prev) => {
      if (!restored || (s.panes === prev.panes && s.focused === prev.focused && s.split === prev.split && s.sidebarOpen === prev.sidebarOpen && s.panelOpen === prev.panelOpen)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { panes, focused, split, sidebarOpen, panelOpen } = useShell.getState();
        void backend.setLocalSetting(LAYOUT_SETTING, { panes, focused, split, sidebar: sidebarOpen, panel: panelOpen } satisfies SavedLayout).catch(() => {});
      }, SAVE_DELAY_MS);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
