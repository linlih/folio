// Tables (design/outliner.md "表格"). Made from `/表格`, by typing a row
// of `| a | b |` and Enter, or by pasting one (from a spreadsheet, a web page
// or Markdown). In a cell, Tab and Enter move on (adding a row at the end);
// a small bar above the table adds and removes rows and columns, so a
// phone without Tab can do everything too.

import { Extension, type Editor } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap, cellAround, findTable, isInTable, selectedRect } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import i18n from "../i18n";
import { insertAfterLine } from "./outliner/tree";

/** A cell holds lines of text (Shift+Enter breaks one): what Markdown and a
 *  spreadsheet can hold, so a table always exports and pastes back whole. */
const CELL_CONTENT = "paragraph+";

export const TableNodes = [
  // Wide tables scroll sideways inside their wrapper, not the page.
  Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 60 }),
  TableRow,
  TableHeader.extend({ content: CELL_CONTENT }),
  TableCell.extend({ content: CELL_CONTENT }),
];

/** Whether the cursor (or a cell selection) is in a table: the outline's own
 *  keys leave it to the table's. */
export const inTable = (state: EditorState) => isInTable(state);

/** A table of `rows` (the first one the header), text in each cell. */
export function tableFrom(schema: Schema, rows: string[][]): PMNode {
  const { table, tableRow, tableHeader, tableCell, paragraph } = schema.nodes;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cell = (type: typeof tableCell, text: string) => type.create(null, paragraph.create(null, text ? schema.text(text) : null));
  return table.create(
    null,
    rows.map((r, i) => tableRow.create(null, Array.from({ length: cols }, (_, c) => cell(i === 0 ? tableHeader : tableCell, (r[c] ?? "").trim())))),
  );
}

/** `| a | b |` → ["a", "b"]; null for anything else. */
export function pipeRow(line: string): string[] | null {
  const m = line.trim().match(/^\|(.*)\|$/);
  if (!m) return null;
  return m[1].split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/** Rows of a table written as text: Markdown (`| a | b |` lines, with or
 *  without the `|---|` line) or tab-separated (a spreadsheet's copy). Null
 *  when the text is not one. */
export function rowsFromText(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length === 0 || !lines[0]) return null;
  const piped = lines.filter((l) => !DIVIDER.test(l.trim())).map(pipeRow);
  if (piped.every((r) => r && r.length > 1) && (lines.length > 1 || piped[0]!.length > 1)) return piped as string[][];
  // Tab-separated: at least two lines and two columns, every line alike.
  if (lines.length < 2 || !lines.every((l) => l.includes("\t"))) return null;
  const rows = lines.map((l) => l.split("\t"));
  return rows.every((r) => r.length === rows[0].length) ? rows : null;
}

/** Puts `table` after the current line and the cursor in its first cell,
 *  or in the first body cell when `body`. */
function insertTable(tr: Transaction, table: PMNode, body = false): Transaction {
  insertAfterLine(tr, table);
  // Where it went (insertAfterLine may also have removed an empty line):
  // the inserted node is the same object in the new document.
  let at = -1;
  tr.doc.descendants((n, pos) => {
    if (n === table) at = pos;
    return at < 0 && !n.isTextblock;
  });
  if (at < 0) return tr;
  const target = body && table.childCount > 1 ? at + 1 + table.firstChild!.nodeSize : at + 1;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(target + 2)));
}

/** A new 3 × 3 table with a header row, for `/表格`. */
export function insertNewTable(editor: Editor, range: { from: number; to: number }) {
  const tr = editor.state.tr.delete(range.from, range.to);
  editor.view.dispatch(insertTable(tr, tableFrom(editor.schema, [["", "", ""], ["", "", ""], ["", "", ""]])).scrollIntoView());
}

/** The cell the cursor is in: its row and column, and the table. */
function here(state: EditorState) {
  const $cell = cellAround(state.selection.$head);
  const table = findTable(state.selection.$head);
  if (!$cell || !table) return null;
  const map = TableMap.get(table.node);
  const rect = map.findCell($cell.pos - table.start);
  return { map, table, row: rect.top, col: rect.left };
}

