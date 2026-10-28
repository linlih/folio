// An image over the whole window, to look at closely: the wheel, a pinch or
// a double tap zooms, dragging moves a zoomed picture, and a tap beside it,
// Escape or (with a finger) a swipe down closes it. Below it, the sizes the
// image can take in its card: the only way to size it on a phone.

import i18n from "../i18n";
import { isTouch } from "../shell/phone";

export interface ViewerOptions {
  src: string;
  alt: string;
  /** The image's width in its card (percent of the column, null: own size). */
  scale: number | null;
  /** Absent when the card cannot be changed. */
  onScale?: (scale: number | null) => void;
  onDelete?: () => void;
}

/** The sizes offered, in percent of the column (null: the picture's own). */
const SIZES: { key: string; scale: number | null }[] = [
  { key: "small", scale: 33 },
  { key: "medium", scale: 50 },
  { key: "large", scale: 75 },
  { key: "full", scale: 100 },
  { key: "original", scale: null },
];

const MAX_ZOOM = 8;
const DOUBLE_TAP_MS = 300;

let closeOpen: (() => void) | null = null;

/** Opens the viewer; resolves nothing, returns how to close it. */
export function openImage(o: ViewerOptions): () => void {
  closeOpen?.();
  const before = document.activeElement as HTMLElement | null;

  const root = document.createElement("div");
  root.className = "image-viewer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", o.alt || i18n.t("assets.image.view"));
  root.tabIndex = -1;
  const stage = document.createElement("div");
  stage.className = "image-viewer-stage";
  const img = document.createElement("img");
  img.src = o.src;
  img.alt = o.alt;
  img.draggable = false;
  stage.append(img);
  const close = document.createElement("button");
  close.className = "image-viewer-close";
  close.setAttribute("aria-label", i18n.t("assets.image.close"));
  close.textContent = "×";
  root.append(stage, close);

  if (o.onScale || o.onDelete) {
    const bar = document.createElement("div");
    bar.className = "image-viewer-bar";
    if (o.onScale) {
      const sizes = document.createElement("div");
      sizes.className = "image-viewer-sizes";
      sizes.setAttribute("role", "group");
      sizes.setAttribute("aria-label", i18n.t("assets.image.size"));
      for (const s of SIZES) {
        const b = document.createElement("button");
        b.textContent = i18n.t(`assets.image.${s.key}`);
        b.setAttribute("aria-pressed", String(s.scale === o.scale));
        b.addEventListener("click", () => {
          done();
          o.onScale!(s.scale);
        });
        sizes.append(b);
      }
      bar.append(sizes);
    }
    if (o.onDelete) {
      const del = document.createElement("button");
      del.className = "image-viewer-delete";
      del.textContent = i18n.t("assets.image.delete");
      del.addEventListener("click", () => {
        done();
        o.onDelete!();
      });
      bar.append(del);
    }
    root.append(bar);
  }

  // Zoom k around the stage's middle, moved by (x, y).
  let k = 1;
  let x = 0;
  let y = 0;
  let pull = 0; // a swipe down, at k = 1
  const draw = () => {
    img.style.transform = `translate(${x}px, ${y + pull}px) scale(${k})`;
    root.style.setProperty("--pull", String(Math.min(1, Math.abs(pull) / 300)));
  };
  /** Keeps a zoomed picture covering what it can of the stage. */
  const bound = () => {
    if (k <= 1.001) {
      k = 1;
      x = y = 0;
      return;
    }
    const r = stage.getBoundingClientRect();
    const bx = Math.max(0, (img.offsetWidth * k - r.width) / 2);
    const by = Math.max(0, (img.offsetHeight * k - r.height) / 2);
    x = Math.min(bx, Math.max(-bx, x));
    y = Math.min(by, Math.max(-by, y));
  };
  /** Zooms to `to`, keeping the point under (cx, cy) where it is. */
  const zoomAt = (to: number, cx: number, cy: number) => {
    const r = stage.getBoundingClientRect();
    const sx = cx - (r.left + r.width / 2);
    const sy = cy - (r.top + r.height / 2);
    const next = Math.min(MAX_ZOOM, Math.max(1, to));
    x = sx - (next / k) * (sx - x);
    y = sy - (next / k) * (sy - y);
    k = next;
    bound();
    draw();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomAt(k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;
  let down: { x: number; y: number; t: number; onImage: boolean } | null = null;
  let moved = false;
  let lastTap = 0;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  const onDown = (e: PointerEvent) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      down = { x: e.clientX, y: e.clientY, t: Date.now(), onImage: e.target === img };
      moved = false;
    } else if (pointers.size === 2) {
      pinch = spread();
      moved = true;
      pull = 0;
    }
  };
  const onMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) moved = true;
    if (pointers.size === 2 && pinch) {
      const now = spread();
      x += now.mx - pinch.mx;
      y += now.my - pinch.my;
      zoomAt(k * (now.d / (pinch.d || 1)), now.mx, now.my);
      pinch = now;
    } else if (pointers.size === 1 && moved) {
      if (k > 1) {
        x += dx;
        y += dy;
        bound();
      } else if (e.pointerType !== "mouse") {
        pull += dy;
      }
      draw();
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 1) {
      pinch = null;
      return;
    }
    if (pointers.size) return;
    pinch = null;
    if (pull > 120) return done();
    pull = 0;
    draw();
    const tap = down && !moved && Date.now() - down.t < 500;
    if (tap && down!.onImage) {
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        zoomAt(k > 1 ? 1 : 2.5, e.clientX, e.clientY);
      } else {
        lastTap = now;
      }
    } else if (tap) {
      done();
    }
    down = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      done();
    } else if (e.key === "+" || e.key === "=") {
      const r = stage.getBoundingClientRect();
      zoomAt(k * 1.5, r.left + r.width / 2, r.top + r.height / 2);
    } else if (e.key === "-") {
      const r = stage.getBoundingClientRect();
      zoomAt(k / 1.5, r.left + r.width / 2, r.top + r.height / 2);
    } else if (e.key === "0") {
      k = 1;
      bound();
      draw();
    }
  };

  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  close.addEventListener("click", () => done());
  document.addEventListener("keydown", onKey, true);

  function done() {
    if (closeOpen !== done) return;
    closeOpen = null;
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    // A finger's focus would bring the keyboard back.
    if (!isTouch()) before?.focus({ preventScroll: true });
  }
  closeOpen = done;
  document.body.append(root);
  draw();
  root.focus({ preventScroll: true });
  return done;
}
