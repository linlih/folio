import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, ChevronsDownUp, Hash, ImagePlus, IndentDecrease, IndentIncrease, Keyboard, LayoutDashboard, LibraryBig, Redo2, Search, Settings, Slash, SquareCheck, SquarePen, Undo2, Inbox } from "lucide-react";
import { useInboxCount } from "../inbox/clip";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openQuickCapture } from "../capture/QuickCapture";
import { useTopics } from "../docs/topics";
import { addFiles, pickFiles } from "../editor/assets";
import { useTabLabel } from "./TabBar";
import { focusedPane, useShell, type Pane, type TabTarget } from "./tabs";
import "./phone.css";

/** The pages the bottom bar leads to; everything else is opened from them. */
const ROOTS: TabTarget["kind"][] = ["journal", "inbox", "library", "boards"];
const isRoot = (kind: TabTarget["kind"]) => ROOTS.includes(kind);
/** Every open tab stays mounted (its editors keep their state); on a phone
 *  only this many are kept, the longest unused closing first. */
const KEEP_TABS = 8;

/** Where each pane has been, newest last: Back returns along it. */
const visited = new Map<string, string[]>();

function useHistory(pane: Pane) {
  useEffect(() => {
    const list = (visited.get(pane.id) ?? []).filter((k) => k !== pane.active && pane.tabs.some((t) => t.key === k));
    list.push(pane.active);
    visited.set(pane.id, list);
    // Too many tabs open: close the ones not used for longest.
    const extra = pane.tabs.filter((t) => !isRoot(t.target.kind) && t.key !== pane.active);
    if (pane.tabs.length > KEEP_TABS) {
      const order = (k: string) => list.indexOf(k);
      const close = useShell.getState().close;
      for (const t of extra.sort((a, b) => order(a.key) - order(b.key)).slice(0, pane.tabs.length - KEEP_TABS)) close(t.key, pane.id);
    }
  }, [pane]);
}

/** Back: closes this page and shows the one before it. */
function goBack(pane: Pane) {
  const s = useShell.getState();
  const list = (visited.get(pane.id) ?? []).filter((k) => k !== pane.active && pane.tabs.some((t) => t.key === k));
  const previous = list.at(-1);
  s.close(pane.active, pane.id);
  if (previous) s.activate(previous, pane.id);
}

/** A topic of the card library is open in `pane`: the one it is in. */
function topicUp(pane: Pane): { parent: string | null } | null {
  const { libraryTopic } = useShell.getState();
  const tab = pane.tabs.find((x) => x.key === pane.active);
  if (tab?.target.kind !== "library" || !libraryTopic) return null;
  return { parent: useTopics.getState().topics.find((x) => x.id === libraryTopic)?.parent ?? null };
}

/** The top bar's Back, for Android's Back too (androidBack.ts). False on a
 *  page of the bottom bar, where there is nowhere to go back to. */
export function goBackFrom(pane: Pane): boolean {
  const up = topicUp(pane);
  if (up) {
    useShell.getState().setLibraryTopic(up.parent);
    return true;
  }
  const tab = pane.tabs.find((x) => x.key === pane.active);
  if (!tab || isRoot(tab.target.kind)) return false;
  goBack(pane);
  return true;
}

/** The bar at the top of a pane on a phone, in place of the tab bar:
 *  Back on a page opened from another (and inside a topic of the card
 *  library, up to its parent topic or the library), the page's name, and
 *  settings. */
export function PhoneTopBar({ pane }: { pane: Pane }) {
  const { t } = useTranslation();
  const label = useTabLabel();
  const setDialog = useShell((s) => s.setDialog);
  const libraryTopic = useShell((s) => s.libraryTopic);
  useHistory(pane);
  const tab = pane.tabs.find((x) => x.key === pane.active);
  if (!tab) return null;
  const inTopic = tab.target.kind === "library" && !!libraryTopic;
  const root = isRoot(tab.target.kind) && !inTopic;
  const back = () => goBackFrom(pane);
  return (
    <header className="phone-top">
      {!root && (
        <button className="icon-button phone-back" aria-label={t("phone.back")} title={t("phone.back")} onClick={back}>
          <ChevronLeft size={20} />
        </button>
      )}
      {/* A whiteboard and a topic show their own names, on the page. */}
      <span className="phone-title">{root || inTopic || tab.target.kind === "board" ? "" : label(tab)}</span>
      {root && (
        <button className="icon-button" aria-label={t("settings.title")} title={t("settings.title")} onClick={() => setDialog({ kind: "settings" })}>
          <Settings size={18} />
        </button>
      )}
    </header>
  );
}