/** Moves the cursor into the cell at (row, col) of the table at `tablePos`. */
function goToCell(tr: Transaction, tablePos: number, row: number, col: number): Transaction {
  const table = tr.doc.nodeAt(tablePos)!;
  const map = TableMap.get(table);
  const cellPos = tablePos + 1 + map.map[row * map.width + col];
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
}

/** Where a run of Tabs along a row began: Enter then goes to the next
 *  row's cell under it, as in a spreadsheet. */
type TabRun = { table: number; row: number; col: number } | null;

/** Enter in a cell: the cell below, adding a row at the bottom (a
 *  spreadsheet's Enter); after Tabs along the row, the next row's cell
 *  under the first one. */
function enterInCell(state: EditorState, dispatch: (tr: Transaction) => void, run: TabRun): boolean {
  const h = here(state);
  if (!h) return false;
  const col = run && run.table === h.table.pos && run.row === h.row ? run.col : h.col;
  const tr = state.tr;
  if (h.row === h.map.height - 1) {
    const { tableRow, tableCell, paragraph } = state.schema.nodes;
    const row = tableRow.create(null, Array.from({ length: h.map.width }, () => tableCell.create(null, paragraph.create())));
    tr.insert(h.table.pos + h.table.node.nodeSize - 1, row);
  }
  dispatch(goToCell(tr, h.table.pos, h.row + 1, col).scrollIntoView());
  return true;
}

/** Enter on a line that is a row of `| a | b |`: it becomes a table with
 *  that header, and the cursor goes to the row under it. */
function enterOnPipeRow(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.isTextblock || $head.parent.type.name !== "paragraph" || $head.parentOffset !== $head.parent.content.size) return false;
  // Plain text only: a line with links or tags in it is not a table row.
  if ($head.parent.childCount !== 1 || !$head.parent.firstChild!.isText) return false;
  const cells = pipeRow($head.parent.textContent);
  if (!cells || cells.length < 2) return false;
  const tr = state.tr.delete($head.start(), $head.end());
  dispatch(insertTable(tr, tableFrom(state.schema, [cells, cells.map(() => "")]), true).scrollIntoView());
  return true;
}

/** ↓ on the last row of a table nothing follows: a line after it to go
 *  on writing (with no line after a table there is nowhere to type). */
function leaveDown(view: EditorView): boolean {
  const { state } = view;
  const h = here(state);
  if (!h || h.row !== h.map.height - 1 || !view.endOfTextblock("down")) return false;
  const $table = state.doc.resolve(h.table.pos);
  if ($table.index() < $table.parent.childCount - 1) return false;
  const after = h.table.pos + h.table.node.nodeSize;
  const tr = state.tr.insert(after, state.schema.nodes.paragraph.create());
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  return true;
}

export const TableKeys = Extension.create<object, { tabRun: TabRun }>({
  name: "tableKeys",
  addStorage: () => ({ tabRun: null }),
  // Before the outline's keys (200) and the input feel (1050); after an
  // open suggestion popup (1200).
  priority: 1060,
  addKeyboardShortcuts() {
    const dispatch = (tr: Transaction) => this.editor.view.dispatch(tr);
    return {
      Enter: () => {
        const run = this.storage.tabRun;
        this.storage.tabRun = null;
        return inTable(this.editor.state) ? enterInCell(this.editor.state, dispatch, run) : enterOnPipeRow(this.editor.state, dispatch);
      },
      // Notes where a run of Tabs began; the table's own Tab moves on.
      Tab: () => {
        const h = here(this.editor.state);
        const run = this.storage.tabRun;
        if (h && !(run && run.table === h.table.pos && run.row === h.row)) this.storage.tabRun = { table: h.table.pos, row: h.row, col: h.col };
        return false;
      },
      ArrowDown: () => leaveDown(this.editor.view),
    };
  },
  onSelectionUpdate() {
    // Anywhere else (a click, the arrows): the run is over.
    const h = here(this.editor.state);
    const run = this.storage.tabRun;
    if (run && (!h || h.table.pos !== run.table || h.row !== run.row)) this.storage.tabRun = null;
  },
  addProseMirrorPlugins() {
    return [tablePaste(), tableBar(this.editor)];
  },
});

/** A table pasted outside a table (one from a spreadsheet or a web page, or
 *  Markdown / tab-separated text) goes in whole, after the current line.
 *  Inside a table, pasting cells is the table's own. */
