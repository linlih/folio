// design/outliner.md "任务" and the `/` commands.
import { Editor } from "@tiptap/core";
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { _slashChoices } from "../src/editor/outliner/suggest";
import { makeTask, setTaskState, taskState } from "../src/editor/outliner/tasks";
import { itemAt } from "../src/editor/outliner/tree";
import { STATUSES } from "../src/editor/outliner/statusIcons";
import { bind, caret, cursorAfter, cursorBefore, device, outline, press, settle, typeText } from "./helpers";

async function journal(html: string) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return editor;
}

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

const at = (e: Editor, text: string) => (cursorAfter(e, text), itemAt(e.state.selection.$head)!);

/** Runs a `/` command as if picked from the menu at the cursor. */
function slash(e: Editor, id: string) {
  const choice = _slashChoices().find((c) => c.id === id)!;
  const pos = e.state.selection.from;
  return choice.run(e, { from: pos, to: pos });
}

describe("statuses", () => {
  it("has Logseq's six statuses, each with its own icon", async () => {
    const e = await journal("<ul><li><p>t</p></li></ul>");
    for (const s of STATUSES) {
      const tr = e.state.tr;
      setTaskState(tr, at(e, "t"), s);
      e.view.dispatch(tr);
      expect(taskState(at(e, "t"))).toBe(s);
      expect(e.view.dom.querySelector(`.ol-status.status-${s}`)).not.toBeNull();
      expect(e.view.dom.querySelector(".ol-bullet")).toBeNull();
    }
  });

  it("Mod+Enter cycles like Logseq: Todo → Doing → Done → none; others go to Todo", async () => {
    const e = await journal("<ul><li><p>t</p></li></ul>");
    cursorAfter(e, "t");
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      press(e, "Mod-Enter");
      seen.push(taskState(at(e, "t")));
    }
    expect(seen).toEqual(["todo", "doing", "done", "item"]);
    const tr = e.state.tr;
    setTaskState(tr, at(e, "t"), "review");
    e.view.dispatch(tr);
    press(e, "Mod-Enter");
    expect(taskState(at(e, "t"))).toBe("todo");
  });
});

describe("task lines", () => {
  it("Backspace at the start drops the status and keeps the text; again it joins", async () => {
    const e = await journal("<ul><li><p>above</p></li><li><p>[ ] </p></li></ul>");
    e.commands.setContent("<ul><li><p>above</p></li><li><p></p></li></ul>");
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    typeText(e, "[ ] buy milk");
    cursorBefore(e, "buy");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["above", "buy milk"]);
    expect(caret(e)).toBe("|buy milk");
    press(e, "Backspace");
    expect(outline(e)).toEqual(["abovebuy milk"]);
  });

  it("Enter after a task makes a plain block; Enter on an empty task makes it plain", async () => {
    const e = await journal("<ul><li><p></p></li></ul>");
    e.commands.setTextSelection(3);
    typeText(e, "[ ] one");
    press(e, "Enter");
    typeText(e, "two");
    expect(outline(e)).toEqual(["[ ] one", "two"]);
    const tr = e.state.tr;
    setTaskState(tr, at(e, "two"), "todo");
    e.view.dispatch(tr);
    press(e, "Enter");
    expect(outline(e)).toEqual(["[ ] one", "[ ] two", ""]);
    // The new line is plain; Enter on an empty task would have made it so.
    const t2 = e.state.tr;
    setTaskState(t2, itemAt(e.state.selection.$head)!, "todo");
    e.view.dispatch(t2);
    press(e, "Enter");
    expect(outline(e)).toEqual(["[ ] one", "[ ] two", ""]);
  });

  it("in a card, [ ] turns a paragraph into a task block, and Enter continues with plain lines", async () => {
    const e = await card("<p>intro</p><p></p>");
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    typeText(e, "[ ] call mum");
    expect(e.getJSON().content?.map((n) => n.type)).toEqual(["paragraph", "bulletList"]);
    expect(outline(e)).toEqual(["intro", "[ ] call mum"]);
    press(e, "Enter");
    typeText(e, "plain");
    expect(outline(e)).toEqual(["intro", "[ ] call mum", "plain"]);
  });

  it("a pasted task list accepts plain lines", async () => {
    const e = await card("<ul data-type='taskList'><li data-type='taskItem' data-checked='false'><p>t</p></li></ul>");
    cursorAfter(e, "t");
    press(e, "Enter");
    typeText(e, "x");
    expect(outline(e)).toEqual(["[ ] t", "x"]);
  });
});