/** The section a page belongs to: its own kind, or the last section page
 *  visited before it (a card opened from the journal is in the journal). */
function section(pane: Pane): TabTarget["kind"] | null {
  const kindOf = (key: string) => pane.tabs.find((t) => t.key === key)?.target.kind;
  const active = kindOf(pane.active);
  if (active && isRoot(active)) return active;
  const list = visited.get(pane.id) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = kindOf(list[i]);
    if (k && isRoot(k)) return k;
  }
  return active === "board" ? "boards" : null;
}

/** The five entries at the bottom of a phone (§0.2), and the button that
 *  writes a quick note to today's journal. */
export function PhoneNav() {
  const { t } = useTranslation();
  const pane = useShell(focusedPane);
  const open = useShell((s) => s.open);
  const setSearchOpen = useShell((s) => s.setSearchOpen);
  const current = section(pane);
  const activeKind = pane.tabs.find((x) => x.key === pane.active)?.target.kind;
  const inboxCount = useInboxCount((s) => s.count);
  const items: { kind: TabTarget["kind"]; label: string; icon: React.ReactNode }[] = [
    { kind: "journal", label: t("nav.journal"), icon: <CalendarDays size={21} strokeWidth={1.75} /> },
    {
      kind: "inbox",
      label: t("nav.inbox"),
      icon: (
        <span className="phone-nav-icon">
          <Inbox size={21} strokeWidth={1.75} />
          {inboxCount > 0 && <span className="phone-nav-badge">{inboxCount > 99 ? "99+" : inboxCount}</span>}
        </span>
      ),
    },
    { kind: "library", label: t("nav.library"), icon: <LibraryBig size={21} strokeWidth={1.75} /> },
    { kind: "boards", label: t("nav.boards"), icon: <LayoutDashboard size={21} strokeWidth={1.75} /> },
  ];
  return (
    <>
      {(activeKind === "journal" || activeKind === "library") && (
        <button className="phone-capture" aria-label={t("capture.title")} title={t("capture.title")} onClick={openQuickCapture}>
          <SquarePen size={22} />
        </button>
      )}
      <nav className="phone-nav" aria-label={t("phone.nav")}>
        {items.map((it) => (
          <button
            key={it.kind}
            className="phone-nav-item"
            aria-current={current === it.kind ? "page" : undefined}
            onClick={() => {
              // The card library means its home, not the topic last shown.
              if (it.kind === "library") useShell.getState().setLibraryTopic(null);
              open({ kind: it.kind } as TabTarget);
            }}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
        <button className="phone-nav-item" onClick={() => setSearchOpen(true)}>
          <Search size={21} strokeWidth={1.75} />
          <span>{t("phone.search")}</span>
        </button>
      </nav>
    </>
  );
}

/** Keys a phone keyboard does not have, for the outline: sent to the editor
 *  as the key presses they stand for, so they do exactly what the keys do. */
const apple = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
function press(key: string, mods: { shift?: boolean; alt?: boolean; mod?: boolean } = {}) {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: !!mods.mod && apple,
      ctrlKey: !!mods.mod && !apple,
    }),
  );
}

/** The editor that has the focus. */
function focusedEditor(): Editor | null {
  const el = document.activeElement?.closest(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null | undefined;
  return el?.editor ?? null;
}

/** Types `text` into the focused editor as if from the keyboard, so pairing
 *  and the suggestion menus react as they do to typing ("[[" opens the card
 *  search). `word` starts a new word first: "#" and "/" open their menus
 *  only there. */
function typeText(text: string, word = false) {
  const view = focusedEditor()?.view;
  if (!view) return;
  const { $from } = view.state.selection;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, "", "￼");
  const chars = [...(word && before && !/\s/.test(before) ? " " : ""), ...text];
  for (const ch of chars) {
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(ch, from, to);
    if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch, deflt))) view.dispatch(deflt());
  }
}

