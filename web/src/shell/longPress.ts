/** On a touch screen, holding a finger still stands in for the right click:
 *  the menus the app opens on `contextmenu` (cards on a whiteboard, rows in
 *  the card library…) open with a long press. Text fields and editors keep
 *  the system's own long press (selecting text). */

const HOLD_MS = 500;
/** A finger that moves this far is scrolling or dragging, not holding. */
const SLOP = 10;

export function installLongPress(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number; target: Element; id: number } | null = null;
  let fired = false;

  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return cancel();
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest("input, textarea, select, [contenteditable='true']")) return cancel();
    fired = false;
    start = { x: e.clientX, y: e.clientY, target, id: e.pointerId };
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!start) return;
      fired = true;
      const { x, y, target } = start;
      start = null;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }));
    }, HOLD_MS);
  };
  const move = (e: PointerEvent) => {
    if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  };
  // The finger lifting after a long press must not also tap what is under it.
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  };
  // The system's own long-press menu on links and images.
  const native = (e: Event) => {
    if (start || fired) e.preventDefault();
  };

  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", cancel, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("click", click, true);
  window.addEventListener("selectstart", native, true);
  return () => {
    cancel();
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", cancel, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("selectstart", native, true);
  };
}
