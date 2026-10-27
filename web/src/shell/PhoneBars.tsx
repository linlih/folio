import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, ChevronsDownUp, IndentDecrease, IndentIncrease, Keyboard, LayoutDashboard, LibraryBig, Search, Settings, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openQuickCapture } from "../capture/QuickCapture";
import { useTabLabel } from "./TabBar";
import { focusedPane, useShell, type Pane, type TabTarget } from "./tabs";
import "./phone.css";

/** The pages the bottom bar leads to; everything else is opened from them. */
const ROOTS: TabTarget["kind"][] = ["journal", "library", "boards"];
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

/** The bar at the top of a pane on a phone, in place of the tab bar:
 *  Back on a page opened from another, the page's name, and settings. */
export function PhoneTopBar({ pane }: { pane: Pane }) {
  const { t } = useTranslation();
  const label = useTabLabel();
  const setDialog = useShell((s) => s.setDialog);
  useHistory(pane);
  const tab = pane.tabs.find((x) => x.key === pane.active);
  if (!tab) return null;
  const root = isRoot(tab.target.kind);
  return (
    <header className="phone-top">
      {!root && (
        <button className="icon-button phone-back" aria-label={t("phone.back")} title={t("phone.back")} onClick={() => goBack(pane)}>
          <ChevronLeft size={20} />
        </button>
      )}
      {/* A whiteboard shows its own name, which can be edited there. */}
      <span className="phone-title">{root || tab.target.kind === "board" ? "" : label(tab)}</span>
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

/** The four entries at the bottom of a phone (§0.2), and the button that
 *  writes a quick note to today's journal. */
export function PhoneNav() {
  const { t } = useTranslation();
  const pane = useShell(focusedPane);
  const open = useShell((s) => s.open);
  const setSearchOpen = useShell((s) => s.setSearchOpen);
  const current = section(pane);
  const activeKind = pane.tabs.find((x) => x.key === pane.active)?.target.kind;
  const items: { kind: TabTarget["kind"]; label: string; icon: React.ReactNode }[] = [
    { kind: "journal", label: t("nav.journal"), icon: <CalendarDays size={21} strokeWidth={1.75} /> },
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
          <button key={it.kind} className="phone-nav-item" aria-current={current === it.kind ? "page" : undefined} onClick={() => open({ kind: it.kind } as TabTarget)}>
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

/** Scrolls the focused editor's caret into its scroller. */
function caretIntoView() {
  const sel = document.getSelection();
  const node = sel?.focusNode;
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  if (el?.closest(".ProseMirror, input, textarea")) el.scrollIntoView({ block: "nearest" });
}

/** A row above the on-screen keyboard while an editor has the focus on a
 *  touch screen: outdent, indent, move the item, fold, and put the keyboard
 *  away. Taps on it do not take the focus, so the keyboard stays. */
export function KeyboardBar() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const check = () => {
      const el = document.activeElement;
      const on = el instanceof HTMLElement && el.isContentEditable && !!el.closest(".ProseMirror");
      setEditing((was) => (was === on ? was : on));
      document.body.classList.toggle("phone-typing", on || (el instanceof HTMLElement && !!el.closest("input, textarea")));
    };
    const vv = window.visualViewport;
    const root = document.documentElement;
    // The keyboard covers the bottom of the layout; the bar sits on it.
    // iOS does not shrink the page for the keyboard but scrolls all of it,
    // top bar included, out of the way: the shell takes the height left
    // instead, and the page stays where it is.
    const place = () => {
      if (!vv) return;
      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setBottom(covered);
      root.style.setProperty("--keyboard", `${covered}px`);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      // The line being typed on may now be under the keyboard.
      if (covered > 0) caretIntoView();
    };
    // After focus has moved on (focusout comes before the new focusin).
    const later = () => setTimeout(check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", later);
    // A focused field that is removed (a dialog closing) sends no focusout.
    const poll = setInterval(check, 400);
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    return () => {
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", later);
      clearInterval(poll);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      document.body.classList.remove("phone-typing");
      root.style.removeProperty("--keyboard");
    };
  }, []);
  if (!editing) return null;
  // Acts as the finger goes down: keeping the focus (and the keyboard)
  // means cancelling that, and WebKit then sends no click. A click from the
  // keyboard (detail 0) still works.
  const key = (label: string, icon: React.ReactNode, run: () => void) => (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        run();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.detail === 0 && run()}
    >
      {icon}
    </button>
  );
  return (
    <div className="keyboard-bar" role="toolbar" aria-label={t("phone.keys")} style={{ bottom }}>
      {key(t("phone.outdent"), <IndentDecrease size={19} />, () => press("Tab", { shift: true }))}
      {key(t("phone.indent"), <IndentIncrease size={19} />, () => press("Tab"))}
      {key(t("phone.moveUp"), <ArrowUp size={19} />, () => press("ArrowUp", { alt: true, shift: true }))}
      {key(t("phone.moveDown"), <ArrowDown size={19} />, () => press("ArrowDown", { alt: true, shift: true }))}
      {key(t("phone.fold"), <ChevronsDownUp size={19} />, () => press(";", { mod: true }))}
      <span className="keyboard-bar-gap" />
      {key(t("phone.hideKeyboard"), <Keyboard size={19} />, () => (document.activeElement as HTMLElement | null)?.blur())}
    </div>
  );
}
