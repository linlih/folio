import { Menu } from "@base-ui/react/menu";
import { CalendarDays, FileText, Layers, LayoutDashboard, Plus, Hash, LibraryBig, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { TagInfo } from "../bindings/commands";
import { CARDS_CHANGED, moveToTrash } from "../card/actions";
import { isPinned, setPin, usePins, usePinsLoader } from "../card/pins";
import { DOC_SAVED } from "../docs/persistence";
import { newTopic, useBoards, useTopics, useTopicsLoader } from "../docs/topics";
import { backend } from "../platform";
import { useTranslation } from "react-i18next";
import { SyncIndicator } from "../sync/SyncIndicator";
import { SettingsButton } from "./SettingsButton";
import { keyLabel, newCard, SIDEBAR_COMBO, toggleSidebar } from "./shortcuts";
import { focusedPane, tabKey, toSide, useShell, type TabTarget } from "./tabs";

/** A sidebar section; one with nothing in it is not shown (Claude's sidebar
 *  shows only what has content). */
function Section({ title, children }: { title: string; children: ReactNode[] }) {
  if (children.length === 0) return null;
  return (
    <section className="nav-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Tags in the sidebar: the most recently used. */
const SIDEBAR_TAGS = 12;

function useTags() {
  const [tags, setTags] = useState<TagInfo[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void backend.tags(SIDEBAR_TAGS).then(setTags, () => {});
    // Saves come every few hundred ms while typing; read once they settle.
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    load();
    window.addEventListener(CARDS_CHANGED, load);
    window.addEventListener(DOC_SAVED, soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARDS_CHANGED, load);
      window.removeEventListener(DOC_SAVED, soon);
    };
  }, []);
  return tags;
}

/** A card in the sidebar (pinned or recent); its actions appear on hover. */
function CardItem({ cardId, title, active }: { cardId: string; title: string | null; active: boolean }) {
  const { t } = useTranslation();
  const open = useShell((s) => s.open);
  const pins = usePins((s) => s.cards);
  const pinned = isPinned(pins, cardId);
  const shown = title || t("library.untitled");
  return (
    <div className="nav-row">
      <button className="nav-item" aria-current={active ? "page" : undefined} onClick={(e) => open({ kind: "card", cardId }, title, toSide(e))}>
        <FileText size={15} strokeWidth={1.75} />
        <span>{shown}</span>
      </button>
      <Menu.Root>
        <Menu.Trigger className="icon-button nav-row-menu" aria-label={t("nav.itemMenu")} title={t("nav.itemMenu")}>
          <MoreHorizontal size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4}>
            <Menu.Popup className="popup">
              <Menu.Item className="popup-item" onClick={() => void setPin(cardId, !pinned)}>
                {t(pinned ? "nav.unpin" : "nav.pin")}
              </Menu.Item>
              <Menu.Item className="popup-item" onClick={() => open({ kind: "card", cardId }, title, true)}>
                {t("tabs.openOther")}
              </Menu.Item>
              <Menu.Separator className="popup-separator" />
              <Menu.Item className="popup-item" onClick={() => void moveToTrash(cardId, title ?? "")}>
                {t("library.moveToTrash")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const tags = useTags();
  useTopicsLoader();
  const topics = useTopics((s) => s.topics);
  const counts = useTopics((s) => s.counts);
  const [naming, setNaming] = useState(false);
  const libraryTopic = useShell((s) => s.libraryTopic);
  const boards = useBoards((s) => s.boards);
  usePinsLoader();
  const pins = usePins((s) => s.cards);
  const { recent, open } = useShell();
  const sidebarOpen = useShell((s) => s.sidebarOpen);
  const active = useShell((s) => focusedPane(s).active);

  const navItem = (target: TabTarget, icon: ReactNode, label: string) => (
    <button className="nav-item" aria-current={active === tabKey(target) ? "page" : undefined} onClick={(e) => open(target, null, toSide(e))}>
      {icon}
      <span>{label}</span>
    </button>
  );

  const tagItem = (tag: TagInfo, count: number) => (
    <button
      key={tag.key}
      className="nav-item"
      aria-current={active === `tag:${tag.key}` ? "page" : undefined}
      onClick={(e) => open({ kind: "tag", name: tag.name }, null, toSide(e))}
    >
      <Hash size={15} strokeWidth={1.75} />
      <span>{tag.name}</span>
      <span className="nav-count">{count}</span>
    </button>
  );

  return (
    <nav className="sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
      {/* The top row: room for the traffic lights when the app draws the
          title bar (it drags the window), and the button that hides the sidebar. */}
      <div className="sidebar-top" data-tauri-drag-region>
        <button className="icon-button" title={`${t("nav.hideSidebar")} (${keyLabel(SIDEBAR_COMBO)})`} aria-label={t("nav.hideSidebar")} onClick={toggleSidebar}>
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="nav-search-row">
        <button className="nav-search" title={t("nav.search")} onClick={() => useShell.getState().setSearchOpen(true)}>
          <Search size={14} strokeWidth={1.75} />
          <span>{t("nav.search")}</span>
          <kbd>{keyLabel("Mod+K")}</kbd>
        </button>
        <button className="icon-button nav-new" title={`${t("nav.newCard")} (${keyLabel("Mod+N")})`} aria-label={t("nav.newCard")} onClick={() => void newCard()}>
          <SquarePen size={15} strokeWidth={1.75} />
        </button>
      </div>
      {navItem({ kind: "journal" }, <CalendarDays size={15} strokeWidth={1.75} />, t("nav.journal"))}
      {/* The library itself means all cards: leave any topic it was showing. */}
      <button
        className="nav-item"
        aria-current={active === "library" && !libraryTopic ? "page" : undefined}
        onClick={(e) => {
          useShell.getState().setLibraryTopic(null);
          open({ kind: "library" }, null, toSide(e));
        }}
      >
        <LibraryBig size={15} strokeWidth={1.75} />
        <span>{t("nav.library")}</span>
      </button>
      {navItem({ kind: "boards" }, <LayoutDashboard size={15} strokeWidth={1.75} />, t("nav.boards"))}

      <div className="nav-scroll">
        <Section title={t("nav.pinned")}>
          {pins.map((c) => (
            <CardItem key={c.id} cardId={c.id} title={c.title} active={active === `card:${c.id}`} />
          ))}
        </Section>
        {/* Like pinned and tags: shown once there is a topic (they are made
            in the card library). */}
        {(topics.length > 0 || naming) && (
          <section className="nav-section">
            <h2 className="nav-section-head">
              {t("nav.topics")}
              <button className="icon-button" title={t("topics.new")} aria-label={t("topics.new")} onClick={() => setNaming(true)}>
                <Plus size={13} />
              </button>
            </h2>
            {topics.map((topic) => (
              <button
                key={topic.id}
                className="nav-item"
                aria-current={active === "library" && libraryTopic === topic.id ? "page" : undefined}
                onClick={(e) => useShell.getState().openTopic(topic.id, toSide(e))}
              >
                <Layers size={15} strokeWidth={1.75} />
                <span>{topic.name}</span>
                <span className="nav-count">{counts[topic.id] ?? 0}</span>
              </button>
            ))}
            {naming && (
              <input
                className="nav-new-topic"
                autoFocus
                placeholder={t("topics.namePlaceholder")}
                onBlur={() => setNaming(false)}
                onKeyDown={async (e) => {
                  if (e.nativeEvent.isComposing) return;
                  const value = e.currentTarget.value.trim();
                  if (e.key === "Escape") setNaming(false);
                  if (e.key !== "Enter" || !value) return;
                  setNaming(false);
                  useShell.getState().openTopic(await newTopic(value));
                }}
              />
            )}
          </section>
        )}
        <Section title={t("nav.boards")}>
          {boards.map((b) => (
            <button
              key={b.id}
              className="nav-item"
              aria-current={active === `board:${b.id}` ? "page" : undefined}
              onClick={(e) => open({ kind: "board", boardId: b.id }, null, toSide(e))}
            >
              <LayoutDashboard size={15} strokeWidth={1.75} />
              <span>{b.name || t("board.untitled")}</span>
            </button>
          ))}
        </Section>
        <Section title={t("nav.tags")}>{tags.map((tag) => tagItem(tag, tag.blocks))}</Section>
        <Section title={t("nav.recent")}>
          {recent
            .filter((r) => !isPinned(pins, r.cardId))
            .map((r) => (
              <CardItem key={r.cardId} cardId={r.cardId} title={r.title} active={active === `card:${r.cardId}`} />
            ))}
        </Section>
      </div>

      <div className="nav-footer">
        {navItem({ kind: "trash" }, <Trash2 size={15} strokeWidth={1.75} />, t("nav.trash"))}
        <div className="nav-footer-row">
          <SettingsButton />
          <SyncIndicator />
        </div>
      </div>
    </nav>
  );
}

/** Shown at the start of the leftmost tab bar while the sidebar is hidden. */
export function ShowSidebarButton() {
  const { t } = useTranslation();
  return (
    <button className="icon-button show-sidebar" title={`${t("nav.showSidebar")} (${keyLabel(SIDEBAR_COMBO)})`} aria-label={t("nav.showSidebar")} onClick={toggleSidebar}>
      <PanelLeftOpen size={16} strokeWidth={1.75} />
    </button>
  );
}
