// design/outliner.md "输入手感".
import { Editor } from "@tiptap/core";
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { continueAtEnd, repairComposition } from "../src/editor/outliner/feel";
import { blockSelection } from "../src/editor/outliner/selection";
import { bind, caret, cursorAfter, cursorBefore, device, outline, press, settle, typeText } from "./helpers";

async function card(html: string) {
  const doc = device(1n);
  initCard(doc, "note", "", 1);
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...baseExtensions(isRemoteTx, "", "document"), LoroBinding(doc, new UndoManager(doc, {}))],
  });
  await settle();
  editor.commands.setContent(html);
  return editor;
}

async function journal(html: string) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return editor;
}

const types = (e: Editor) => e.getJSON().content?.map((n) => n.type);

describe("input feel", () => {
  it("Backspace right after a Markdown shortcut restores what was typed", async () => {
    const e = await card("<p></p>");
    e.commands.setTextSelection(1);
    typeText(e, "- ");
    expect(types(e)).toEqual(["bulletList"]);
    press(e, "Backspace");
    expect(types(e)).toEqual(["paragraph"]);
    expect(e.getText()).toBe("- ");
  });

  it("Backspace at the start of a heading makes it a paragraph first", async () => {
    const e = await card("<p>above</p><h2>Title</h2>");
    cursorBefore(e, "Title");
    press(e, "Backspace");
    expect(types(e)).toEqual(["paragraph", "paragraph"]);
    press(e, "Backspace");
    expect(e.getText()).toBe("aboveTitle");
  });

  it("Tab outside lists keeps the focus in the editor and changes nothing", async () => {
    const e = await card("<p>text</p>");
    cursorAfter(e, "te");
    const before = e.getJSON();
    expect(press(e, "Tab")).toBe(true);
    expect(e.getJSON()).toEqual(before);
  });

  it("Tab in a code block indents", async () => {
    const e = await card("<pre><code>x</code></pre>");
    e.commands.setTextSelection(1);
    press(e, "Tab");
    expect(e.getText()).toBe("  x");
  });

  it("a click below the text continues on a new last line", async () => {
    const e = await card("<p>last</p>");
    continueAtEnd(e, false);
    expect(types(e)).toEqual(["paragraph", "paragraph"]);
    expect(caret(e)).toBe("|");
    continueAtEnd(e, false); // the empty last line is reused
    expect(types(e)).toEqual(["paragraph", "paragraph"]);
  });

  it("in a journal, a click below adds a top-level block", async () => {
    const e = await journal("<ul><li><p>a</p><ul><li><p>child</p></li></ul></li></ul>");
    continueAtEnd(e, true);
    typeText(e, "next");
    expect(outline(e)).toEqual(["a", "  child", "next"]);
  });

  it("the empty line being typed in hints at /", async () => {
    const e = await journal("<ul><li><p>a</p></li><li><p></p></li></ul>");
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    const empty = e.view.dom.querySelectorAll("li p")[1];
    expect(empty.getAttribute("data-placeholder")).toContain("/");
  });

  it("dragging a selection across lines in a card stays a text selection", async () => {
    const e = await card("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    cursorBefore(e, "one");
    const from = e.state.selection.from;
    cursorAfter(e, "two");
    e.commands.setTextSelection({ from, to: e.state.selection.to });
    e.view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(blockSelection(e.state)).toBeNull();
    expect(e.state.selection.empty).toBe(false);
  });

  it("puts a composition iOS moved out of an emptied list item back into it", async () => {
    const e = await journal("<ul><li><p>above</p></li><li><p></p></li></ul><p>测试</p>");
    const items: string[] = [];
    e.state.doc.descendants((n) => void (n.type.name === "listItem" && items.push(n.attrs.bid)));
    cursorAfter(e, "测试");
    expect(repairComposition(e.view, items[1])).toBe(true);
    expect(types(e)).toEqual(["bulletList"]);
    const list = e.state.doc.firstChild!;
    expect(Array.from({ length: list.childCount }, (_, i) => list.child(i).textContent)).toEqual(["above", "测试"]);
    expect(caret(e)).toBe("测试|");
    // Nothing to put back: the cursor's line is where it should be.
    expect(repairComposition(e.view, items[1])).toBe(false);
  });

  it("puts a composition iOS moved into a new item back into the emptied one", async () => {
    const e = await journal("<ul><li><p>above</p></li><li><p></p></li><li><p>你</p></li></ul>");
    const items: string[] = [];
    e.state.doc.descendants((n) => void (n.type.name === "listItem" && items.push(n.attrs.bid)));
    cursorAfter(e, "你");
    expect(repairComposition(e.view, items[1])).toBe(true);
    const list = e.state.doc.firstChild!;
    expect(Array.from({ length: list.childCount }, (_, i) => list.child(i).textContent)).toEqual(["above", "你"]);
    expect(caret(e)).toBe("你|");
    // An empty item the composition did not start in is left alone.
    const f = await journal("<ul><li><p></p></li><li><p>你</p></li></ul>");
    cursorAfter(f, "你");
    expect(repairComposition(f.view, "elsewhere")).toBe(false);
  });

  it("drops the copy when the item iOS moved the composition out of kept it too", async () => {
    const html = "<ul><li><p>above</p></li><li><p>你好</p></li><li><p>你好</p></li></ul>";
    const e = await journal(html);
    const items: string[] = [];
    e.state.doc.descendants((n) => void (n.type.name === "listItem" && items.push(n.attrs.bid)));
    // At the end of the last line.
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    expect(repairComposition(e.view, items[1])).toBe(true);
    const list = e.state.doc.firstChild!;
    expect(Array.from({ length: list.childCount }, (_, i) => list.child(i).textContent)).toEqual(["above", "你好"]);
    expect(caret(e)).toBe("你好|");
    // Typed into the last item: two lines alike stay two lines.
    const f = await journal(html);
    const last: string[] = [];
    f.state.doc.descendants((n) => void (n.type.name === "listItem" && last.push(n.attrs.bid)));
    f.commands.setTextSelection(f.state.doc.content.size - 3);
    expect(repairComposition(f.view, last[2])).toBe(false);
  });
});
