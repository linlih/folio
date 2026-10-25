import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { appUndo } from "../app";
import { CardView } from "../card/CardView";
import { JournalView } from "../journal/JournalView";
import { CardLibrary } from "../library/CardLibrary";
import { QuickCapture } from "../capture/QuickCapture";
import { SearchPalette } from "../search/SearchPalette";
import { ShellDialogs } from "./ShellDialogs";
import { useMcpApprovals } from "../mcp/McpDialogs";
import { handleGlobalKey } from "./shortcuts";
import { TrashView } from "../trash/TrashView";
import { TagView } from "../tags/TagView";
import { BoardView } from "../board/BoardView";
import { BoardsView } from "../board/BoardsView";
import { backend } from "../platform";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { installLongPress } from "./longPress";
import { KeyboardBar, PhoneNav, PhoneTopBar } from "./PhoneBars";
import { usePhone, useTouch } from "./phone";
import { UpdatePrompt } from "../update/UpdatePrompt";
import { startUpdateChecks } from "../update/updates";
import { TabDragLayer } from "./tabDrag";
import { DetailsPanel } from "./DetailsPanel";
import { useLayoutPersistence } from "./layout";
import { useShell, type Pane, type Tab } from "./tabs";
import "./shell.css";

function View({ tab, pane, active }: { tab: Tab; pane: string; active: boolean }) {
  switch (tab.target.kind) {
    case "library":
      return <CardLibrary active={active} />;
    case "journal":
      return <JournalView />;
    case "trash":
      return <TrashView />;
    case "card":
      return <CardView cardId={tab.target.cardId} pane={pane} active={active} />;
    case "tag":
      return <TagView name={tab.target.name} active={active} />;
    case "boards":
      return <BoardsView />;
    case "board":
      return <BoardView boardId={tab.target.boardId} active={active} />;
  }
}

/** Below this width the panes don't fit side by side: only the focused one
 *  shows, and its tab bar switches to the other. */
const NARROW_MAIN = 720;
const MIN_PANE = 360;

/** One pane: its tab bar and its tabs' views. Every open tab stays mounted
 *  so its editors keep their undo history and scroll position; only the
 *  active one is shown. A click or focus inside makes it the focused pane. */
function PaneView({ pane, focused, last, narrow, leading, phone }: { pane: Pane; focused: boolean; last: boolean; narrow: boolean; leading: boolean; phone: boolean }) {
  const focusPane = useShell((s) => s.focusPane);
  const focus = () => focusPane(pane.id);
  // The line under the tab bar shows only once the page has scrolled under
  // it, as in Claude's app; at the top the bar and page are one surface.
  const [scrolled, setScrolled] = useState(false);
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    const view = self.current?.querySelector<HTMLElement>(":scope > .view:not([hidden])");
    setScrolled((view?.scrollTop ?? 0) > 0);
  }, [pane.active]);
  const onScroll = (e: React.UIEvent) => {
    const el = e.target as HTMLElement;
    if (el.classList.contains("view")) setScrolled(el.scrollTop > 0);
  };
  return (
    <section
      ref={self}
      className={`pane${focused ? " focused" : ""}${scrolled ? " scrolled" : ""}`}
      onMouseDownCapture={focus}
      onFocusCapture={focus}
      onScrollCapture={onScroll}
    >
      {phone ? <PhoneTopBar pane={pane} /> : <TabBar pane={pane} last={last} narrow={narrow} leading={leading} />}
      {pane.tabs.map((x) => (
        <div key={x.key} className="view" hidden={x.key !== pane.active}>
          <View tab={x} pane={pane.id} active={x.key === pane.active} />
        </div>
      ))}
    </section>
  );
}

/** The bar between two panes; drag to share the width differently. */
function Divider({ main }: { main: React.RefObject<HTMLElement | null> }) {
  const setSplit = useShell((s) => s.setSplit);
  const onPointerDown = (e: React.PointerEvent) => {
    const box = main.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    // Each pane keeps at least MIN_PANE of width.
    const min = Math.min(0.5, MIN_PANE / box.width);
    const move = (ev: PointerEvent) => setSplit(Math.min(1 - min, Math.max(min, (ev.clientX - box.left) / box.width)));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return <div className="pane-divider" role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} onDoubleClick={() => setSplit(0.5)} />;
}

/** True when the key event belongs to a text field or an editor, which
 *  handle their own undo. */
const inTextField = (e: KeyboardEvent) =>
  e.target instanceof HTMLElement && !!e.target.closest("input, textarea, [contenteditable='true']");

export function AppShell() {
  const { t } = useTranslation();
  const { panes, focused, split, notice, setNotice, sidebarOpen } = useShell();
  const main = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const phone = usePhone();
  const touch = useTouch();
  useLayoutPersistence();
  // Long press opens the right-click menus on a touch screen.
  useEffect(() => (touch ? installLongPress() : undefined), [touch]);
  // A new version from GitHub Releases, checked quietly once a day.
  useEffect(() => startUpdateChecks(), []);
  useMcpApprovals();

  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_MAIN));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mod+Z outside editors undoes app-level actions (moving a card to the trash).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Search, new card, tabs, split… (shell/shortcuts.ts)
      if (handleGlobalKey(e)) return;
      // Mod+1 / Mod+2: go to a pane.
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const pane = useShell.getState().panes[Number(e.key) - 1];
        if (!pane) return;
        e.preventDefault();
        useShell.getState().focusPane(pane.id);
        // Into the pane's visible view, so typing and keys go there.
        const view = document.querySelector<HTMLElement>(`[data-pane="${pane.id}"] .view:not([hidden])`);
        (view?.querySelector<HTMLElement>(".ProseMirror[contenteditable='true']") ?? view)?.focus();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || inTextField(e)) return;
      e.preventDefault();
      void (e.shiftKey ? appUndo.redo() : appUndo.undo());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  return (
    <div className={`shell${sidebarOpen ? "" : " sidebar-closed"}${phone ? " phone" : ""}`}>
      <Sidebar />
      <main
        ref={main}
        className={`main${narrow ? " narrow" : ""}`}
        style={{ "--split": `${split * 100}%` } as React.CSSProperties}
        data-panes={panes.length}
      >
        {panes.map((pane, i) => (
          <div key={pane.id} className="pane-slot" data-pane={pane.id} hidden={narrow && pane.id !== focused}>
            {i > 0 && !narrow && <Divider main={main} />}
            <PaneView pane={pane} focused={panes.length > 1 && pane.id === focused} last={narrow || i === panes.length - 1} narrow={narrow} leading={narrow || i === 0} phone={phone} />
          </div>
        ))}
        {backend.kind === "memory" && <div className="web-mode">{t("settings.webMode")}</div>}
      </main>
      {phone ? <PhoneNav /> : <DetailsPanel />}
      {touch && <KeyboardBar />}
      <TabDragLayer />
      <SearchPalette />
      <ShellDialogs />
      <QuickCapture />
      <UpdatePrompt />
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
    </div>
  );
}
