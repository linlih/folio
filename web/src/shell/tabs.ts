import { create } from "zustand";

export type TabTarget =
  | { kind: "library" }
  | { kind: "journal" }
  | { kind: "trash" }
  | { kind: "card"; cardId: string }
  | { kind: "tag"; name: string }
  | { kind: "boards" }
  | { kind: "board"; boardId: string };

export interface Tab {
  key: string;
  target: TabTarget;
  /** Card title as last seen; null shows "Untitled". Views localise the rest. */
  title: string | null;
}

/** One column of the main area, with its own tabs (split view, §0.2). */
export interface Pane {
  id: string;
  tabs: Tab[];
  active: string;
}

export function tabKey(target: TabTarget): string {
  if (target.kind === "card") return `card:${target.cardId}`;
  // Tags match case-insensitively: one tab per tag.
  if (target.kind === "tag") return `tag:${target.name.trim().toLowerCase()}`;
  if (target.kind === "board") return `board:${target.boardId}`;
  return target.kind;
}

/** Shift+click opens in the other pane (Logseq's Shift+click to the side). */
export const toSide = (e: { shiftKey: boolean }) => e.shiftKey;

const RECENT_LIMIT = 8;
/** Two panes for now; the list leaves room for more columns later. */
const MAX_PANES = 2;
export const DEFAULT_SPLIT = 0.5;

interface ShellState {
  panes: Pane[];
  /** The pane worked in last: the sidebar, search and library open there. */
  focused: string;
  /** Width of the first pane, as a fraction of the main area. */
  split: number;
  /** Cards opened most recently first, for the sidebar. */
  recent: { cardId: string; title: string | null }[];
  notice: string | null;
  /** The sidebar is shown (it can be hidden for more room, like Claude's). */
  sidebarOpen: boolean;
  setSidebarOpen(open: boolean): void;
  /** The details panel on the right: the focused card's outline, backlinks
   *  and facts. */
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** The topic the card library shows (§4.7); null for all cards. */
  libraryTopic: string | null;
  setLibraryTopic(topic: string | null): void;
  /** Opens the card library on a topic. */
  openTopic(topic: string, side?: boolean): void;
  /** The global search palette (Cmd+K). */
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  /** A dialog over everything (backups, shortcuts, AI access). */
  dialog: ShellDialog | null;
  setDialog(dialog: ShellDialog | null): void;
  /** Opens in the focused pane, or with `side` in the other one (made if
   *  needed). Switches to the tab if that pane has it already (§0.2); the
   *  same card may be open in both panes. The pane opened in gets focus. */
  open(target: TabTarget, title?: string | null, side?: boolean): void;
  /** Closes a tab (in the focused pane by default). A pane whose last tab
   *  closes goes away, unless it is the only one. */
  close(key: string, pane?: string): void;
  activate(key: string, pane?: string): void;
  focusPane(pane: string): void;
  /** Moves a tab to the other pane (made if needed). */
  moveToOther(key: string, pane: string): void;
  /** Drags a tab (§0.2): to a place in a pane's tab bar (`index`, before
   *  that tab; the end when absent), or into a new pane on the right. The
   *  moved tab becomes active and its pane focused. */
  moveTab(key: string, from: string, to: TabDrop): void;
  /** Mod+\: splits with the focused tab, or joins the panes back into one. */
  toggleSplit(): void;
  setSplit(fraction: number): void;
  /** Shows a card's new title in its tabs and in the recent list. */
  renameCard(cardId: string, title: string): void;
  /** Closes a card's tabs and drops it from the recent list (moved to trash). */
  forgetCard(cardId: string): void;
  /** Restores a saved layout (startup). */
  restore(layout: { panes: Pane[]; focused: string; split: number }): void;
  setNotice(text: string | null): void;
}

export type TabDrop = { pane: string; index?: number } | { newPane: true };

export type SettingsSection = "general" | "sync" | "backup" | "ai" | "about";

/** Settings without a section: the list of sections on a phone, General on a desktop. */
export type ShellDialog = { kind: "settings"; section?: SettingsSection } | { kind: "shortcuts" } | { kind: "mcpApproval"; id: string; client: string };

const LIBRARY: Tab = { key: "library", target: { kind: "library" }, title: null };

let paneSeq = 0;
const newPaneId = () => `pane-${++paneSeq}`;
const firstPane = (): Pane => ({ id: newPaneId(), tabs: [LIBRARY], active: LIBRARY.key });

