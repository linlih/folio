import { Extension } from "@tiptap/core";
import { inTable } from "../table";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { focusedBid } from "./focus";
import { backspace, deleteForward, enter, indentItems, moveBlock, onCurrentItem, outdentItems } from "./ops";
import { dragDropPlugin } from "./dnd";
import { blockSelectionPlugin, selectBlocks, selectCurrent } from "./selection";
import { plainLine } from "./tasks";
import { itemAt, parentItem } from "./tree";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The item whose line holds the cursor, with that line's bounds. */
function currentLine(state: EditorState) {
  const item = itemAt(state.selection.$head);
  if (!item || state.selection.$head.parent !== item.node.firstChild) return null;
  const start = item.pos + 2;
  return { item, start, end: start + item.node.firstChild!.content.size };
}

/** True when the cursor is on the line's first (up) or last (down) visual
 *  row. Lines without hard breaks count as one row even without layout. */
function atRowEdge(view: EditorView, dir: "up" | "down") {
  let breaks = false;
  view.state.selection.$head.parent.forEach((n) => void (n.type.name === "hardBreak" && (breaks = true)));
  return !breaks || view.endOfTextblock(dir);
}

/** Block selection sees keys before every editing shortcut: while blocks are
 *  selected, Tab, Enter and the rest act on them, not on the text. */
export const BlockSelection = Extension.create<OutlinerKeysOptions>({
  name: "blockSelection",
  priority: 1100,
  addOptions: () => ({ outline: true }),
  addProseMirrorPlugins() {
    return [blockSelectionPlugin(this.options.outline)];
  },
});

export interface OutlinerKeysOptions {
  /** True in outlines (journals); false in document-mode cards, where root
   *  list items behave like a document's (design/outliner.md). */
  outline: boolean;
}

/** The keys of design/outliner.md while editing text. They run before the
 *  list extensions' own Enter / Tab / Backspace and fall through to them
 *  (and to ProseMirror) wherever a rule does not apply. */
export const OutlinerKeys = Extension.create<OutlinerKeysOptions>({
  name: "outlinerKeys",
  priority: 200,
  addOptions: () => ({ outline: true }),
  addKeyboardShortcuts() {
    const run = (f: (state: EditorState) => Transaction | null) => () => {
      const tr = f(this.editor.state);
      if (!tr) return false;
      // An empty transaction means "handled, nothing to change" (at an edge).
      this.editor.view.dispatch(tr.scrollIntoView());
      return true;
    };
    const outline = this.options.outline;
    const shiftSelect = (dir: "up" | "down") => {
      const { state, view } = this.editor;
      const line = currentLine(state);
      if (!line || !line.item.node.attrs.bid || !atRowEdge(view, dir)) return false;
      view.dispatch(selectBlocks(state.tr, line.item, line.item));
      return true;
    };
    const keys: Record<string, () => boolean> = {
      Enter: () => {
        const { state, view } = this.editor;
        const item = itemAt(state.selection.$head);
        const task = item?.node.type.name === "taskItem" && state.selection.$head.parent === item.node.firstChild;
        if (task && !outline && !parentItem(state.doc, item!)) {
          // In a card, a task line is followed by a normal paragraph: an
          // empty task becomes one, otherwise the new line is lifted out of
          // the list (design/outliner.md "任务").
          if (item!.node.firstChild!.content.size === 0) {
            const tr = plainLine(state, false);
            if (tr) view.dispatch(tr);
            return true;
          }
          const split = enter(state, false, focusedBid(state));
          if (!split) return false;
          view.dispatch(split.scrollIntoView());
          const lifted = plainLine(view.state, false);
          if (lifted) view.dispatch(lifted);
          return true;
        }
        const tr = enter(state, outline, focusedBid(state));
        if (!tr) return false;
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      Backspace: run((s) => backspace(s, outline)),
      Delete: run(deleteForward),
      Tab: run((s) => onCurrentItem(s, indentItems)),
      "Shift-Tab": run((s) => onCurrentItem(s, outdentItems)),
      "Mod-Shift-ArrowUp": run((s) => moveBlock(s, -1) ?? s.tr),
      "Mod-Shift-ArrowDown": run((s) => moveBlock(s, 1) ?? s.tr),
      "Alt-Shift-ArrowUp": run((s) => moveBlock(s, -1) ?? s.tr),
      "Alt-Shift-ArrowDown": run((s) => moveBlock(s, 1) ?? s.tr),
      Escape: run(selectCurrent),
      // Shift+↑/↓ on the block's first / last row selects the whole block.
      "Shift-ArrowUp": () => shiftSelect("up"),
      "Shift-ArrowDown": () => shiftSelect("down"),
      // Mod+A: the block's text, then the block.
      "Mod-a": run((s) => {
        const line = currentLine(s);
        if (!line) return null;
        const { from, to } = s.selection;
        if (from === line.start && to === line.end) return selectBlocks(s.tr, line.item, line.item);
        return s.tr.setSelection(TextSelection.create(s.doc, line.start, line.end));
      }),
      // Emacs-style line editing, as in Logseq.
      [isMac ? "Ctrl-l" : "Alt-l"]: run((s) => {
        const line = currentLine(s);
        return line ? s.tr.delete(line.start, line.end) : null;
      }),
      [isMac ? "Ctrl-u" : "Alt-u"]: run((s) => {
        const line = currentLine(s);
        return line ? s.tr.delete(line.start, s.selection.head) : null;
      }),
    };
    // In a table cell the keys are the table's (table.ts): Tab moves between
    // cells, Enter goes down, and nothing joins or splits the block.
    return Object.fromEntries(Object.entries(keys).map(([k, f]) => [k, () => !inTable(this.editor.state) && f()]));
  },
  addProseMirrorPlugins() {
    return [dragDropPlugin()];
  },
});
