import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { openAt } from "./reveal";
import { pickHeading, useCurrentHeading } from "./tocState";
import "./toc.css";

export type Heading = { bid: string; level: number; text: string };

/** A card's headings, indented by level, the one being read marked by an
 *  accent segment on the line at their left (design/toc.md). A pick
 *  scrolls that heading to the top of the page. */
export function TocList({ cardId, title, pane, headings, onPick, scroller }: {
  cardId: string;
  title: string;
  pane: string;
  headings: Heading[];
  /** Before the jump (the phone sheet closes). */
  onPick?: () => void;
  /** Kept showing the current row: the list's scrolling box, if any. */
  scroller?: () => HTMLElement | null;
}) {
  const current = useCurrentHeading(pane, cardId);
  const list = useRef<HTMLUListElement>(null);
  const [mark, setMark] = useState<{ top: number; height: number } | null>(null);
  const top = Math.min(...headings.map((h) => h.level));

  useLayoutEffect(() => {
    const row = current ? list.current?.querySelector<HTMLElement>(`li[data-bid="${CSS.escape(current)}"]`) : null;
    if (!row) return setMark(null);
    setMark({ top: row.offsetTop, height: row.offsetHeight });
    // Only the list's own box scrolls, never the page behind it.
    const box = scroller?.();
    if (!box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top;
    else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - (b.bottom - 8);
  }, [current, headings, scroller]);

  const pick = (bid: string) => {
    onPick?.();
    pickHeading(pane, cardId, bid);
    openAt(cardId, title, bid, false, "start");
  };

  return (
    <ul ref={list} className="toc">
      <span className="toc-mark" aria-hidden style={mark ? { transform: `translateY(${mark.top}px)`, height: mark.height } : { opacity: 0 }} />
      {headings.map((h) => (
        <li key={h.bid} data-bid={h.bid} className={`toc-d${Math.min(h.level - top, 2)}${h.bid === current ? " current" : ""}`}>
          <button onClick={() => pick(h.bid)} title={h.text} aria-current={h.bid === current ? "location" : undefined}>
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Dragged down this far, the sheet closes. */
const DISMISS_PX = 80;

/** On a phone: the table of contents in a sheet from the bottom, from the
 *  card's ⋯ menu. A pick closes it; so do a tap outside, a drag down,
 *  Escape and Android's Back. */
export function TocSheet({ cardId, title, pane, headings, onClose }: { cardId: string; title: string; pane: string; headings: Heading[]; onClose: () => void }) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => sheet.current?.focus({ preventScroll: true }), []);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const down = (e: ReactPointerEvent) => {
    start.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent) => {
    if (start.current !== null) setDrag(Math.max(0, e.clientY - start.current));
  };
  const up = () => {
    if (start.current === null) return;
    start.current = null;
    if (drag > DISMISS_PX) onClose();
    else setDrag(0);
  };
  return createPortal(
    <div className="toc-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="toc-sheet"
        role="dialog"
        aria-label={t("panel.outline")}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        tabIndex={-1}
        ref={sheet}
      >
        <div className="toc-sheet-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span className="toc-sheet-grab" />
          <h2>{t("panel.outline")}</h2>
        </div>
        <div className="toc-sheet-body" ref={body}>
          <TocList cardId={cardId} title={title} pane={pane} headings={headings} onPick={onClose} scroller={() => body.current} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