describe("/ commands", () => {
  it("covers Logseq's groups", () => {
    const ids = _slashChoices().map((c) => c.id);
    for (const id of ["ref", "link", "image", "underline", "code", "quote", "math", "text", "h1", "h6", ...STATUSES, "deadline", "scheduled", "priority-none", "priority-urgent", "today", "tomorrow", "yesterday", "time", "date", "numbered", "numbered-children"]) {
      expect(ids).toContain(id);
    }
  });

  it("headings and normal text change the line", async () => {
    const e = await journal("<ul><li><p>line</p></li></ul>");
    cursorAfter(e, "line");
    await slash(e, "h4");
    expect(e.state.selection.$head.parent.type.name).toBe("heading");
    expect(e.state.selection.$head.parent.attrs.level).toBe(4);
    await slash(e, "text");
    expect(e.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  it("status, priority, quote and numbering set the block's properties", async () => {
    const e = await journal("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    cursorAfter(e, "a");
    await slash(e, "review");
    expect(taskState(at(e, "a"))).toBe("review");
    await slash(e, "priority-high");
    expect(at(e, "a").node.attrs.priority).toBe("high");
    expect(e.view.dom.querySelector(".ol-priority.priority-high")).not.toBeNull();
    await slash(e, "quote");
    expect(at(e, "a").node.attrs.display).toBe("quote");
    await slash(e, "numbered");
    expect(e.state.doc.firstChild!.type.name).toBe("orderedList");
  });

  it("today links to today's journal; a code block goes inside the block", async () => {
    const e = await journal("<ul><li><p>see</p></li></ul>");
    cursorAfter(e, "see");
    await slash(e, "today");
    let link: { cardId: string } | null = null;
    e.state.doc.descendants((n) => void (n.type.name === "cardLink" && (link = n.attrs as { cardId: string })));
    expect(link!.cardId).toMatch(/^journal:\d{4}-\d{2}-\d{2}$/);
    await slash(e, "code");
    const item = e.state.doc.firstChild!.firstChild!;
    expect(item.child(1).type.name).toBe("codeBlock");
  });
});

describe("cards are text by default", () => {
  const types = (e: Editor) => e.getJSON().content?.map((n) => n.type);

  it("Backspace at the start of a task line gives a normal paragraph, no bullet", async () => {
    const e = await card("<p>intro</p><p></p>");
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    typeText(e, "[ ] call mum");
    expect(types(e)).toEqual(["paragraph", "bulletList"]);
    cursorBefore(e, "call");
    press(e, "Backspace");
    expect(types(e)).toEqual(["paragraph", "paragraph"]);
    expect(caret(e)).toBe("|call mum");
  });

  it("Enter after a task line starts a normal paragraph; an empty task becomes one", async () => {
    const e = await card("<p></p>");
    e.commands.setTextSelection(1);
    typeText(e, "[ ] one");
    press(e, "Enter");
    typeText(e, "text");
    expect(types(e)).toEqual(["bulletList", "paragraph"]);
    expect(caret(e)).toBe("text|");
    const tr = makeTaskAt(e, "text");
    e.view.dispatch(tr);
    cursorAfter(e, "text");
    press(e, "Enter");
    expect(types(e)).toEqual(["bulletList", "bulletList", "paragraph"]);
    // An empty task line: Enter turns it back into a paragraph.
    press(e, "Mod-Enter");
    expect(types(e)).toEqual(["bulletList", "bulletList", "bulletList"]);
    press(e, "Enter");
    expect(types(e)).toEqual(["bulletList", "bulletList", "paragraph"]);
  });

  it("a journal keeps outline behaviour: the task becomes a plain item", async () => {
    const e = await journal("<ul><li><p></p></li></ul>");
    e.commands.setTextSelection(3);
    typeText(e, "[ ] t");
    cursorBefore(e, "t");
    press(e, "Backspace");
    expect(types(e)).toEqual(["bulletList"]);
    expect(outline(e)).toEqual(["t"]);
  });

  it("priority on a normal line in a card makes it a task, not a bullet", async () => {
    const e = await card("<p>ship it</p>");
    cursorAfter(e, "ship it");
    await slash(e, "priority-high");
    expect(outline(e)).toEqual(["[ ] ship it"]);
    expect(at(e, "ship it").node.attrs.priority).toBe("high");
  });

  it("an extracted block's children become paragraphs in the card", async () => {
    const { toDocumentBlocks } = await import("../src/editor/extract");
    const e = await journal("<ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li><li data-type='taskItem' data-checked='false'><p>t</p></li></ul>");
    const list = e.state.doc.firstChild!;
    const blocks = toDocumentBlocks(e.schema, [list]);
    expect(blocks.map((b) => b.type.name)).toEqual(["paragraph", "bulletList", "bulletList"]);
    expect(blocks[0].attrs.bid).toBe(list.firstChild!.attrs.bid);
  });
});

function makeTaskAt(e: Editor, text: string) {
  cursorAfter(e, text);
  return makeTask(e.state, "todo")!;
}
