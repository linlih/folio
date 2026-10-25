// The rest of design/outliner.md: selection keys, autopair, copy and paste.
import { Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { markdownToItems, sliceToItems } from "../src/editor/outliner/paste";
import { blockSelection, itemsToMarkdown, selectedItems } from "../src/editor/outliner/selection";
import { bind, caret, cursorAfter, cursorBefore, device, outline, press, settle, typeText } from "./helpers";

const TREE = "<ul><li><p>A</p><ul><li><p>A1</p></li><li><p>A2</p></li></ul></li><li><p>B</p></li></ul>";

async function journal(html = TREE) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return editor;
}

const selectedTexts = (e: Awaited<ReturnType<typeof journal>>) => selectedItems(e.state).map((i) => i.node.firstChild!.textContent);

describe("selection keys", () => {
  it("Shift+↑ on a block's first row selects the block, then extends", async () => {
    const e = await journal();
    cursorAfter(e, "B");
    press(e, "Shift-ArrowUp");
    expect(selectedTexts(e)).toEqual(["B"]);
    press(e, "Shift-ArrowUp");
    expect(selectedTexts(e)).toEqual(["A2", "B"]);
  });

  it("Mod+A selects the text, then the block, then its parent, then everything", async () => {
    const e = await journal();
    cursorAfter(e, "A2");
    press(e, "Mod-a");
    expect(blockSelection(e.state)).toBeNull();
    expect(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)).toBe("A2");
    press(e, "Mod-a");
    expect(selectedTexts(e)).toEqual(["A2"]);
    press(e, "Mod-a");
    expect(selectedTexts(e)).toEqual(["A"]);
    press(e, "Mod-a");
    expect(selectedTexts(e)).toEqual(["A", "A1", "A2", "B"]);
  });

  it("clears the line, or what is before the cursor", async () => {
    const e = await journal("<ul><li><p>hello world</p></li></ul>");
    const mac = /Mac/.test(navigator.platform);
    cursorAfter(e, "hello ");
    press(e, mac ? "Ctrl-u" : "Alt-u");
    expect(outline(e)).toEqual(["world"]);
    press(e, mac ? "Ctrl-l" : "Alt-l");
    expect(outline(e)).toEqual([""]);
  });

  it("a mouse selection across blocks becomes a block selection", async () => {
    const e = await journal();
    cursorBefore(e, "A1");
    const from = e.state.selection.from;
    cursorAfter(e, "B");
    e.commands.setTextSelection({ from, to: e.state.selection.to });
    e.view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(selectedTexts(e)).toEqual(["A1", "A2", "B"]);
  });
});

describe("autopair", () => {
  it("pairs [ and steps over a typed ]; Backspace removes an empty pair", async () => {
    const e = await journal("<ul><li><p></p></li></ul>");
    e.commands.setTextSelection(3);
    typeText(e, "a[");
    expect(caret(e)).toBe("a[|]");
    typeText(e, "b]");
    expect(caret(e)).toBe("a[b]|");
    typeText(e, " {");
    expect(caret(e)).toBe("a[b] {|}");
    press(e, "Backspace");
    expect(caret(e)).toBe("a[b] |");
  });

  it("[ ] still makes a task", async () => {
    const e = await journal("<ul><li><p></p></li></ul>");
    e.commands.setTextSelection(3);
    typeText(e, "[ ] buy milk");
    expect(outline(e)).toEqual(["[ ] buy milk"]);
  });

  it("full-width 【【 becomes [[]]", async () => {
    const e = await journal("<ul><li><p></p></li></ul>");
    e.commands.setTextSelection(3);
    typeText(e, "【【");
    expect(caret(e)).toBe("[[|]]");
  });

  it("( wraps a selection", async () => {
    const e = await journal("<ul><li><p>word</p></li></ul>");
    e.commands.setTextSelection({ from: 3, to: 7 });
    typeText(e, "(");
    expect(outline(e)).toEqual(["(word)"]);
  });
});

describe("copy and paste", () => {
  it("copies blocks as a tab-indented Markdown outline", async () => {
    const e = await journal("<ul><li><p>A</p><ul><li data-type='taskItem' data-checked='true'><p>done</p></li></ul></li></ul>");
    const nodes: import("@tiptap/pm/model").Node[] = [];
    e.state.doc.firstChild!.forEach((n) => void nodes.push(n));
    expect(itemsToMarkdown(nodes)).toEqual(["- A", "\t- [x] done"]);
    e.commands.setContent("<ul><li><p>see <span data-card-id='c1'>Card</span> now</p></li></ul>");
    const withLink: import("@tiptap/pm/model").Node[] = [];
    e.state.doc.firstChild!.forEach((n) => void withLink.push(n));
    expect(itemsToMarkdown(withLink)).toEqual(["- see [[Card]] now"]);
  });

  it("parses Markdown into nested blocks, tasks and paragraphs", async () => {
    const e = await journal();
    const md = "- one\n  - [ ] two\n    - [x] three\n- four\n\nA paragraph\nstill it\n\n## Heading";
    const items = markdownToItems(e.schema, md);
    const list = e.schema.nodes.bulletList.create(null, items);
    e.commands.setContent(e.schema.nodes.doc.create(null, list).toJSON());
    expect(outline(e)).toEqual(["one", "  [ ] two", "    [x] three", "four", "A paragraph still it", "Heading"]);
  });

  it("pasting several blocks inserts them after the current block", async () => {
    const e = await journal("<ul><li><p>here</p></li><li><p>after</p></li></ul>");
    cursorAfter(e, "here");
    const pasted = e.schema.nodes.doc.create(null, [
      e.schema.nodes.paragraph.create(null, e.schema.text("p1")),
      e.schema.nodes.bulletList.create(null, [
        e.schema.nodes.listItem.create(null, [
          e.schema.nodes.paragraph.create(null, e.schema.text("l1")),
          e.schema.nodes.bulletList.create(null, e.schema.nodes.listItem.create(null, e.schema.nodes.paragraph.create(null, e.schema.text("l2")))),
        ]),
      ]),
    ]);
    const slice = new Slice(pasted.content, 0, 0);
    expect(sliceToItems(e.schema, slice)).toHaveLength(2);
    const event = { clipboardData: { getData: (t: string) => (t === "text/html" ? "<p>p1</p>" : "p1") } } as unknown as ClipboardEvent;
    e.view.someProp("handlePaste", (f) => f(e.view, event, slice));
    expect(outline(e)).toEqual(["here", "p1", "l1", "  l2", "after"]);
    expect(caret(e)).toBe("l1|");
  });

  it("pasting Markdown text into an empty block replaces it", async () => {
    const e = await journal("<ul><li><p>x</p></li><li><p></p></li></ul>");
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    const event = { clipboardData: { getData: (t: string) => (t === "text/plain" ? "- a\n  - b" : "") } } as unknown as ClipboardEvent;
    e.view.someProp("handlePaste", (f) => f(e.view, event, Slice.empty));
    expect(outline(e)).toEqual(["x", "a", "  b"]);
  });

  it("one line goes into the current block", async () => {
    const e = await journal("<ul><li><p>ab</p></li></ul>");
    cursorAfter(e, "a");
    const event = { clipboardData: { getData: (t: string) => (t === "text/plain" ? "XYZ" : "") } } as unknown as ClipboardEvent;
    const slice = new Slice(e.schema.nodes.paragraph.create(null, e.schema.text("XYZ")).content, 0, 0);
    expect(e.view.someProp("handlePaste", (f) => f(e.view, event, slice))).toBeFalsy();
  });
});
