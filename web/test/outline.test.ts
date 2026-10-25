// The outline rules of design/outliner.md, one block per table row.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { endItemDrag, dropDragged, startItemDrag } from "../src/editor/outliner/dnd";
import { focusTrail } from "../src/editor/outliner/focus";
import { setCollapsed } from "../src/editor/outliner/gutter";
import { blockSelection } from "../src/editor/outliner/selection";
import { findByBid, itemAt, moveItems, type Item } from "../src/editor/outliner/tree";
import { bind, bids, caret, cursorAfter, cursorBefore, device, outline, press, settle, typeText } from "./helpers";

const TREE = "<ul><li><p>A</p><ul><li><p>A1</p></li><li><p>A2</p></li></ul></li><li><p>B</p></li><li><p>C</p></li></ul>";

async function journal(html = TREE) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const b = await bind(doc);
  b.editor.commands.setContent(html);
  await settle();
  return b.editor;
}

async function documentCard(html: string) {
  const doc = device(1n);
  initCard(doc, "note", "", 1);
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...baseExtensions(isRemoteTx, "", "document"), LoroBinding(doc, (await bind(device(9n))).undo)],
  });
  await settle();
  editor.commands.setContent(html);
  return editor;
}

const item = (editor: Editor, text: string): Item => {
  cursorAfter(editor, text);
  return itemAt(editor.state.selection.$head)!;
};

describe("Enter", () => {
  it("splits at the cursor; the rest becomes the next block", async () => {
    const e = await journal("<ul><li><p>hello world</p></li></ul>");
    cursorAfter(e, "hello");
    press(e, "Enter");
    expect(outline(e)).toEqual(["hello", " world"]);
    expect(caret(e)).toBe("| world");
  });

  it("at the start of a line inserts an empty block above and keeps the cursor", async () => {
    const e = await journal("<ul><li><p>B</p></li></ul>");
    cursorBefore(e, "B");
    press(e, "Enter");
    expect(outline(e)).toEqual(["", "B"]);
    expect(caret(e)).toBe("|B");
  });

  it("on a block with children adds its first child", async () => {
    const e = await journal();
    cursorAfter(e, "A");
    press(e, "Enter");
    typeText(e, "new");
    expect(outline(e)).toEqual(["A", "  new", "  A1", "  A2", "B", "C"]);
  });

  it("on a collapsed block adds a sibling after its children", async () => {
    const e = await journal();
    e.view.dispatch(setCollapsed(e.state, 1, true)!);
    cursorAfter(e, "A");
    press(e, "Enter");
    typeText(e, "new");
    expect(outline(e)).toEqual(["A (collapsed)", "  A1", "  A2", "new", "B", "C"]);
  });

  it("on an empty last child outdents it", async () => {
    const e = await journal();
    cursorAfter(e, "A2");
    press(e, "Enter");
    press(e, "Enter");
    typeText(e, "out");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "out", "B", "C"]);
  });

  it("on an empty block that is not last adds a block", async () => {
    const e = await journal("<ul><li><p></p></li><li><p>B</p></li></ul>");
    e.commands.setTextSelection(3);
    press(e, "Enter");
    expect(outline(e)).toEqual(["", "", "B"]);
  });

  it("in a document card, an empty root item leaves the list", async () => {
    const e = await documentCard("<ul><li><p>one</p></li><li><p></p></li></ul>");
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    press(e, "Enter");
    expect(e.getJSON().content?.map((n) => n.type)).toEqual(["bulletList", "paragraph"]);
  });
});