/** Adds or activates a tab in a pane, after its active tab. */
function withTab(pane: Pane, tab: Tab): Pane {
  if (pane.tabs.some((t) => t.key === tab.key)) return { ...pane, active: tab.key };
  const at = pane.tabs.findIndex((t) => t.key === pane.active) + 1;
  return { ...pane, tabs: [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)], active: tab.key };
}

function withoutTab(pane: Pane, key: string): Pane {
  const i = pane.tabs.findIndex((t) => t.key === key);
  if (i < 0) return pane;
  const tabs = pane.tabs.filter((t) => t.key !== key);
  const active = pane.active === key && tabs.length ? tabs[Math.min(i, tabs.length - 1)].key : pane.active;
  return { ...pane, tabs, active };
}

/** The pane next to `id`; a new one at the right when there is room. */
function otherPane(panes: Pane[], id: string): { panes: Pane[]; other: Pane } {
  const i = panes.findIndex((p) => p.id === id);
  const next = panes[i + 1] ?? panes[i - 1];
  if (next) return { panes, other: next };
  const other: Pane = { id: newPaneId(), tabs: [], active: "" };
  return { panes: panes.length < MAX_PANES ? [...panes, other] : panes, other };
}

/** Drops empty panes; there is always at least one, with at least one tab. */
function tidy(panes: Pane[], focused: string): { panes: Pane[]; focused: string } {
  const kept = panes.filter((p) => p.tabs.length > 0);
  if (kept.length === 0) {
    const p = { ...panes[0], tabs: [LIBRARY], active: LIBRARY.key };
    return { panes: [p], focused: p.id };
  }
  return { panes: kept, focused: kept.some((p) => p.id === focused) ? focused : kept[0].id };
}

const replace = (panes: Pane[], pane: Pane) => panes.map((p) => (p.id === pane.id ? pane : p));

/** Pages that exist once in the window: the card library in both panes
 *  would only show the same list twice. Opening one goes to where it is. */
export const SINGLE: ReadonlySet<TabTarget["kind"]> = new Set(["library", "boards"]);

