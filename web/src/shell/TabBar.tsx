import { ArrowLeftRight, Columns2, PanelRightOpen, RectangleHorizontal, X } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useTranslation } from "react-i18next";
import { copyMarkdown, exportCardMarkdown } from "../card/markdown";
import { useBoards } from "../docs/topics";
import { ShowSidebarButton } from "./Sidebar";
import { keyLabel, PANEL_COMBO, togglePanel } from "./shortcuts";
import { consumeClick, startTabDrag } from "./tabDrag";
import { SINGLE, useShell, type Pane, type Tab } from "./tabs";

export function useTabLabel() {
  const { t } = useTranslation();
  const boards = useBoards((s) => s.boards);
  return (tab: Tab) => {
    switch (tab.target.kind) {
      case "library":
        return t("nav.library");
      case "journal":
        return t("nav.journal");
      case "trash":
        return t("trash.title");
      case "inbox":
        return t("inbox.title");
      case "card":
        return tab.title || t("library.untitled");
      case "tag":
        return `#${tab.target.name}`;
      case "boards":
        return t("nav.boards");
      case "board":
        return boards.find((b) => b.id === (tab.target as { boardId: string }).boardId)?.name || t("board.untitled");
    }
  };
}

/** A tab with its right-click menu: copy or move it to the other pane, close. */
function TabItem({ pane, tab, label }: { pane: Pane; tab: Tab; label: string }) {
  const { t } = useTranslation();
  const { activate, close, focusPane, open, moveToOther } = useShell();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        role="tab"
        aria-selected={tab.key === pane.active}
        className="tab"
        tabIndex={0}
        onPointerDown={(e) => startTabDrag(e, tab.key, pane.id, label)}
        onClick={() => !consumeClick() && activate(tab.key, pane.id)}
        onAuxClick={(e) => e.button === 1 && close(tab.key, pane.id)}
        onKeyDown={(e) => e.key === "Enter" && activate(tab.key, pane.id)}
      >
        <span className="tab-title">{label}</span>
        <button
          className="icon-button tab-close"
          aria-label={t("tabs.close")}
          onClick={(e) => {
            e.stopPropagation();
            close(tab.key, pane.id);
          }}
        >
          <X size={13} />
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup className="popup">
            {!SINGLE.has(tab.target.kind) && (
              <ContextMenu.Item
                className="popup-item"
                onClick={() => {
                  focusPane(pane.id);
                  open(tab.target, tab.title, true);
                }}
              >
                {t("tabs.openOther")}
              </ContextMenu.Item>
            )}
            <ContextMenu.Item className="popup-item" onClick={() => moveToOther(tab.key, pane.id)}>
              {t("tabs.moveOther")}
            </ContextMenu.Item>
            {tab.target.kind === "card" && (
              <>
                <ContextMenu.Separator className="popup-separator" />
                <ContextMenu.Item className="popup-item" onClick={() => void copyMarkdown((tab.target as { cardId: string }).cardId)}>
                  {t("markdown.copy")}
                </ContextMenu.Item>
                <ContextMenu.Item className="popup-item" onClick={() => void exportCardMarkdown((tab.target as { cardId: string }).cardId, tab.title ?? "")}>
                  {t("markdown.export")}
                </ContextMenu.Item>
              </>
            )}
            <ContextMenu.Separator className="popup-separator" />
            <ContextMenu.Item className="popup-item" onClick={() => close(tab.key, pane.id)}>
              {t("tabs.close")}
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A pane's tabs. `narrow`: the panes don't fit side by side and only the
 *  focused one shows; a button switches to the other. */
export function TabBar({ pane, last, narrow, leading }: { pane: Pane; last: boolean; narrow: boolean; leading: boolean }) {
  const { t } = useTranslation();
  const { panes, toggleSplit, focusPane } = useShell();
  const label = useTabLabel();
  const split = panes.length > 1;
  // The leftmost bar takes the sidebar's place when it is hidden: room for
  // the traffic lights and the button that brings the sidebar back.
  const sidebarHidden = useShell((s) => !s.sidebarOpen) && leading;
  const panelOpen = useShell((s) => s.panelOpen);
  const other = panes.find((p) => p.id !== pane.id);

  return (
    // Its empty space drags the window (the tabs row is the title bar on macOS).
    <div className={`tabbar${sidebarHidden ? " sidebar-hidden" : ""}`} role="tablist" data-pane-id={pane.id} data-tauri-drag-region>
      {sidebarHidden && <ShowSidebarButton />}
      {pane.tabs.map((tab) => (
        <TabItem key={tab.key} pane={pane} tab={tab} label={label(tab)} />
      ))}
      <span className="tabbar-actions">
        {narrow && other && (
          <button className="icon-button" title={t("tabs.switchPane")} aria-label={t("tabs.switchPane")} onClick={() => focusPane(other.id)}>
            <ArrowLeftRight size={14} strokeWidth={1.75} />
          </button>
        )}
        {last && (
          <button
            className="icon-button"
            title={`${t(split ? "tabs.unsplit" : "tabs.split")} (⌘\\)`}
            aria-label={t(split ? "tabs.unsplit" : "tabs.split")}
            onClick={toggleSplit}
          >
            {split ? <RectangleHorizontal size={15} strokeWidth={1.75} /> : <Columns2 size={15} strokeWidth={1.75} />}
          </button>
        )}
        {last && !panelOpen && (
          <button className="icon-button" title={`${t("panel.show")} (${keyLabel(PANEL_COMBO)})`} aria-label={t("panel.show")} onClick={togglePanel}>
            <PanelRightOpen size={15} strokeWidth={1.75} />
          </button>
        )}
      </span>
    </div>
  );
}
