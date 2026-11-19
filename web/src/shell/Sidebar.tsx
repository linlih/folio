import { Menu } from "@base-ui/react/menu";
import { CalendarDays, ChevronRight, FileText, Filter, Layers, LayoutDashboard, Plus, Hash, LibraryBig, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, SquarePen, SquareCheck, Trash2, Inbox } from "lucide-react";
import { useInboxCount } from "../inbox/clip";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TagInfo } from "../bindings/commands";
import { CARDS_CHANGED, moveToTrash } from "../card/actions";
import { isPinned, movePin, setPin, usePins, usePinsLoader, type PinQuery } from "../card/pins";
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

/** A mouse moves this far before a press becomes a drag. */
const DRAG_SLOP = 4;
/** A finger holds still this long to pick a pin up (as the long press
 *  that opens menus elsewhere, shell/longPress.ts); moving sooner scrolls. */
const HOLD_MS = 450;
const HOLD_SLOP = 10;

/** Pinned cards, in the order the person drags them into: in the sidebar,
 *  and on a phone (which has none) at the top of the card library. */
export function PinnedSection({ active, className }: { active: string | null; className?: string }) {
  const { t } = useTranslation();
  const pins = usePins((s) => s.cards);
  const queries = usePins((s) => s.queries);
  const box = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number; before: string | null } | null>(null);
  const dragging = useRef(false);

  // While a pin is lifted, the finger moves it rather than scrolling the
  // sidebar: a listener that may cancel touchmove (React's is passive).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = (e: TouchEvent) => dragging.current && e.cancelable && e.preventDefault();
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, [pins.length > 0]);

  const start = (id: string) => (down: React.PointerEvent) => {
    if (down.button !== 0 || !down.isPrimary || (down.target as Element).closest(".nav-row-menu")) return;
    const touch = down.pointerType === "touch";
    const rows = [...(box.current?.querySelectorAll<HTMLElement>("[data-pin]") ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.pin!, mid: r.top + r.height / 2 };
    });
    const x0 = down.clientX;
    const y0 = down.clientY;
    let lifted = false;
    let before: string | null = null;
    const lift = () => {
      lifted = dragging.current = true;
      document.documentElement.classList.add("pin-dragging");
    };
    const timer = touch ? setTimeout(lift, HOLD_MS) : undefined;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      const far = Math.hypot(e.clientX - x0, e.clientY - y0);
      if (!lifted) {
        if (touch) return void (far > HOLD_SLOP && end());
        if (far < DRAG_SLOP) return;
        lift();
      }
      // The first row whose middle is below the pointer goes after it.
      const next = rows.find((r) => r.id !== id && r.mid > e.clientY);
      before = next?.id ?? null;
      setDrag({ id, dy: e.clientY - y0, before });
    };
    const end = (e?: PointerEvent) => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.documentElement.classList.remove("pin-dragging");
      dragging.current = false;
      setDrag(null);
      if (!lifted) return;
      // The press that dragged does not also open the card.
      const swallow = (c: MouseEvent) => (c.preventDefault(), c.stopPropagation());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (e && e.type === "pointerup") void movePin(id, before);
    };
    const cancel = () => end();
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel, true);
  };

  if (pins.length === 0) return null;
  // Where it would land; nothing shown where it already is.
  const order = pins.map((c) => c.id);
  const from = drag ? order.indexOf(drag.id) : -1;
  const landing = drag && (drag.before === null ? order.length : order.indexOf(drag.before));
  const shows = drag !== null && landing !== from && landing !== from + 1;
  return (
    <section className={`nav-section${className ? ` ${className}` : ""}`} ref={box}>
      <h2>{t("nav.pinned")}</h2>
      {pins.map((c) => (
        <div key={c.id}>
          {shows && drag.before === c.id && <div className="pin-drop" />}
          <CardItem
            cardId={c.id}
            title={c.title}
            active={active === `card:${c.id}`}
            query={queries[c.id]}
            drag={{
              onPointerDown: start(c.id),
              className: drag?.id === c.id ? "pin-lifted" : undefined,
              style: drag?.id === c.id ? { transform: `translateY(${drag.dy}px)` } : undefined,
            }}
          />
        </div>
      ))}
      {shows && drag.before === null && <div className="pin-drop" />}
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
function CardItem({
  cardId,
  title,
  active,
  query,
  drag,
}: {
  cardId: string;
  title: string | null;
  active: boolean;
  /** A pinned card with a query block: what it finds. */
  query?: PinQuery;
  /** Pinned cards can be dragged into another order. */
  drag?: { onPointerDown(e: React.PointerEvent): void; style?: React.CSSProperties; className?: string };
}) {
  const { t } = useTranslation();
  const open = useShell((s) => s.open);
  const pins = usePins((s) => s.cards);
  const pinned = isPinned(pins, cardId);
  const shown = title || t("library.untitled");
  return (
    <div className={`nav-row${drag?.className ? ` ${drag.className}` : ""}`} data-pin={drag ? cardId : undefined} style={drag?.style} onPointerDown={drag?.onPointerDown}>
      <button className="nav-item" aria-current={active ? "page" : undefined} onClick={(e) => open({ kind: "card", cardId }, title, toSide(e))}>
        {query ? <Filter size={15} strokeWidth={1.75} /> : <FileText size={15} strokeWidth={1.75} />}
        <span>{shown}</span>
        {query && query.count !== null && (
          <span className={`nav-count${query.overdue ? " late" : ""}`} title={query.overdue ? t("nav.pinOverdue") : undefined}>
            {query.count}
          </span>
        )}
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
  /** Topics whose sub-topics are folded away. */
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const libraryTopic = useShell((s) => s.libraryTopic);
  const boards = useBoards((s) => s.boards);
  usePinsLoader();
  const pins = usePins((s) => s.cards);
  const { recent, open } = useShell();
  const sidebarOpen = useShell((s) => s.sidebarOpen);
  const active = useShell((s) => focusedPane(s).active);
  const inboxCount = useInboxCount((s) => s.count);

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
      <button className="nav-item" aria-current={active === "inbox" ? "page" : undefined} onClick={(e) => open({ kind: "inbox" }, null, toSide(e))}>
        <Inbox size={15} strokeWidth={1.75} />
        <span>{t("nav.inbox")}</span>
        {inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
      </button>
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
      {navItem({ kind: "tasks" }, <SquareCheck size={15} strokeWidth={1.75} />, t("nav.tasks"))}
      {navItem({ kind: "boards" }, <LayoutDashboard size={15} strokeWidth={1.75} />, t("nav.boards"))}

      <div className="nav-scroll">
        <PinnedSection active={active} />
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
            {/* Two levels: a topic with sub-topics folds them away. */}
            {topics
              .filter((topic) => !topic.parent)
              .map((topic) => {
                const subs = topics.filter((x) => x.parent === topic.id);
                const item = (x: typeof topic, sub: boolean) => (
                  <button
                    key={x.id}
                    className={`nav-item${sub ? " nav-sub" : ""}`}
                    aria-current={active === "library" && libraryTopic === x.id ? "page" : undefined}
                    onClick={(e) => useShell.getState().openTopic(x.id, toSide(e))}
                  >
                    <Layers size={15} strokeWidth={1.75} />
                    <span>{x.name}</span>
                    <span className="nav-count">{counts[x.id] ?? 0}</span>
                  </button>
                );
                if (subs.length === 0) return item(topic, false);
                const open = !folded.has(topic.id);
                const label = t(open ? "topics.foldSubs" : "topics.unfoldSubs", { name: topic.name });
                return (
                  <div key={topic.id}>
                    <div className="nav-row">
                      {item(topic, false)}
                      <button
                        className="icon-button nav-fold"
                        aria-expanded={open}
                        aria-label={label}
                        title={label}
                        onClick={() =>
                          setFolded((f) => {
                            const next = new Set(f);
                            if (!next.delete(topic.id)) next.add(topic.id);
                            return next;
                          })
                        }
                      >
                        <ChevronRight size={14} strokeWidth={2} />
                      </button>
                    </div>
                    {open && subs.map((x) => item(x, true))}
                  </div>
                );
              })}
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
