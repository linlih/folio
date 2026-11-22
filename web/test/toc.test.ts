// The table of contents (design/toc.md): the heading being read, and
// jumping to a heading that is folded away or outside a focused item.
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { currentHeading } from "../src/card/tocState";
import { focusedBid, focusKey } from "../src/editor/outliner/focus";
import { flashBlock } from "../src/editor/reveal";
import { bind, device, settle } from "./helpers";

describe("currentHeading", () => {
  const boxes = [
    { bid: "a", top: -400, height: 30 },
    { bid: "b", top: 80, height: 30 },
    { bid: "c", top: 600, height: 30 },
  ];
  it("is the last heading above the reading line", () => {
    expect(currentHeading(boxes, 150, false)).toBe("b");
    expect(currentHeading(boxes, 50, false)).toBe("a");
  });
  it("is nothing above the first heading", () => {
    expect(currentHeading([{ bid: "a", top: 300, height: 30 }], 150, false)).toBeNull();
  });
  it("is the last shown heading at the end of the page", () => {
    expect(currentHeading(boxes, 150, true)).toBe("c");
  });
  it("skips headings hidden in a collapsed item, which lie at 0", () => {
    const hidden = [{ bid: "a", top: -400, height: 30 }, { bid: "x", top: 0, height: 0 }, { bid: "b", top: 500, height: 30 }];
    expect(currentHeading(hidden, 150, false)).toBe("a");
    expect(currentHeading([...hidden.slice(0, 2)], 150, true)).toBe("a");
  });
});

async function card(html: string) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return editor;
}

const bidOf = (editor: Awaited<ReturnType<typeof card>>, text: string) => {
  let bid: string | null = null;
  editor.state.doc.descendants((n) => {
    if (n.type.name === "heading" && n.textContent === text) bid = n.attrs.bid as string;
    return !bid;
  });
  return bid!;
};

const collapsedOf = (editor: Awaited<ReturnType<typeof card>>, text: string) => {
  let out: boolean | null = null;
  editor.state.doc.descendants((n) => {
    if (n.type.name === "listItem" && n.firstChild?.textContent === text) out = !!n.attrs.collapsed;
    return out === null;
  });
  return out;
};

describe("jumping to a heading", () => {
  // jsdom lays nothing out and has no scrolling.
  Element.prototype.scrollIntoView ??= () => {};

  it("unfolds the collapsed items around it", async () => {
    const editor = await card('<ul><li data-collapsed="true"><p>A</p><ul><li data-collapsed="true"><p>A1</p><ul><li><h2>Deep</h2></li></ul></li></ul></li><li><p>B</p></li></ul>');
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === "listItem" && n.childCount > 1) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "collapsed", true));
      return true;
    });
    expect(collapsedOf(editor, "A")).toBe(true);
    expect(collapsedOf(editor, "A1")).toBe(true);
    expect(flashBlock(editor.view, bidOf(editor, "Deep"), "start")).toBe(true);
    expect(collapsedOf(editor, "A")).toBe(false);
    expect(collapsedOf(editor, "A1")).toBe(false);
  });

  it("leaves a focused item that does not hold it, and keeps one that does", async () => {
    const editor = await card("<ul><li><p>A</p><ul><li><h2>In A</h2></li></ul></li><li><p>B</p><ul><li><h2>In B</h2></li></ul></li></ul>");
    let aBid = "";
    editor.state.doc.descendants((n) => {
      if (n.type.name === "listItem" && n.firstChild?.textContent === "A") aBid = n.attrs.bid as string;
      return !aBid;
    });
    editor.view.dispatch(editor.state.tr.setMeta(focusKey, { bid: aBid }));
    flashBlock(editor.view, bidOf(editor, "In A"), "start");
    expect(focusedBid(editor.state)).toBe(aBid);
    flashBlock(editor.view, bidOf(editor, "In B"), "start");
    expect(focusedBid(editor.state)).toBeNull();
  });
});
