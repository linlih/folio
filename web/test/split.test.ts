import { UndoManager } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import { redo, undo } from "../src/vendor/loro-prosemirror";
import { bind, cursorAfter, device, settle, typeText } from "./helpers";
import type { Editor } from "@tiptap/core";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

/** Two editors on one replica and one undo history, like the same card open
 *  in both panes of a split view. */
async function twoViews() {
  const doc = device(1n);
  const history = new UndoManager(doc, { mergeInterval: 0 });
  const a = (await bind(doc, history)).editor;
  const b = (await bind(doc, history)).editor;
  editors.push(a, b);
  return { doc, a, b };
}

const run = (e: Editor, cmd: typeof undo) => {
  e.view.focus();
  return cmd(e.state, e.view.dispatch, e.view);
};

describe("split view: one card in two editors", () => {
  it("typing in either editor shows in the other", async () => {
    const { a, b } = await twoViews();
    a.commands.setTextSelection(1);
    typeText(a, "left");
    await settle();
    expect(b.state.doc.textContent).toBe("left");
    cursorAfter(b, "left");
    typeText(b, " right");
    await settle();
    expect(a.state.doc.textContent).toBe("left right");
  });

  it("undo in one editor shows in both, and redo brings it back", async () => {
    const { a, b } = await twoViews();
    a.commands.setTextSelection(1);
    typeText(a, "one");
    await settle();
    cursorAfter(b, "one");
    b.view.dispatch(b.state.tr.insertText(" two"));
    await settle();
    expect(run(b, undo)).toBe(true);
    await settle();
    expect(a.state.doc.textContent).toBe("one");
    expect(b.state.doc.textContent).toBe("one");
    expect(run(a, redo)).toBe(true);
    await settle();
    expect(a.state.doc.textContent).toBe("one two");
    expect(b.state.doc.textContent).toBe("one two");
  });

  it("closing one editor leaves the other editing and undoing", async () => {
    const { a, b } = await twoViews();
    b.destroy();
    a.commands.setTextSelection(1);
    typeText(a, "still");
    await settle();
    expect(run(a, undo)).toBe(true);
    await settle();
    expect(a.state.doc.textContent).toBe("stil");
  });
});
