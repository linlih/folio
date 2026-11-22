// The table of contents (design/toc.md): which heading of a card the reader
// is at, kept per pane and card, for the details panel and the phone sheet.

import type { EditorView } from "@tiptap/pm/view";
import { useEffect, type RefObject } from "react";
import { create } from "zustand";

/** A heading as laid out, relative to the top of the scrolling page. */
export interface HeadingBox {
  bid: string;
  top: number;
  /** 0 when hidden (inside a collapsed item, or outside a focused one). */
  height: number;
}

/** The heading the reader is in: the last shown heading that has reached
 *  `line` (a quarter down the page), or the last one once the page is
 *  scrolled to its end; null above the first. Hidden headings never count:
 *  they lie at 0 and would win. */
export function currentHeading(boxes: HeadingBox[], line: number, atEnd: boolean): string | null {
  const shown = boxes.filter((b) => b.height > 0);
  if (atEnd && shown.length) return shown[shown.length - 1].bid;
  let current: string | null = null;
  for (const b of shown) {
    if (b.top <= line) current = b.bid;
    else break;
  }
  return current;
}

export const tocSlot = (pane: string, cardId: string) => `${pane}\n${cardId}`;
const slot = tocSlot;

interface TocState {
  current: Record<string, string | null>;
  /** Until when (ms) a picked heading holds while the page scrolls to it,
   *  so the sections passed on the way don't flicker by. */
  held: Record<string, number>;
  /** On a phone: cards with enough headings for a table of contents (two
   *  or more), and the one whose sheet is open. */
  offered: Record<string, boolean>;
  sheet: string | null;
}

const useToc = create<TocState>(() => ({ current: {}, held: {}, offered: {}, sheet: null }));

export const useTocOffered = (key: string | null) => useToc((s) => (key ? !!s.offered[key] : false));
export const useTocSheetOpen = (key: string) => useToc((s) => s.sheet === key);
export const setTocSheet = (key: string | null) => useToc.setState({ sheet: key });
export function offerToc(key: string, offered: boolean) {
  const s = useToc.getState();
  if (!!s.offered[key] !== offered) useToc.setState({ offered: { ...s.offered, [key]: offered } });
}

const HOLD_MS = 1500;

export const useCurrentHeading = (pane: string, cardId: string) => useToc((s) => s.current[slot(pane, cardId)] ?? null);

/** Marks a picked heading current at once and keeps it while the page
 *  scrolls there. */
export function pickHeading(pane: string, cardId: string, bid: string) {
  const key = slot(pane, cardId);
  useToc.setState((s) => ({ current: { ...s.current, [key]: bid }, held: { ...s.held, [key]: Date.now() + HOLD_MS } }));
}

function setCurrent(key: string, bid: string | null) {
  const s = useToc.getState();
  if ((s.held[key] ?? 0) > Date.now() || s.current[key] === bid) return;
  useToc.setState({ current: { ...s.current, [key]: bid } });
}

function release(key: string) {
  const s = useToc.getState();
  if (s.held[key]) useToc.setState({ held: { ...s.held, [key]: 0 } });
}

/** The headings of the editor's own document as laid out in `page`. */
function measure(view: EditorView, page: HTMLElement): HeadingBox[] {
  const top = page.getBoundingClientRect().top;
  const boxes: HeadingBox[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name !== "heading") return true;
    const dom = view.nodeDOM(pos);
    if (n.attrs.bid && n.textContent.trim() && dom instanceof HTMLElement) {
      const r = dom.getBoundingClientRect();
      boxes.push({ bid: n.attrs.bid as string, top: r.top - top, height: r.height });
    }
    return false;
  });
  return boxes;
}

/** Follows the reader through a card's headings while its tab shows. */
export function useHeadingTracker(pane: string, cardId: string, view: EditorView | null, root: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const page = root.current?.closest<HTMLElement>(".view");
    if (!active || !page || !view) return;
    const key = slot(pane, cardId);
    let frame = 0;
    const update = () => {
      frame = 0;
      if (view.isDestroyed || page.hidden) return;
      const atEnd = page.scrollTop > 0 && page.scrollTop + page.clientHeight >= page.scrollHeight - 2;
      setCurrent(key, currentHeading(measure(view, page), page.clientHeight / 4, atEnd));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // The scroll to a picked heading is over: what was picked stays until
    // the reader scrolls on, even when the page could not bring it to the top.
    const ended = () => release(key);
    page.addEventListener("scroll", schedule, { passive: true });
    page.addEventListener("scrollend", ended);
    // Headings added, removed, unfolded: once typing settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(schedule, 300);
    };
    const observer = new MutationObserver(changed);
    observer.observe(view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-collapsed", "class"] });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      page.removeEventListener("scroll", schedule);
      page.removeEventListener("scrollend", ended);
    };
  }, [pane, cardId, view, root, active]);
}
