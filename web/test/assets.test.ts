// Images and attachments in cards (design/attachments.md §3–§4).
import { Slice } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCard } from "../src/docs/card";
import { addFiles, clipboardFiles, formatSize } from "../src/editor/assets";
import { backend } from "../src/platform";
import { bids, bind, cursorAfter, device, settle, sync } from "./helpers";

/** jsdom cannot decode pictures or make object URLs: here every picture
 *  is 640 × 480, unless a test makes pictures undecodable. */
let decodable = true;
beforeEach(() => {
  let n = 0;
  decodable = true;
  URL.createObjectURL = () => `blob:test/${++n}`;
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => (decodable ? Promise.resolve() : Promise.reject(new Error("unsupported"))),
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(480);
});
afterEach(() => {
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
});

const png = (name = "shot.png", body = "png bytes") => new File([body], name, { type: "image/png" });
const pdf = (name = "plan.pdf") => new File(["%PDF-1.7"], name, { type: "application/pdf" });

async function journal(html = "<ul><li><p>first</p></li><li><p>second</p></li></ul>") {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return { doc, editor };
}

/** The block-level file nodes, in order: type and name. */
const files = (e: Awaited<ReturnType<typeof journal>>["editor"]) => {
  const out: string[] = [];
  e.state.doc.descendants((n) => {
    if (n.type.name === "image" || n.type.name === "file") out.push(`${n.type.name}:${n.attrs.name}`);
  });
  return out;
};

describe("adding files", () => {
  it("puts images and attachments after the current line, in order", async () => {
    const { editor } = await journal();
    cursorAfter(editor, "first");
    await addFiles(editor.view, [png(), pdf()]);
    expect(files(editor)).toEqual(["image:shot.png", "file:plan.pdf"]);
    // Inside the first item, after its line; the second item is untouched.
    const first = editor.state.doc.firstChild!.firstChild!;
    expect(first.childCount).toBe(3);
    expect(first.child(1).type.name).toBe("image");
    const image = first.child(1).attrs;
    expect(image).toMatchObject({ name: "shot.png", mime: "image/png", size: 9, width: 640, height: 480, alt: "shot.png", src: null });
    expect(image.asset).toMatch(/^[0-9a-f]{64}$/);
    expect(first.child(2).attrs).toMatchObject({ name: "plan.pdf", mime: "application/pdf", size: 8 });
  });

  it("gives file blocks block ids, like images", async () => {
    const { editor } = await journal();
    cursorAfter(editor, "first");
    await addFiles(editor.view, [pdf()]);
    await settle();
    let bid: string | null = null;
    editor.state.doc.descendants((n) => void (n.type.name === "file" && (bid = n.attrs.bid as string)));
    expect(bid).toBeTruthy();
    expect(bids(editor)).toContain(bid);
  });

  it("stores the same content once", async () => {
    const a = await backend.addAsset(png("a.png", "same"));
    const b = await backend.addAsset(png("b.png", "same"));
    expect(a.sha256).toBe(b.sha256);
    expect(backend.assetUrl(a.sha256)).toBe(backend.assetUrl(b.sha256));
  });

  it("leaves out files over 100 MB and says so", async () => {
    const { editor } = await journal();
    const big = png("huge.png");
    Object.defineProperty(big, "size", { value: 100 * 1024 * 1024 + 1 });
    cursorAfter(editor, "first");
    await addFiles(editor.view, [big, pdf()]);
    expect(files(editor)).toEqual(["file:plan.pdf"]);
  });

  it("an image the web view cannot show becomes an attachment", async () => {
    decodable = false;
    const { editor } = await journal();
    cursorAfter(editor, "first");
    await addFiles(editor.view, [new File(["tiff"], "scan.tiff", { type: "image/tiff" })]);
    expect(files(editor)).toEqual(["file:scan.tiff"]);
  });
});