/** Adds pictures from the phone's photos or camera to the focused editor. */
async function addImages() {
  const view = focusedEditor()?.view;
  if (!view) return;
  const files = await pickFiles("image/*");
  if (files.length) await addFiles(view, files);
}

/** A finger that moves this far is scrolling the bar, not tapping a key. */
const TAP_SLOP = 10;

/** The on-screen keyboard counts as up from this many pixels: less is an
 *  attached keyboard's shortcut strip, or nothing. */
const KEYBOARD_MIN = 100;
/** Room kept below the caret while typing, above the keys bar. */
const CARET_ROOM = 72;

/** Where the caret is on screen: the end of the selection, or the line it
 *  sits on when that has no box (an empty line). */
function caretRect(): DOMRect | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rect = range.getClientRects()[0];
  if (rect && (rect.height > 0 || rect.top > 0)) return rect;
  const node = sel.focusNode;
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return el?.getBoundingClientRect() ?? null;
}

/** The element that scrolls `el` up and down. */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Keeps the caret of the focused editor in sight while typing: as the
 *  line grows or wraps, while a word is being composed, and when the
 *  keyboard comes up, with some room below it above the keys bar. Fields
 *  just come into view. */
function caretIntoView() {
  const sel = document.getSelection();
  const node = sel?.focusNode;
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  if (!el) return;
  if (!el.closest(".ProseMirror")) {
    if (el.closest("input, textarea")) el.scrollIntoView({ block: "nearest" });
    return;
  }
  const rect = caretRect();
  const scroller = scrollerOf(el);
  if (!rect || !scroller) return;
  const box = scroller.getBoundingClientRect();
  const vv = window.visualViewport;
  const bar = document.querySelector(".keyboard-bar")?.getBoundingClientRect().top;
  const bottom = Math.min(box.bottom, bar ?? Infinity, vv ? vv.offsetTop + vv.height : Infinity);
  // Not more room than half of what shows (a small window).
  const room = Math.min(CARET_ROOM, (bottom - box.top) / 2);
  if (rect.bottom > bottom - room) scroller.scrollTop += rect.bottom - (bottom - room);
  else if (rect.top < box.top + 8) scroller.scrollTop -= box.top + 8 - rect.top;
}

/** A row above the on-screen keyboard while it is up for an editor on a
 *  touch screen: keys the phone keyboard lacks or hides (outline moves,
 *  links, tags, commands, tasks, pictures, undo), scrolled sideways, and
 *  putting the keyboard away at its end. Taps on it do not take the focus,
 *  so the keyboard stays. With the keyboard down the bottom bar shows
 *  instead. */