describe("Backspace and Delete", () => {
  it("joins a block to the one above, cursor at the seam", async () => {
    const e = await journal("<ul><li><p>ab</p></li><li><p>cd</p></li></ul>");
    cursorBefore(e, "cd");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["abcd"]);
    expect(caret(e)).toBe("ab|cd");
  });

  it("joins a first child into its parent, children follow", async () => {
    const e = await journal("<ul><li><p>P</p><ul><li><p>c</p><ul><li><p>gc</p></li></ul></li><li><p>d</p></li></ul></li></ul>");
    cursorBefore(e, "c");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["Pc", "  gc", "  d"]);
  });

  it("joins into the last visible block above, which takes the children", async () => {
    const e = await journal("<ul><li><p>A</p><ul><li><p>A1</p></li></ul></li><li><p>B</p><ul><li><p>B1</p></li></ul></li></ul>");
    cursorBefore(e, "B");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["A", "  A1B", "    B1"]);
  });

  it("removes an empty block above instead of joining", async () => {
    const e = await journal("<ul><li><p></p></li><li><p>B</p></li></ul>");
    cursorBefore(e, "B");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["B"]);
    expect(caret(e)).toBe("|B");
  });

  it("does nothing at the start of a journal's first block", async () => {
    const e = await journal("<ul><li><p>first</p></li></ul>");
    cursorBefore(e, "first");
    expect(press(e, "Backspace")).toBe(true);
    expect(outline(e)).toEqual(["first"]);
  });

  it("Delete at the end pulls the next block up", async () => {
    const e = await journal();
    cursorAfter(e, "A2");
    press(e, "Delete");
    expect(outline(e)).toEqual(["A", "  A1", "  A2B", "C"]);
  });
});

describe("Tab and Shift+Tab", () => {
  it("indents under the previous sibling as its last child, expanding it", async () => {
    const e = await journal();
    e.view.dispatch(setCollapsed(e.state, 1, true)!);
    cursorAfter(e, "B");
    press(e, "Tab");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "  B", "C"]);
    expect(caret(e)).toBe("B|");
  });

  it("does nothing without a previous sibling", async () => {
    const e = await journal();
    cursorAfter(e, "A1");
    press(e, "Tab");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "B", "C"]);
  });

  it("outdents after the parent; the blocks below become its children", async () => {
    const e = await journal("<ul><li><p>P</p><ul><li><p>x</p></li><li><p>y</p></li><li><p>z</p></li></ul></li><li><p>Q</p></li></ul>");
    cursorAfter(e, "x");
    press(e, "Shift-Tab");
    expect(outline(e)).toEqual(["P", "x", "  y", "  z", "Q"]);
    expect(caret(e)).toBe("x|");
  });
});

describe("move up and down keep the depth", () => {
  it("swaps with siblings", async () => {
    const e = await journal();
    cursorAfter(e, "B");
    press(e, "Mod-Shift-ArrowUp");
    expect(outline(e)).toEqual(["B", "A", "  A1", "  A2", "C"]);
    press(e, "Mod-Shift-ArrowDown");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "B", "C"]);
  });

  it("a first child moves up into the end of the parent's previous sibling", async () => {
    const e = await journal("<ul><li><p>U</p><ul><li><p>u1</p></li></ul></li><li><p>P</p><ul><li><p>p1</p></li></ul></li></ul>");
    cursorAfter(e, "p1");
    press(e, "Mod-Shift-ArrowUp");
    expect(outline(e)).toEqual(["U", "  u1", "  p1", "P"]);
  });

  it("a last child moves down to the start of the parent's next sibling", async () => {
    const e = await journal("<ul><li><p>P</p><ul><li><p>p1</p></li></ul></li><li><p>N</p><ul><li><p>n1</p></li></ul></li></ul>");
    cursorAfter(e, "p1");
    press(e, "Mod-Shift-ArrowDown");
    expect(outline(e)).toEqual(["P", "N", "  p1", "  n1"]);
  });

  it("stops at the top", async () => {
    const e = await journal();
    cursorAfter(e, "A1");
    press(e, "Mod-Shift-ArrowUp");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "B", "C"]);
  });
});

describe("block selection", () => {
  it("Esc selects the block; arrows and keys act on blocks", async () => {
    const e = await journal();
    cursorAfter(e, "B");
    press(e, "Escape");
    expect(blockSelection(e.state)).not.toBeNull();
    press(e, "Shift-ArrowDown");
    expect(e.view.dom.querySelectorAll(".block-selected")).toHaveLength(2);
    press(e, "Tab");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "  B", "  C"]);
    press(e, "Backspace");
    expect(outline(e)).toEqual(["A", "  A1", "  A2"]);
    expect(blockSelection(e.state)).toBeNull();
    expect(caret(e)).toBe("A2|");
  });

  it("Enter edits the selected block; typing does nothing while selecting", async () => {
    const e = await journal();
    cursorAfter(e, "C");
    press(e, "Escape");
    press(e, "ArrowUp");
    typeText(e, "zzz");
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "B", "C"]);
    press(e, "Enter");
    expect(caret(e)).toBe("B|");
  });
});

