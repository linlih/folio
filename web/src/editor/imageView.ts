// How an image sits in a card: at its own size or at a width chosen by
// dragging its corner (a share of its column, so every screen shows the same
// proportion), and opened large in the viewer: a double click with a mouse,
// a tap with a finger. A phone has no corner to drag; the viewer offers sizes.

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import i18n from "../i18n";
import { isTouch } from "../shell/phone";
import { openImage } from "./imageViewer";

/** The narrowest an image can be made, in percent of its column. */
export const MIN_SCALE = 10;

/** A shown width in percent of the column: a whole number from MIN_SCALE to
 *  100, or null for the picture's own size (up to the column). */
export function clampScale(v: unknown): number | null {
  const n = typeof v === "string" && v ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(MIN_SCALE, Math.round(n)));
}

/** Shows the image at `pos` at `scale` (null: its own size). */
export function setScale(view: EditorView, pos: number, scale: number | null) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "image" || clampScale(node.attrs.scale) === scale) return;
  view.dispatch(view.state.tr.setNodeAttribute(pos, "scale", scale));
}

/** The width a percentage is taken of: the content box of the image's block. */
function columnWidth(el: HTMLElement): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const cs = getComputedStyle(parent);
  return parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}

export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private handle: HTMLElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    attrs: Record<string, unknown>,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "image-frame";
    this.dom.contentEditable = "false";
    this.img = document.createElement("img");
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && k !== "style" && k !== "data-scale") this.img.setAttribute(k, String(v));
    }
    this.handle = document.createElement("span");
    this.handle.className = "image-handle";
    this.handle.title = i18n.t("assets.image.resize");
    this.handle.setAttribute("aria-hidden", "true");
    this.dom.append(this.img, this.handle);
    this.show(clampScale(node.attrs.scale));

    this.handle.addEventListener("pointerdown", (e) => this.drag(e));
    this.handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.save(null);
    });
    this.img.addEventListener("dblclick", () => {
      if (!isTouch()) this.open();
    });
    this.img.addEventListener("click", () => {
      if (isTouch()) this.open();
    });
  }

  private show(scale: number | null) {
    if (scale) {
      this.dom.dataset.scale = String(scale);
      this.dom.style.width = `${scale}%`;
    } else {
      delete this.dom.dataset.scale;
      this.dom.style.removeProperty("width");
    }
  }

  private save(scale: number | null) {
    const pos = this.getPos();
    if (pos != null && this.view.editable) setScale(this.view, pos, scale);
  }

  /** Dragging the corner: the width follows the pointer, and is kept when
   *  let go. */
  private drag(e: PointerEvent) {
    if (!this.view.editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const column = columnWidth(this.dom);
    if (!column) return;
    const start = this.dom.getBoundingClientRect().width;
    const x0 = e.clientX;
    let scale: number | null = null;
    this.handle.setPointerCapture(e.pointerId);
    this.dom.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      if (scale === null && Math.abs(ev.clientX - x0) < 2) return;
      scale = clampScale(((start + ev.clientX - x0) / column) * 100);
      this.show(scale);
    };
    const end = () => {
      this.handle.removeEventListener("pointermove", move);
      this.handle.removeEventListener("pointerup", end);
      this.handle.removeEventListener("pointercancel", end);
      this.dom.classList.remove("resizing");
      this.show(clampScale(this.node.attrs.scale));
      if (scale !== null) this.save(scale);
    };
    this.handle.addEventListener("pointermove", move);
    this.handle.addEventListener("pointerup", end);
    this.handle.addEventListener("pointercancel", end);
  }

  private open() {
    if (this.img.dataset.missing || !this.img.complete || !this.img.naturalWidth) return;
    const editable = this.view.editable;
    // A finger's tap would bring the keyboard up behind the viewer.
    if (isTouch()) (this.view.dom as HTMLElement).blur();
    openImage({
      src: this.img.currentSrc || this.img.src,
      alt: this.img.alt,
      scale: clampScale(this.node.attrs.scale),
      onScale: editable ? (s) => this.save(s) : undefined,
      onDelete: editable
        ? () => {
            const pos = this.getPos();
            if (pos == null) return;
            const node = this.view.state.doc.nodeAt(pos);
            if (node?.type.name === "image") this.view.dispatch(this.view.state.tr.delete(pos, pos + node.nodeSize));
          }
        : undefined,
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    for (const key of Object.keys(node.attrs)) {
      if (key !== "scale" && node.attrs[key] !== this.node.attrs[key]) return false;
    }
    this.node = node;
    this.show(clampScale(node.attrs.scale));
    return true;
  }

  stopEvent(e: Event): boolean {
    return e.target === this.handle;
  }

  /** The image's own DOM changes (its width while dragged, its picture
   *  while the file is on its way) are not edits. */
  ignoreMutation(): boolean {
    return true;
  }
}