export const useShell = create<ShellState>((set) => {
  const initial = firstPane();
  return {
    panes: [initial],
    focused: initial.id,
    split: DEFAULT_SPLIT,
    recent: [],
    notice: null,
    sidebarOpen: true,
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    panelOpen: false,
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    libraryTopic: null,
    setLibraryTopic: (libraryTopic) => set({ libraryTopic }),
    openTopic: (topic, side = false) => {
      set({ libraryTopic: topic });
      useShell.getState().open({ kind: "library" }, null, side);
    },
    searchOpen: false,
    setSearchOpen: (searchOpen) => set({ searchOpen }),
    dialog: null,
    setDialog: (dialog) => set({ dialog }),

    open: (target, title = null, side = false) =>
      set((s) => {
        const recent =
          target.kind === "card"
            ? [{ cardId: target.cardId, title }, ...s.recent.filter((r) => r.cardId !== target.cardId)].slice(0, RECENT_LIMIT)
            : s.recent;
        let panes = s.panes;
        let pane = panes.find((p) => p.id === s.focused) ?? panes[0];
        const key = tabKey(target);
        const holder = SINGLE.has(target.kind) ? panes.find((p) => p.tabs.some((t) => t.key === key)) : undefined;
        if (holder && side && holder.id === pane.id) {
          // Asked for beside this pane while it holds the page: move it over
          // (the library beside a whiteboard, to drag cards across).
          const tab = holder.tabs.find((t) => t.key === key)!;
          const { panes: withOther, other } = otherPane(panes, holder.id);
          if (other.id !== holder.id) {
            const moved = replace(replace(withOther, withoutTab(holder, key)), withTab(other, tab));
            const t = tidy(moved, other.id);
            return { ...t, recent };
          }
        }
        if (holder) pane = holder;
        else if (side) ({ panes, other: pane } = otherPane(panes, pane.id));
        const next = withTab(pane, { key, target, title });
        return { panes: replace(panes, next), focused: next.id, recent };
      }),

    close: (key, paneId) =>
      set((s) => {
        const id = paneId ?? s.focused;
        const panes = s.panes.map((p) => (p.id === id ? withoutTab(p, key) : p));
        return tidy(panes, s.focused);
      }),

    activate: (key, paneId) =>
      set((s) => {
        const id = paneId ?? s.focused;
        return { panes: s.panes.map((p) => (p.id === id ? { ...p, active: key } : p)), focused: id };
      }),

    focusPane: (focused) => set((s) => (s.focused === focused ? s : { focused })),

    moveToOther: (key, paneId) =>
      set((s) => {
        const from = s.panes.find((p) => p.id === paneId);
        const tab = from?.tabs.find((t) => t.key === key);
        if (!from || !tab) return s;
        const { panes, other } = otherPane(s.panes, from.id);
        if (other.id === from.id) return s;
        const moved = replace(replace(panes, withoutTab(from, key)), withTab(other, tab));
        return tidy(moved, other.id);
      }),

    moveTab: (key, fromId, to) =>
      set((s) => {
        const from = s.panes.find((p) => p.id === fromId);
        const tab = from?.tabs.find((t) => t.key === key);
        if (!from || !tab) return s;
        if ("newPane" in to) {
          // Splitting off the only tab would leave nothing behind.
          if (s.panes.length >= MAX_PANES || from.tabs.length < 2) return s;
          const other: Pane = { id: newPaneId(), tabs: [tab], active: key };
          return { panes: [...replace(s.panes, withoutTab(from, key)), other], focused: other.id };
        }
        const dest = s.panes.find((p) => p.id === to.pane);
        if (!dest) return s;
        // Where it lands, counted without the tab itself.
        const others = dest.tabs.filter((t) => t.key !== key);
        let at = to.index ?? dest.tabs.length;
        at -= dest.tabs.slice(0, at).filter((t) => t.key === key).length;
        at = Math.max(0, Math.min(at, others.length));
        const placed: Pane = { ...dest, tabs: [...others.slice(0, at), tab, ...others.slice(at)], active: key };
        const panes = dest.id === from.id ? replace(s.panes, placed) : replace(replace(s.panes, withoutTab(from, key)), placed);
        return tidy(panes, dest.id);
      }),

    toggleSplit: () =>
      set((s) => {
        if (s.panes.length > 1) {
          // Join: the other panes' tabs follow the first pane's.
          const [first, ...rest] = s.panes;
          const joined = rest.reduce((p, r) => r.tabs.reduce((acc, t) => (acc.tabs.some((x) => x.key === t.key) ? acc : { ...acc, tabs: [...acc.tabs, t] }), p), first);
          const focusedPane = s.panes.find((p) => p.id === s.focused)!;
          return { panes: [{ ...joined, active: focusedPane.active }], focused: first.id };
        }
        const pane = s.panes[0];
        let tab = pane.tabs.find((t) => t.key === pane.active) ?? pane.tabs[0];
        // Splitting from the library: the other side shows the latest card
        // opened (or the journal), not a second library.
        if (SINGLE.has(tab.target.kind)) {
          const r = s.recent[0];
          const target: TabTarget = r ? { kind: "card", cardId: r.cardId } : { kind: "journal" };
          tab = pane.tabs.find((t) => t.key === tabKey(target)) ?? { key: tabKey(target), target, title: r?.title ?? null };
        }
        const other: Pane = { id: newPaneId(), tabs: [tab], active: tab.key };
        return { panes: [pane, other], focused: other.id };
      }),

    setSplit: (fraction) => set({ split: Math.min(0.8, Math.max(0.2, fraction)) }),

    renameCard: (cardId, title) =>
      set((s) => ({
        panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.key === `card:${cardId}` ? { ...t, title } : t)) })),
        recent: s.recent.map((r) => (r.cardId === cardId ? { ...r, title } : r)),
      })),

    forgetCard: (cardId) =>
      set((s) => {
        const key = `card:${cardId}`;
        return { ...tidy(s.panes.map((p) => withoutTab(p, key)), s.focused), recent: s.recent.filter((r) => r.cardId !== cardId) };
      }),

    restore: (layout) =>
      set(() => {
        // A single page saved in both panes stays in the first.
        const seen = new Set<string>();
        const panes = layout.panes
          .slice(0, MAX_PANES)
          .map((p) => {
            const tabs = p.tabs.filter((t) => !SINGLE.has(t.target.kind) || (!seen.has(t.key) && seen.add(t.key)));
            return { ...p, tabs, id: newPaneId(), active: tabs.some((t) => t.key === p.active) ? p.active : (tabs[0]?.key ?? "") };
          });
        const focusedIndex = Math.max(0, layout.panes.findIndex((p) => p.id === layout.focused));
        const t = tidy(panes, panes[focusedIndex]?.id ?? "");
        return { ...t, split: Math.min(0.8, Math.max(0.2, layout.split || DEFAULT_SPLIT)) };
      }),

    setNotice: (notice) => set({ notice }),
  };
});

/** The focused pane. */
export const focusedPane = (s: Pick<ShellState, "panes" | "focused">) => s.panes.find((p) => p.id === s.focused) ?? s.panes[0];
