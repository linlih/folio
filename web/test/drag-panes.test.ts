import { Editor } from "@tiptap/core";
import { UndoManager } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { dropDragged, dropMode, endItemDrag, startHandleDrag, startItemDrag } from "../src/editor/outliner/dnd";
import { findByBid, itemAt, type Item } from "../src/editor/outliner/tree";
import { cursorAfter, device, outline, settle } from "./helpers";

const editors: Editor[] = [];
afterEach(() => {
  endItemDrag();
  editors.splice(0).forEach((e) => e.destroy());
  document.body.innerHTML = "";
});

/** An editor inside a pane of the split view, like PaneView renders it. */
async function inPane(pane: string, html: string, mode: "outline" | "document" = "outline") {
  const doc = device(1n);
  initCard(doc, mode === "outline" ? "journal" : "note", "", 1);
  const host = document.createElement("div");
  host.dataset.pane = pane;
  const element = document.createElement("div");
  host.append(element);
  document.body.append(host);
  const editor = new Editor({
    element,
    extensions: [...baseExtensions(isRemoteTx, "", mode), LoroBinding(doc, new UndoManager(doc, { mergeInterval: 0 }))],
  });
  editors.push(editor);
  await settle();
  editor.commands.setContent(html);
  await settle();
  return editor;
}

const item = (editor: Editor, text: string): Item => {
  cursorAfter(editor, text);
  return itemAt(editor.state.selection.$head)!;
};
const dragItem = (e: Editor, text: string) => startItemDrag(e.view, item(e, text), new Event("dragstart") as DragEvent);
const keys = (k: Partial<{ altKey: boolean; metaKey: boolean }> = {}) => ({ altKey: false, metaKey: false, ctrlKey: false, ...k });

describe("dragging between panes", () => {
  it("copies into the other pane, moves within a pane; ⌥ copies, ⌘ moves", async () => {
    const left = await inPane("left", "<ul><li><p>a</p></li></ul>");
    const leftToo = await inPane("left", "<ul><li><p>b</p></li></ul>");
    const right = await inPane("right", "<p>c</p>", "document");
    expect(dropMode(left.view, right.view, keys())).toBe("copy");
    expect(dropMode(left.view, leftToo.view, keys())).toBe("move");
    expect(dropMode(left.view, right.view, keys({ metaKey: true }))).toBe("move");
    expect(dropMode(left.view, leftToo.view, keys({ altKey: true }))).toBe("copy");
  });

  it("a journal block dropped on a card in the other pane is copied, with a new id", async () => {
    const journal = await inPane("left", "<ul><li><p>idea</p><ul><li><p>detail</p></li></ul></li><li><p>other</p></li></ul>");
    const card = await inPane("right", "<p>intro</p><p>end</p>", "document");
    const id = item(journal, "idea").node.attrs.bid as string;
    dragItem(journal, "idea");
    const intro = card.view.state.doc.child(0);
    dropDragged(card.view, { kind: "top", pos: intro.nodeSize }, "copy");
    await settle();
    // The journal keeps it; the card has it as a list after "intro".
    expect(outline(journal)).toEqual(["idea", "  detail", "other"]);
    expect(outline(card)).toEqual(["intro", "idea", "  detail", "end"]);
    const copied = findByBid(card.state.doc, id);
    expect(copied).toBeNull();
    expect(item(card, "idea").node.attrs.bid).toBeTruthy();
  });

  it("⌘-drag moves it instead, keeping the id", async () => {
    const journal = await inPane("left", "<ul><li><p>idea</p></li><li><p>other</p></li></ul>");
    const card = await inPane("right", "<ul><li><p>here</p></li></ul>", "document");
    const id = item(journal, "idea").node.attrs.bid as string;
    dragItem(journal, "idea");
    dropDragged(card.view, { kind: "after", item: item(card, "here") }, "move");
    await settle();
    expect(outline(journal)).toEqual(["other"]);
    expect(outline(card)).toEqual(["here", "idea"]);
    expect(findByBid(card.state.doc, id)).not.toBeNull();
  });

  it("a card paragraph dragged by its handle into a journal becomes a block there", async () => {
    const card = await inPane("left", "<p>quote me</p><p>rest</p>", "document");
    const journal = await inPane("right", "<ul><li><p>today</p></li></ul>");
    startHandleDrag(card.view, card.state.doc.child(0), new Event("dragstart") as DragEvent);
    dropDragged(journal.view, { kind: "after", item: item(journal, "today") }, "copy");
    await settle();
    expect(outline(journal)).toEqual(["today", "quote me"]);
    expect(card.state.doc.textContent).toBe("quote merest");
  });

  it("the same card open in both panes: a ⌘-drag across is a plain move", async () => {
    const left = await inPane("left", "<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    // The right pane is a second editor on the same document.
    const host = document.createElement("div");
    host.dataset.pane = "right";
    const element = document.createElement("div");
    host.append(element);
    document.body.append(host);
    const state = (await import("../src/vendor/loro-prosemirror")).loroSyncPluginKey.getState(left.state)!;
    const right = new Editor({ element, extensions: [...baseExtensions(isRemoteTx), LoroBinding(state.doc as never, new UndoManager(state.doc as never, {}))] });
    editors.push(right);
    await settle();
    dragItem(left, "one");
    dropDragged(right.view, { kind: "after", item: item(right, "two") }, "move");
    await settle();
    expect(outline(left)).toEqual(["two", "one"]);
    expect(outline(right)).toEqual(["two", "one"]);
  });
});