describe("drag and drop", () => {
  const drag = (e: Editor, text: string) => startItemDrag(e.view, item(e, text), new Event("dragstart") as DragEvent);

  it("drops after a block, as its first child, or before the first block", async () => {
    const e = await journal();
    drag(e, "C");
    dropDragged(e.view, { kind: "firstChild", item: item(e, "B") });
    endItemDrag();
    expect(outline(e)).toEqual(["A", "  A1", "  A2", "B", "  C"]);
    drag(e, "B");
    dropDragged(e.view, { kind: "before", item: item(e, "A") });
    endItemDrag();
    expect(outline(e)).toEqual(["B", "  C", "A", "  A1", "  A2"]);
  });

  it("cannot drop a block into its own children", async () => {
    const e = await journal();
    const tr = e.state.tr;
    expect(moveItems(tr, [item(e, "A")], { kind: "after", item: item(e, "A1") })).toBeNull();
  });

  it("moves between editors and keeps the block id", async () => {
    const a = await journal();
    const b = await journal("<ul><li><p>other day</p></li></ul>");
    const id = item(a, "B").node.attrs.bid as string;
    drag(a, "B");
    dropDragged(b.view, { kind: "after", item: item(b, "other day") });
    endItemDrag();
    expect(outline(a)).toEqual(["A", "  A1", "  A2", "C"]);
    expect(outline(b)).toEqual(["other day", "B"]);
    expect(findByBid(b.state.doc, id)).not.toBeNull();
  });
});

describe("tasks", () => {
  it("[ ] makes a task in place; its status icon takes the bullet's place", async () => {
    const e = await journal("<ul><li><p>first</p></li><li><p></p></li></ul>");
    const before = bids(e);
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    typeText(e, "[ ] buy milk");
    expect(outline(e)).toEqual(["first", "[ ] buy milk"]);
    expect(bids(e)).toEqual(before);
    const task = e.view.dom.querySelectorAll("li")[1];
    expect(task.querySelector(".ol-status.status-todo")).not.toBeNull();
    expect(task.querySelector(".ol-bullet")).toBeNull();
  });

  it("Mod+Enter cycles item → to do → in progress → done → item, keeping children", async () => {
    const e = await journal();
    cursorAfter(e, "A");
    const steps: string[] = [];
    for (let i = 0; i < 4; i++) {
      press(e, "Mod-Enter");
      steps.push(outline(e)[0]);
    }
    expect(steps).toEqual(["[ ] A", "[-] A", "[x] A", "A"]);
    expect(outline(e).slice(1, 3)).toEqual(["  A1", "  A2"]);
  });
});

describe("collapse and focus", () => {
  it("collapsing moves a cursor out of the hidden part", async () => {
    const e = await journal();
    cursorAfter(e, "A2");
    e.view.dispatch(setCollapsed(e.state, 1, true)!);
    expect(outline(e)[0]).toBe("A (collapsed)");
    expect(caret(e)).toBe("A|");
  });

  it("focus shows one block; Enter adds its first child; Mod+, goes back", async () => {
    const e = await journal();
    cursorAfter(e, "A1");
    press(e, "Mod-.");
    expect(focusTrail(e.state).map((s) => s.text)).toEqual(["A", "A1"]);
    expect([...e.view.dom.querySelectorAll(".folio-hidden")].map((n) => n.textContent)).toEqual(["A", "A2", "B", "C"]);
    press(e, "Enter");
    typeText(e, "child");
    expect(outline(e).slice(0, 3)).toEqual(["A", "  A1", "    child"]);
    press(e, "Mod-,");
    expect(focusTrail(e.state).map((s) => s.text)).toEqual(["A"]);
    press(e, "Mod-,");
    expect(focusTrail(e.state)).toEqual([]);
  });
});
