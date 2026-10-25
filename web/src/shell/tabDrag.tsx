// Dragging tabs (§0.2): to another place in a tab bar, to the other pane,
// or to the right half of a single pane to split. Pointer events rather than
// HTML5 drag and drop: WebKit cancels a native drag when its source is
// redrawn, and the tab bars redraw as the target changes.

import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useShell, type TabDrop } from "./tabs";

/** Movement before a press becomes a drag (a click stays a click). */
const THRESHOLD = 5;
/** In a single pane, dropping in this right part of it splits. */
const SPLIT_ZONE = 0.6;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Drag {
  key: string;
  from: string;
  label: string;
  x: number;
  y: number;
  drop: TabDrop | null;
  /** Where the drop would land: a line in a tab bar, or an area. */
  mark: (Rect & { kind: "line" | "area" }) | null;
}

const useTabDrag = create<{ drag: Drag | null }>(() => ({ drag: null }));

const box = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** What is under the pointer, and how it would look. */
function target(x: number, y: number): Pick<Drag, "drop" | "mark"> {
  const under = document.elementFromPoint(x, y);
  const bar = under?.closest<HTMLElement>(".tabbar[data-pane-id]");
  if (bar) {
    const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")];
    let index = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    if (index < 0) index = tabs.length;
    const barRect = bar.getBoundingClientRect();
    const edge = tabs[index]?.getBoundingClientRect().left ?? (tabs.at(-1)?.getBoundingClientRect().right ?? barRect.left + 10) + 2;
    const tabRect = tabs[0]?.getBoundingClientRect() ?? barRect;
    return { drop: { pane: bar.dataset.paneId!, index }, mark: { kind: "line", left: edge - 1, top: tabRect.top, width: 2, height: tabRect.height } };
  }
  const slot = under?.closest<HTMLElement>(".pane-slot[data-pane]");
  if (!slot) return { drop: null, mark: null };
  const { panes } = useShell.getState();
  const r = slot.getBoundingClientRect();
  if (panes.length === 1) {
    if (x < r.left + r.width * SPLIT_ZONE) return { drop: null, mark: null };
    return { drop: { newPane: true }, mark: { kind: "area", left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height } };
  }
  return { drop: { pane: slot.dataset.pane! }, mark: { kind: "area", ...box(r) } };
}

/** Pointer-down handler for a tab: past a few pixels of movement the press
 *  becomes a drag; Esc cancels it. */
export function startTabDrag(e: ReactPointerEvent<HTMLElement>, key: string, from: string, label: string) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
  const el = e.currentTarget;
  const pointer = e.pointerId;
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
      dragging = true;
      el.setPointerCapture(pointer);
      // WebKit would otherwise extend a text selection into the cards the
      // pointer passes over.
      document.body.classList.add("tab-dragging");
      getSelection()?.removeAllRanges();
    }
    useTabDrag.setState({ drag: { key, from, label, x: ev.clientX, y: ev.clientY, ...target(ev.clientX, ev.clientY) } });
  };
  const end = (ev: PointerEvent | KeyboardEvent) => {
    if ("pointerId" in ev && ev.pointerId !== pointer) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", onKey);
    document.body.classList.remove("tab-dragging");
    const drag = useTabDrag.getState().drag;
    useTabDrag.setState({ drag: null });
    if (!dragging) return;
    // The click that ends a drag must not also activate; if none comes
    // (released elsewhere), the next real click still counts.
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 300);
    if (ev.type === "pointerup" && drag?.drop) useShell.getState().moveTab(key, from, drag.drop);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    useTabDrag.setState({ drag: { ...useTabDrag.getState().drag!, drop: null } });
    end(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("keydown", onKey);
}

let suppressClick = false;

/** True once after a drag ended: the tab ignores that click. */
export function consumeClick(): boolean {
  const was = suppressClick;
  suppressClick = false;
  return was;
}

/** The dragged tab under the pointer and where it would land. */
export function TabDragLayer() {
  const drag = useTabDrag((s) => s.drag);
  // A drag left over when the window loses focus mid-drag.
  useEffect(() => {
    const clear = () => useTabDrag.setState({ drag: null });
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, []);
  if (!drag) return null;
  return createPortal(
    <>
      {drag.mark && <div className={`tab-drop-${drag.mark.kind}`} style={{ left: drag.mark.left, top: drag.mark.top, width: drag.mark.width, height: drag.mark.height }} />}
      <div className="tab-ghost" style={{ left: drag.x + 8, top: drag.y + 10 }}>
        {drag.label}
      </div>
    </>,
    document.body,
  );
}