function tablePaste() {
  return new Plugin({
    key: new PluginKey("tablePaste"),
    props: {
      handlePaste(view, event, slice) {
        const { state } = view;
        if (inTable(state)) return false;
        const html = event.clipboardData?.getData("text/html") ?? "";
        const text = event.clipboardData?.getData("text/plain") ?? "";
        let tables: PMNode[] = [];
        if (html) {
          // Only a paste that is tables (and blank lines around them).
          const blocks: PMNode[] = [];
          slice.content.forEach((n) => void blocks.push(n));
          if (blocks.some((n) => n.type.name === "table") && blocks.every((n) => n.type.name === "table" || (n.isTextblock && n.content.size === 0))) {
            tables = blocks.filter((n) => n.type.name === "table");
          }
        }
        if (!tables.length && (!html || /<table[\s>]/i.test(html))) {
          const rows = rowsFromText(text);
          if (rows && (rows.length > 1 || !html)) tables = [tableFrom(state.schema, rows)];
        }
        if (!tables.length) return false;
        let tr = state.tr.deleteSelection();
        for (const t of tables.reverse()) tr = insertTable(tr, t);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

// ---- the bar above a table ----

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const GRID = `<rect x="3" y="3" width="14" height="14" rx="2"/>`;
const ICONS = {
  rowAbove: svg(`<rect x="3" y="9" width="14" height="8" rx="1.5"/><path d="M3 13h14M10 2.5v4M8 4.5h4"/>`),
  rowBelow: svg(`<rect x="3" y="3" width="14" height="8" rx="1.5"/><path d="M3 7h14M10 13.5v4M8 15.5h4"/>`),
  colLeft: svg(`<rect x="9" y="3" width="8" height="14" rx="1.5"/><path d="M13 3v14M2.5 10h4M4.5 8v4"/>`),
  colRight: svg(`<rect x="3" y="3" width="8" height="14" rx="1.5"/><path d="M7 3v14M13.5 10h4M15.5 8v4"/>`),
  deleteRow: svg(`<rect x="3" y="6" width="14" height="8" rx="1.5"/><path d="M8 8.5l4 3M12 8.5l-4 3"/>`),
  deleteCol: svg(`<rect x="6" y="3" width="8" height="14" rx="1.5"/><path d="M8 8l4 4M12 8l-4 4"/>`),
  header: svg(`${GRID}<path d="M3 7.5h14" stroke-width="3.2"/>`),
  deleteTable: svg(`<path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6"/>`),
  plus: svg(`<path d="M10 5v10M5 10h10"/>`),
};

type Action = { id: string; icon: string; run: (e: Editor) => boolean };

const ACTIONS: (Action | "|")[] = [
  { id: "rowAbove", icon: ICONS.rowAbove, run: (e) => e.chain().focus().addRowBefore().run() },
  { id: "rowBelow", icon: ICONS.rowBelow, run: (e) => e.chain().focus().addRowAfter().run() },
  { id: "colLeft", icon: ICONS.colLeft, run: (e) => e.chain().focus().addColumnBefore().run() },
  { id: "colRight", icon: ICONS.colRight, run: (e) => e.chain().focus().addColumnAfter().run() },
  "|",
  { id: "deleteRow", icon: ICONS.deleteRow, run: (e) => e.chain().focus().deleteRow().run() },
  { id: "deleteCol", icon: ICONS.deleteCol, run: (e) => e.chain().focus().deleteColumn().run() },
  "|",
  { id: "header", icon: ICONS.header, run: (e) => e.chain().focus().toggleHeaderRow().run() },
  { id: "deleteTable", icon: ICONS.deleteTable, run: (e) => e.chain().focus().deleteTable().run() },
];

/** The table the selection is in: its position and its DOM table. */
function currentTable(view: EditorView): { pos: number; dom: HTMLElement } | null {
  if (!inTable(view.state)) return null;
  const sel = view.state.selection;
  const table = findTable(sel instanceof CellSelection ? sel.$anchorCell : sel.$head);
  if (!table) return null;
  const node = view.nodeDOM(table.pos);
  const dom = node instanceof HTMLElement ? (node.matches("table") ? node : node.querySelector("table")) : null;
  return dom ? { pos: table.pos, dom } : null;
}

/** While the cursor is in a table: a bar above it, and + buttons along its
 *  bottom and right edge for a row and a column. Drawn outside the
 *  document (fixed, over it), so the editor's DOM stays the document's. */
function tableBar(editor: Editor) {
  return new Plugin({
    key: new PluginKey("tableBar"),
    view(view) {
      const t = (k: string) => i18n.t(`table.${k}`);
      const button = (label: string, icon: string, run: () => void, cls = "") => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `table-bar-button ${cls}`.trim();
        b.title = label;
        b.setAttribute("aria-label", label);
        b.innerHTML = icon;
        // Keep the cursor (and a phone's keyboard) in the cell.
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          run();
          update();
        });
        return b;
      };
      const bar = document.createElement("div");
      bar.className = "table-bar";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", t("bar"));
      for (const a of ACTIONS) {
        if (a === "|") {
          const sep = document.createElement("span");
          sep.className = "table-bar-sep";
          bar.append(sep);
        } else bar.append(button(t(a.id), a.icon, () => a.run(editor), a.id === "deleteTable" ? "danger" : ""));
      }
      // A row after the last one, or a column after the last one.
      const addAtEnd = (axis: "row" | "col") => {
        const { state } = editor;
        const rect = selectedRect(state);
        const map = rect.map;
        const pos = rect.tableStart + map.map[axis === "row" ? (map.height - 1) * map.width + Math.min(rect.left, map.width - 1) : Math.min(rect.top, map.height - 1) * map.width + map.width - 1];
        editor.chain().focus().setTextSelection(pos + 2).run();
        if (axis === "row") editor.chain().addRowAfter().goToNextCell().run();
        else editor.chain().addColumnAfter().run();
        // A new row is written from its first cell; a new column is named
        // first, in its header.
        const h = here(editor.state);
        if (h) editor.view.dispatch(goToCell(editor.state.tr, h.table.pos, axis === "row" ? h.map.height - 1 : 0, axis === "row" ? 0 : h.map.width - 1));
      };
      const addRow = button(t("addRow"), ICONS.plus, () => addAtEnd("row"), "table-add table-add-row");
      const addCol = button(t("addCol"), ICONS.plus, () => addAtEnd("col"), "table-add table-add-col");
      const layer = document.body;
      layer.append(bar, addRow, addCol);

      const hide = () => {
        for (const el of [bar, addRow, addCol]) el.hidden = true;
      };
      const update = () => {
        const table = view.editable && view.hasFocus() ? currentTable(view) : null;
        if (!table) return hide();
        const r = table.dom.getBoundingClientRect();
        // The part of the table that shows (it may scroll sideways in its
        // wrapper, and the page may scroll it out of sight).
        const box = (table.dom.parentElement ?? table.dom).getBoundingClientRect();
        const left = Math.max(r.left, box.left);
        const right = Math.min(r.right, box.right);
        if (r.bottom < 0 || r.top > window.innerHeight) return hide();
        for (const el of [bar, addRow, addCol]) el.hidden = false;
        bar.style.left = `${left}px`;
        bar.style.top = `${Math.max(4, r.top - bar.offsetHeight - 6)}px`;
        addRow.style.left = `${left}px`;
        addRow.style.width = `${right - left}px`;
        addRow.style.top = `${r.bottom + 2}px`;
        // No room on the right (a full-width table on a phone): the bar's
        // own buttons add columns.
        addCol.hidden = right + 2 + addCol.offsetWidth > document.documentElement.clientWidth;
        addCol.style.left = `${right + 2}px`;
        addCol.style.top = `${r.top}px`;
        addCol.style.height = `${r.height}px`;
      };
      hide();
      const onMove = () => requestAnimationFrame(update);
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      const onBlur = () => setTimeout(update, 0);
      view.dom.addEventListener("blur", onBlur);
      view.dom.addEventListener("focus", onMove);
      return {
        update: () => update(),
        destroy() {
          window.removeEventListener("scroll", onMove, true);
          window.removeEventListener("resize", onMove);
          view.dom.removeEventListener("blur", onBlur);
          view.dom.removeEventListener("focus", onMove);
          bar.remove();
          addRow.remove();
          addCol.remove();
        },
      };
    },
  });
}
