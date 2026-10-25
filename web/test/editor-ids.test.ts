import { Slice } from "@tiptap/pm/model";
import { describe, expect, it, beforeEach } from "vitest";
import { _test as pasteTest } from "../src/editor/pasteIds";
import { bids, bind, device, settle, sync } from "./helpers";

beforeEach(() => pasteTest.reset());

describe("block ids", () => {
  it("every block gets one, and they are unique", async () => {
    const { editor } = await bind(device(1n));
    editor.commands.setContent("<p>a</p><ul><li><p>b</p></li></ul><h2>c</h2>");
    const ids = bids(editor);
    expect(ids.length).toBe(4); // paragraph, listItem, its paragraph, heading
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("splitting a block gives the new half a new id", async () => {
    const { editor } = await bind(device(1n));
    editor.commands.setContent("<p>hello world</p>");
    const [before] = bids(editor);
    editor.commands.setTextSelection(6);
    editor.commands.splitBlock();
    const ids = bids(editor);
    expect(ids[0]).toBe(before);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(before);
  });

  it("repairs duplicates that arrive by merge the same way on every replica", async () => {
    const x = device(1n);
    const y = device(2n);
    const a = await bind(x);
    a.editor.commands.setContent('<p data-bid="same">one</p>');
    await settle();
    sync(x, y);
    const b = await bind(y);
    // Both devices insert a block carrying the same id while offline.
    a.editor.commands.insertContentAt(a.editor.state.doc.content.size, '<p data-bid="dup">from a</p>');
    b.editor.commands.insertContentAt(b.editor.state.doc.content.size, '<p data-bid="dup">from b</p>');
    await settle();
    sync(x, y);
    await settle();
    sync(x, y);
    await settle();
    const ids = bids(a.editor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(bids(b.editor)).toEqual(ids);
  });
});

describe("paste", () => {
  const paste = (editor: Parameters<typeof bids>[0], slice: Slice) => {
    let out = slice;
    editor.view.someProp("transformPasted", (f) => {
      out = f(out, editor.view, false);
    });
    return out;
  };
  const sliceBids = (s: Slice) => {
    const out: (string | null)[] = [];
    s.content.descendants((n) => void ("bid" in n.attrs && out.push(n.attrs.bid as string | null)));
    return out;
  };

  it("a copy gets new ids", async () => {
    const { editor } = await bind(device(1n));
    editor.commands.setContent("<p>one</p><p>two</p>");
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    expect(sliceBids(paste(editor, slice)).every((b) => b === null)).toBe(true);
  });

  it("a cut keeps its ids once", async () => {
    const { editor } = await bind(device(1n));
    editor.commands.setContent("<p>one</p><p>two</p>");
    editor.commands.selectAll();
    const slice = editor.state.selection.content();
    const original = sliceBids(slice);
    editor.view.someProp("handleDOMEvents", (h) => void h.cut?.(editor.view, new Event("cut") as ClipboardEvent));
    expect(sliceBids(paste(editor, slice))).toEqual(original);
    // Pasting the same cut again is a copy.
    expect(sliceBids(paste(editor, slice)).every((b) => b === null)).toBe(true);
  });
});
