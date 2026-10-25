// design/outliner.md "输入手感".
import { Editor } from "@tiptap/core";
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { continueAtEnd } from "../src/editor/outliner/feel";
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
});
