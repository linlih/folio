// Tables (design/outliner.md "表格") and blocks of types this version does
// not know.
import type { Editor } from "@tiptap/core";
import { LoroText } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { _slashChoices } from "../src/editor/outliner/suggest";
import { rowsFromText } from "../src/editor/table";
import { bodyTree } from "../src/vendor/loro-prosemirror/tree";
import { bind, cursorAfter, device, press, settle, sync, typeText } from "./helpers";

/** The tables in the editor, as rows of cell text. */
const tables = (e: Editor) => {
  const out: string[][][] = [];
  e.state.doc.descendants((n) => {
    if (n.type.name !== "table") return true;
    const rows: string[][] = [];
    n.forEach((r) => {
      const cells: string[] = [];
      r.forEach((c) => void cells.push(c.textContent));
      rows.push(cells);
    });
    out.push(rows);
    return false;
  });
  return out;
};

const cellOfCursor = (e: Editor) => {
  const { $head } = e.state.selection;
  for (let d = $head.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($head.node(d).type.name)) return $head.node(d).type.name;
  return null;
};

async function journal(html: string) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return { doc, editor };
}

describe("blocks of a newer version", () => {
  it("are kept, in their place, when this version edits around them", async () => {
    const doc = device(1n);
    initCard(doc, "note", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent("<p>before</p><p>after</p>");
    await settle();
    // Another device, with a newer app, puts a block of its own between them.
    const other = device(2n);
    sync(doc, other);
    const tree = bodyTree(other);
    const future = tree.createNode(undefined, 1);
    future.data.set("nodeName", "futureBlock");
    future.data.setContainer("attributes", new (await import("loro-crdt")).LoroMap()).set("bid", "f1");
    future.data.setContainer("children", new (await import("loro-crdt")).LoroMovableList()).insertContainer(0, new LoroText()).insert(0, "from the future");
    other.commit();
    sync(doc, other);
    await settle();
    expect(editor.getText()).toBe("before\n\nafter");

    // Edits here: typing, a new block, deleting the one after it.
    cursorAfter(editor, "before");
    typeText(editor, "!");
    press(editor, "Enter");
    typeText(editor, "new");
    await settle();
    // "after" emptied, then its line deleted with the "new" one before it.
    cursorAfter(editor, "after");
    editor.commands.deleteRange({ from: editor.state.selection.from - 5, to: editor.state.selection.from });
    await settle();
    const names = bodyTree(doc)
      .roots()
      .map((n) => String(n.data.get("nodeName")));
    // The new line follows the hidden block (it cannot be put between
    // blocks no one here can see); the order of the others stays.
    expect(names).toEqual(["paragraph", "futureBlock", "paragraph", "paragraph"]);
    expect(editor.getText()).toBe("before!\n\nnew\n\n");
  });
});

describe("tables", () => {
  it("are made with /table, and reach another device as they are", async () => {
    const { doc, editor } = await journal("<ul><li><p>项目</p></li></ul>");
    cursorAfter(editor, "项目");
    typeText(editor, "/");
    _slashChoices()
      .find((c) => c.id === "table")!
      .run(editor, { from: editor.state.selection.from - 1, to: editor.state.selection.from });
    await settle();
    expect(tables(editor)).toEqual([[["", "", ""], ["", "", ""], ["", "", ""]]]);
    expect(cellOfCursor(editor)).toBe("tableHeader");
    typeText(editor, "名称");
    press(editor, "Tab");
    typeText(editor, "状态");
    await settle();

    const other = device(2n);
    sync(doc, other);
    const { editor: there } = await bind(other);
    expect(tables(there)[0][0]).toEqual(["名称", "状态", ""]);
    // Under the item, after its line: the outline keeps it with the block.
    expect(there.state.doc.firstChild!.firstChild!.childCount).toBe(2);
  });

  it("are made by typing a row of | cells | and Enter", async () => {
    const { editor } = await journal("<ul><li><p>x</p></li></ul>");
    cursorAfter(editor, "x");
    press(editor, "Enter");
    typeText(editor, "| 书名 | 作者 | 读完 |");
    press(editor, "Enter");
    await settle();
    expect(tables(editor)).toEqual([[["书名", "作者", "读完"], ["", "", ""]]]);
    expect(cellOfCursor(editor)).toBe("tableCell");
  });

  it("move between cells with Tab and Enter, adding rows at the end, inside an outline", async () => {
    const { editor } = await journal("<ul><li><p>x</p></li></ul>");
    cursorAfter(editor, "x");
    press(editor, "Enter");
    typeText(editor, "| a | b |");
    press(editor, "Enter");
    typeText(editor, "1");
    press(editor, "Tab");
    typeText(editor, "2");
    // Tab in the last cell: a new row (not an indented block).
    press(editor, "Tab");
    typeText(editor, "3");
    // Enter after Tabs along the row: the next row, under where they began.
    press(editor, "Tab");
    typeText(editor, "4");
    press(editor, "Enter");
    typeText(editor, "5");
    // Enter otherwise: the cell below.
    press(editor, "Enter");
    await settle();
    expect(tables(editor)).toEqual([[["a", "b"], ["1", "2"], ["3", "4"], ["5", ""], ["", ""]]]);
    // Backspace at the start of a cell joins nothing; Shift+Tab goes back.
    press(editor, "Backspace");
    press(editor, "Shift-Tab");
    typeText(editor, "!");
    await settle();
    expect(tables(editor)).toEqual([[["a", "b"], ["1", "2"], ["3", "4"], ["5", "!"], ["", ""]]]);
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
  });

  it("are pasted from a spreadsheet, a web page or Markdown", async () => {
    const paste = (e: Editor, data: Record<string, string>) => {
      const event = Object.assign(new Event("paste"), { clipboardData: { getData: (t: string) => data[t] ?? "" } }) as unknown as ClipboardEvent;
      if (data["text/html"]) e.view.pasteHTML(data["text/html"], event);
      else e.view.pasteText(data["text/plain"], event);
    };
    const { editor } = await journal("<p>start</p>");
    cursorAfter(editor, "start");
    paste(editor, { "text/plain": "名称\t数量\n苹果\t3\n梨\t5" });
    await settle();
    expect(tables(editor)).toEqual([[["名称", "数量"], ["苹果", "3"], ["梨", "5"]]]);
    editor.commands.setContent("<p>start</p>");
    cursorAfter(editor, "start");
    paste(editor, { "text/html": "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>", "text/plain": "A\tB\n1\t2" });
    await settle();
    expect(tables(editor)).toEqual([[["A", "B"], ["1", "2"]]]);
    editor.commands.setContent("<ul><li><p>start</p></li></ul>");
    cursorAfter(editor, "start");
    paste(editor, { "text/plain": "| k | v |\n|---|---|\n| x | 1 |" });
    await settle();
    expect(tables(editor)).toEqual([[["k", "v"], ["x", "1"]]]);
  });

  it("read Markdown and tab-separated text, and nothing else", () => {
    expect(rowsFromText("| a | b |\n|---|:--:|\n| 1 | 2 |\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(rowsFromText("| a \\| b | c |")).toEqual([["a | b", "c"]]);
    expect(rowsFromText("x\ty\n1\t2")).toEqual([["x", "y"], ["1", "2"]]);
    expect(rowsFromText("x\ty\n1")).toBeNull();
    expect(rowsFromText("just | a line")).toBeNull();
    expect(rowsFromText("| one |")).toBeNull();
  });
});
