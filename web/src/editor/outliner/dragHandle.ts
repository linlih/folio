import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { endItemDrag, startHandleDrag } from "./dnd";
import { blockAt, isList } from "./tree";

/** Starts a ProseMirror move-drag of the block at `pos`, like dragging a
 *  selected node: the drop handler inserts it and deletes the original, and
 *  the block keeps its id (pasteIds treats `dragging.move` as a move). */
export function startBlockDrag(view: EditorView, pos: number, e: DragEvent) {
  const sel = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(sel));
  const slice = sel.content();
  const { dom, text } = view.serializeForClipboard(slice);
  if (e.dataTransfer) {
    e.dataTransfer.clearData();
    e.dataTransfer.setData("text/html", dom.innerHTML);
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copyMove";
    const blockDom = view.nodeDOM(pos);
    if (blockDom instanceof HTMLElement) e.dataTransfer.setDragImage(blockDom, 0, 0);
  }
  view.dragging = { slice, move: true };
}

/** How long the handle stays after the pointer leaves the text. */
const HIDE_DELAY_MS = 400;

/** A handle that appears left of a top-level block that is not a list (a
 *  paragraph, heading, quote, code block); drag it to move the block. List
 *  items are dragged by their bullet instead (gutter.ts). Like Notion's, it
 *  shows only while the mouse moves over a block: typing hides it, so it
 *  never sits next to the line being written. */
export const DragHandle = Extension.create({
  name: "dragHandle",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("dragHandle"),
        view(view) {
          const handle = document.createElement("div");
          handle.className = "drag-handle";
          handle.draggable = true;
          handle.hidden = true;
          handle.setAttribute("aria-hidden", "true");
          let target: number | null = null;
          const host = view.dom.parentElement;
          host?.append(handle);

          // Where the pointer was last seen: text reflowing under a resting
          // pointer fires mousemove too, and is not a move. (WebKit reports
          // movementX/Y as 0, so compare positions.)
          let last = { x: NaN, y: NaN };
          const place = (e: MouseEvent) => {
            if (!view.editable || !host) return;
            const moved = e.clientX !== last.x || e.clientY !== last.y;
            last = { x: e.clientX, y: e.clientY };
            if (handle.hidden && !moved) return;
            const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
            const block = hit ? blockAt(view.state.doc.resolve(hit.pos)) : null;
            const dom = block ? view.nodeDOM(block.pos) : null;
            if (!block || block.depth !== 1 || isList(block.node) || !(dom instanceof HTMLElement)) {
              handle.hidden = true;
              return;
            }
            target = block.pos;
            const box = dom.getBoundingClientRect();
            const hostBox = host.getBoundingClientRect();
            const line = parseFloat(getComputedStyle(dom).lineHeight) || 24;
            handle.style.top = `${box.top - hostBox.top + (Math.min(line, box.height) - 20) / 2}px`;
            handle.style.left = `${box.left - hostBox.left - 22}px`;
            show();
          };
          // Leaving the text, the pointer crosses a gap on its way to the
          // handle: hide only after a moment, unless it got there.
          let hideTimer: ReturnType<typeof setTimeout> | undefined;
          const show = () => {
            clearTimeout(hideTimer);
            handle.hidden = false;
          };
          const hideSoon = () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => void (handle.hidden = true), HIDE_DELAY_MS);
          };
          const hide = (e: MouseEvent) => {
            if (e.relatedTarget !== handle) hideSoon();
          };
          const typing = () => {
            clearTimeout(hideTimer);
            handle.hidden = true;
          };
          view.dom.addEventListener("mousemove", place);
          view.dom.addEventListener("mouseleave", hide);
          view.dom.addEventListener("keydown", typing);
          handle.addEventListener("mouseenter", () => clearTimeout(hideTimer));
          handle.addEventListener("mouseleave", (e) => {
            if (e.relatedTarget !== view.dom && !view.dom.contains(e.relatedTarget as Node)) hideSoon();
          });
          handle.addEventListener("dragstart", (e) => {
            if (target === null || target >= view.state.doc.content.size) return;
            startBlockDrag(view, target, e);
            // Other editors (the other pane) take it through dnd.ts.
            const node = view.state.doc.nodeAt(target);
            if (node) startHandleDrag(view, node, e);
          });
          handle.addEventListener("dragend", () => {
            handle.hidden = true;
            view.dragging = null;
            endItemDrag();
          });
          return {
            // Any edit (keys, IME, paste, dictation) counts as typing.
            update(v, prev) {
              if (!prev.doc.eq(v.state.doc)) typing();
            },
            destroy() {
              clearTimeout(hideTimer);
              view.dom.removeEventListener("mousemove", place);
              view.dom.removeEventListener("mouseleave", hide);
              view.dom.removeEventListener("keydown", typing);
              handle.remove();
            },
          };
        },
      }),
    ];
  },
});