export function KeyboardBar() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [bottom, setBottom] = useState(0);
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    // How far the keyboard covers the page, and how tall it is: on iOS the
    // same, while Android usually shrinks the page instead, so nothing is
    // covered and the keyboard shows as the page being shorter than it was
    // at this width.
    let covered = 0;
    let keyboardHeight = 0;
    let tallest = { width: 0, height: 0 };
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Typing means a field has the focus and the on-screen keyboard is up.
    // With it put away (or a keyboard attached) the bottom bar is back,
    // even while the editor keeps the focus.
    const check = () => {
      const el = document.activeElement;
      const field = el instanceof HTMLElement && (el.isContentEditable || !!el.closest("input, textarea"));
      const keyboard = keyboardHeight >= KEYBOARD_MIN;
      const on = keyboard && el instanceof HTMLElement && el.isContentEditable && !!el.closest(".ProseMirror");
      setEditing((was) => (was === on ? was : on));
      document.body.classList.toggle("phone-typing", keyboard && field);
    };
    // The keyboard covers the bottom of the layout; the bar sits on it.
    // iOS does not shrink the page for the keyboard but scrolls all of it,
    // top bar included, out of the way: the shell takes the height left
    // instead, and the page stays where it is.
    const place = () => {
      if (!vv) return;
      const was = keyboardHeight;
      if (window.innerWidth !== tallest.width) tallest = { width: window.innerWidth, height: 0 };
      tallest.height = Math.max(tallest.height, window.innerHeight);
      covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      keyboardHeight = Math.max(covered, Math.round(tallest.height - vv.height));
      setBottom(covered);
      root.style.setProperty("--keyboard", `${covered}px`);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      check();
      // The line being typed on may now be under the keyboard (after the
      // shell has taken its new height, and again once iOS has done its
      // own scrolling for the keyboard).
      if (keyboardHeight > was) {
        requestAnimationFrame(caretIntoView);
        clearTimeout(settle);
        settle = setTimeout(caretIntoView, 400);
      }
    };
    // As the caret moves while typing (selectionchange comes for each
    // letter, and while a word is composed), it stays in sight.
    let pending = 0;
    // Not while a selection is being dragged out: that scrolls by itself.
    const follow = () => {
      if (keyboardHeight < KEYBOARD_MIN || pending || !document.getSelection()?.isCollapsed) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        caretIntoView();
      });
    };
    // After focus has moved on (focusout comes before the new focusin).
    const later = () => setTimeout(check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", later);
    document.addEventListener("selectionchange", follow);
    document.addEventListener("input", follow);
    // A focused field that is removed (a dialog closing) sends no focusout.
    const poll = setInterval(check, 400);
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    place();
    return () => {
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", later);
      document.removeEventListener("selectionchange", follow);
      document.removeEventListener("input", follow);
      cancelAnimationFrame(pending);
      clearTimeout(settle);
      clearInterval(poll);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      document.body.classList.remove("phone-typing");
      root.style.removeProperty("--keyboard");
    };
  }, []);
  if (!editing) return null;
  // Keeping the focus (and the keyboard) means cancelling the finger going
  // down, and WebKit then sends no click: a key acts as the finger lifts,
  // unless it moved (the row was scrolled; the browser then also cancels
  // the pointer). A click from the keyboard (detail 0) still works.
  const key = (label: string, icon: React.ReactNode, run: () => void) => (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        tap.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const start = tap.current;
        tap.current = null;
        if (start?.id === e.pointerId && Math.hypot(e.clientX - start.x, e.clientY - start.y) < TAP_SLOP) run();
      }}
      onPointerCancel={() => (tap.current = null)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.detail === 0 && run()}
    >
      {icon}
    </button>
  );
  const glyph = (text: string) => <span className="keyboard-bar-glyph">{text}</span>;
  return (
    <div className="keyboard-bar" role="toolbar" aria-label={t("phone.keys")} style={{ bottom }}>
      <div className="keyboard-bar-keys">
        {key(t("phone.outdent"), <IndentDecrease size={19} />, () => press("Tab", { shift: true }))}
        {key(t("phone.indent"), <IndentIncrease size={19} />, () => press("Tab"))}
        {key(t("phone.task"), <SquareCheck size={19} />, () => press("Enter", { mod: true }))}
        {key(t("phone.link"), glyph("[["), () => typeText("[["))}
        {key(t("phone.tag"), <Hash size={19} />, () => typeText("#", true))}
        {key(t("phone.command"), <Slash size={19} />, () => typeText("/", true))}
        {key(t("phone.image"), <ImagePlus size={19} />, () => void addImages())}
        {key(t("phone.undo"), <Undo2 size={19} />, () => press("z", { mod: true }))}
        {key(t("phone.redo"), <Redo2 size={19} />, () => press("z", { mod: true, shift: true }))}
        {key(t("phone.moveUp"), <ArrowUp size={19} />, () => press("ArrowUp", { alt: true, shift: true }))}
        {key(t("phone.moveDown"), <ArrowDown size={19} />, () => press("ArrowDown", { alt: true, shift: true }))}
        {key(t("phone.fold"), <ChevronsDownUp size={19} />, () => press(";", { mod: true }))}
        {key(t("phone.blockRef"), glyph("(("), () => typeText("(("))}
      </div>
      {key(t("phone.hideKeyboard"), <Keyboard size={19} />, () => (document.activeElement as HTMLElement | null)?.blur())}
    </div>
  );
}