describe("in the document", () => {
  it("an image shows from the library address, which is never stored", async () => {
    const { editor } = await journal();
    cursorAfter(editor, "first");
    await addFiles(editor.view, [png()]);
    const img = editor.view.dom.querySelector("img")!;
    const asset = img.getAttribute("data-asset")!;
    expect(img.getAttribute("src")).toBe(backend.assetUrl(asset));
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["640", "480"]);
    expect(editor.state.doc.firstChild!.firstChild!.child(1).attrs.src).toBeNull();
  });

  it("web images keep their address", async () => {
    const { editor } = await journal('<p>x</p><img src="https://example.com/a.png">');
    const img = editor.view.dom.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img.hasAttribute("data-asset")).toBe(false);
  });

  it("files reach another device with everything needed to show them", async () => {
    const one = await journal();
    cursorAfter(one.editor, "first");
    await addFiles(one.editor.view, [png(), pdf()]);
    await settle();
    const doc = device(2n);
    const two = await bind(doc);
    sync(one.doc, doc);
    await settle();
    expect(files(two.editor)).toEqual(["image:shot.png", "file:plan.pdf"]);
    const file = two.editor.view.dom.querySelector(".file-block")!;
    expect(file.querySelector(".file-name")!.textContent).toBe("plan.pdf");
    expect(file.querySelector(".file-size")!.textContent).toBe("8 B");
    expect(two.editor.view.dom.querySelector("img")!.getAttribute("height")).toBe("480");
  });

  it("clicking a file's name opens it", async () => {
    const open = vi.spyOn(backend, "openAsset").mockResolvedValue();
    const { editor } = await journal();
    cursorAfter(editor, "first");
    await addFiles(editor.view, [pdf()]);
    let pos = -1;
    editor.state.doc.descendants((n, p) => void (n.type.name === "file" && (pos = p)));
    const node = editor.state.doc.nodeAt(pos)!;
    const name = editor.view.dom.querySelector(".file-name")!;
    const size = editor.view.dom.querySelector(".file-size")!;
    const click = (target: Element) =>
      editor.view.someProp("handleClickOn", (f) => f(editor.view, pos, node, pos, { target } as unknown as MouseEvent, true));
    expect(click(size)).toBeFalsy();
    expect(click(name)).toBe(true);
    expect(open).toHaveBeenCalledWith(node.attrs.asset, "plan.pdf");
  });
});

describe("pasting", () => {
  const clip = (files: File[], text = "", html = "") =>
    ({ files, getData: (t: string) => (t === "text/plain" ? text : t === "text/html" ? html : "") }) as unknown as DataTransfer;

  it("takes files when the clipboard holds no text or no rich text", () => {
    expect(clipboardFiles(clip([png()]))).toHaveLength(1);
    expect(clipboardFiles(clip([png()], "", '<img src="https://x/a.png">'))).toHaveLength(1);
    // Finder: the file plus its name as text.
    expect(clipboardFiles(clip([pdf()], "plan.pdf"))).toHaveLength(1);
    // A Word paragraph with a picture pastes as text.
    expect(clipboardFiles(clip([png()], "Some text", "<p>Some text</p>"))).toHaveLength(0);
    expect(clipboardFiles(clip([], "text"))).toHaveLength(0);
  });

  it("a pasted screenshot becomes an image block", async () => {
    const { editor } = await journal();
    cursorAfter(editor, "second");
    const event = { clipboardData: clip([png()]) } as unknown as ClipboardEvent;
    expect(editor.view.someProp("handlePaste", (f) => f(editor.view, event, Slice.empty))).toBe(true);
    await vi.waitFor(() => expect(files(editor)).toEqual(["image:shot.png"]));
    expect(editor.state.doc.firstChild!.child(1).childCount).toBe(2);
  });
});

describe("sizes", () => {
  it("reads like a file manager", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatSize(42 * 1024 * 1024)).toBe("42 MB");
    expect(formatSize(null)).toBe("");
  });
});
