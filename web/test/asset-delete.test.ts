// Removing an image reaches the other devices like any edit.
import { NodeSelection } from "@tiptap/pm/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initCard } from "../src/docs/card";
import { addFiles } from "../src/editor/assets";
import { bind, cursorAfter, device, settle, sync } from "./helpers";

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(480);
});

const images = (e: { state: { doc: { descendants(f: (n: { type: { name: string } }) => void): void } } }) => {
  let n = 0;
  e.state.doc.descendants((node) => {
    if (node.type.name === "image") n++;
  });
  return n;
};

async function pair() {
  const docA = device(1n);
  initCard(docA, "journal", "", 1);
  const a = await bind(docA);
  a.editor.commands.setContent("<ul><li><p>first</p></li><li><p>second</p></li></ul>");
  await settle();
  cursorAfter(a.editor, "first");
  await addFiles(a.editor.view, [new File(["png"], "shot.png", { type: "image/png" })]);
  await settle();
  const docB = device(2n);
  const b = await bind(docB);
  sync(docA, docB);
  await settle();
  return { a, b, docA, docB };
}

function selectImage(editor: Awaited<ReturnType<typeof bind>>["editor"]) {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (n.type.name === "image") pos = p;
  });
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

describe("removing an image", () => {
  it("on the device that added it reaches the other", async () => {
    const { a, b, docA, docB } = await pair();
    expect([images(a.editor), images(b.editor)]).toEqual([1, 1]);
    selectImage(a.editor);
    a.editor.commands.deleteSelection();
    await settle();
    expect(images(a.editor)).toBe(0);
    sync(docA, docB);
    await settle();
    expect(images(b.editor)).toBe(0);
  });

  it("on the other device reaches the one that added it", async () => {
    const { a, b, docA, docB } = await pair();
    selectImage(b.editor);
    b.editor.commands.deleteSelection();
    await settle();
    expect(images(b.editor)).toBe(0);
    sync(docA, docB);
    await settle();
    expect(images(a.editor)).toBe(0);
  });
});
