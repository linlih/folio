// An image's shown width (a share of its column) and the viewer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCard } from "../src/docs/card";
import { addFiles } from "../src/editor/assets";
import { clampScale, setScale } from "../src/editor/imageView";
import { bind, cursorAfter, device, settle, sync } from "./helpers";

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(480);
});

afterEach(() => {
  document.querySelector(".image-viewer")?.remove();
});

type Ed = Awaited<ReturnType<typeof bind>>["editor"];

function imagePos(editor: Ed): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (n.type.name === "image") pos = p;
  });
  return pos;
}

const scaleOf = (editor: Ed) => editor.state.doc.nodeAt(imagePos(editor))?.attrs.scale ?? null;
const frame = (editor: Ed) => editor.view.dom.querySelector<HTMLElement>(".image-frame")!;

async function pair() {
  const docA = device(1n);
  initCard(docA, "journal", "", 1);
  const a = await bind(docA);
  a.editor.commands.setContent("<ul><li><p>first</p></li></ul>");
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

describe("clampScale", () => {
  it("keeps whole percentages from 10 to 100, or none", () => {
    expect([clampScale(33.4), clampScale(3), clampScale(140), clampScale("50"), clampScale(null), clampScale("")]).toEqual([33, 10, 100, 50, null, null]);
  });
});

describe("an image's width", () => {
  it("is shown in a frame at its own size until one is chosen", async () => {
    const { a } = await pair();
    expect(scaleOf(a.editor)).toBeNull();
    expect(frame(a.editor).style.width).toBe("");
    expect(frame(a.editor).querySelector("img")?.getAttribute("width")).toBe("640");
  });

  it("chosen on one device is shown on the other", async () => {
    const { a, b, docA, docB } = await pair();
    setScale(a.editor.view, imagePos(a.editor), 40);
    await settle();
    expect(frame(a.editor).style.width).toBe("40%");
    sync(docA, docB);
    await settle();
    expect(scaleOf(b.editor)).toBe(40);
    expect(frame(b.editor).style.width).toBe("40%");
    // Back to its own size, the other way.
    setScale(b.editor.view, imagePos(b.editor), null);
    await settle();
    sync(docA, docB);
    await settle();
    expect(scaleOf(a.editor)).toBeNull();
    expect(frame(a.editor).style.width).toBe("");
  });

  it("travels with the image's HTML", async () => {
    const { a } = await pair();
    setScale(a.editor.view, imagePos(a.editor), 50);
    await settle();
    expect(a.editor.getHTML()).toMatch(/data-scale="50"[^>]*style="width: 50%;?"/);
  });
});

describe("the viewer", () => {
  it("opens on a double click and sizes the image in its card", async () => {
    const { a } = await pair();
    frame(a.editor).querySelector("img")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const viewer = document.querySelector(".image-viewer")!;
    expect(viewer).not.toBeNull();
    const small = [...viewer.querySelectorAll("button")].find((b) => b.textContent === "Small")!;
    small.click();
    await settle();
    expect(document.querySelector(".image-viewer")).toBeNull();
    expect(scaleOf(a.editor)).toBe(33);
  });

  it("closes with Escape and changes nothing", async () => {
    const { a } = await pair();
    frame(a.editor).querySelector("img")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.querySelector(".image-viewer")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".image-viewer")).toBeNull();
    expect(scaleOf(a.editor)).toBeNull();
  });

  it("can delete the image", async () => {
    const { a } = await pair();
    frame(a.editor).querySelector("img")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    [...document.querySelectorAll(".image-viewer button")].find((b) => b.textContent === "Delete image")!.dispatchEvent(new MouseEvent("click"));
    await settle();
    expect(imagePos(a.editor)).toBe(-1);
  });
});
