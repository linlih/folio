// Moves and concurrent edits (design/ARCHITECTURE.md §4.5 rule 4): the
// binding aligns block children by block id and moves containers in a
// movable list, so an edit made on another device to a moved block stays
// with that block.
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { moveBlock } from "../src/editor/outliner/ops";
import { bind, cursorAfter, device, outline, press, settle, sync, typeText } from "./helpers";

describe("move while another device edits the same block", () => {
  it("keeps the edit with the block that was moved", async () => {
    const aDoc = device(1n);
    initCard(aDoc, "journal", "", 1);
    const a = await bind(aDoc);
    a.editor.commands.setContent("<ul><li><p>A</p></li><li><p>B</p></li></ul>");
    await settle();
    const bDoc = device(2n);
    sync(aDoc, bDoc);
    const b = await bind(bDoc);

    cursorAfter(a.editor, "B");
    a.editor.view.dispatch(moveBlock(a.editor.state, -1)!);
    cursorAfter(b.editor, "B");
    typeText(b.editor, " edited offline");
    await settle();
    sync(aDoc, bDoc);
    await settle();

    expect(outline(a.editor)).toEqual(["B edited offline", "A"]);
  });
});

async function pair(html: string) {
  const aDoc = device(1n);
  initCard(aDoc, "journal", "", 1);
  const a = await bind(aDoc);
  a.editor.commands.setContent(html);
  await settle();
  const bDoc = device(2n);
  sync(aDoc, bDoc);
  const b = await bind(bDoc);
  const merge = async () => {
    await settle();
    sync(aDoc, bDoc);
    await settle();
    expect(outline(a.editor)).toEqual(outline(b.editor));
    return outline(a.editor);
  };
  return { a: a.editor, b: b.editor, merge };
}

const SIX = "<ul>" + ["one", "two", "three", "four", "five", "six"].map((t) => `<li><p>${t}</p></li>`).join("") + "</ul>";

describe("concurrent structure edits", () => {
  it("a long drag keeps the other device's edits on the right blocks", async () => {
    const { a, b, merge } = await pair(SIX);
    // Device A drags "one" to the end, past every sibling.
    for (let i = 0; i < 5; i++) {
      cursorAfter(a, "one");
      a.view.dispatch(moveBlock(a.state, 1)!);
    }
    cursorAfter(b, "one");
    typeText(b, "!");
    cursorAfter(b, "four");
    typeText(b, "?");
    expect(await merge()).toEqual(["two", "three", "four?", "five", "six", "one!"]);
  });

  it("an item turned into a task keeps an edit made at the same time", async () => {
    const { a, b, merge } = await pair("<ul><li><p>pay rent</p></li></ul>");
    cursorAfter(a, "pay rent");
    press(a, "Mod-Enter");
    cursorAfter(b, "pay rent");
    typeText(b, " today");
    expect(await merge()).toEqual(["[ ] pay rent today"]);
  });

  it("both devices moving the same block do not duplicate it", async () => {
    const { a, b, merge } = await pair(SIX);
    cursorAfter(a, "three");
    a.view.dispatch(moveBlock(a.state, -1)!);
    cursorAfter(b, "three");
    b.view.dispatch(moveBlock(b.state, 1)!);
    const lines = await merge();
    expect(lines.filter((l) => l === "three")).toHaveLength(1);
    expect([...lines].sort()).toEqual(["five", "four", "one", "six", "three", "two"]);
  });

  // Moving a block to another parent (indent, outdent, dragging into another
  // list) keeps its identity since layout 3 (blocks in a LoroTree, §4.5
  // rule 4): the edit made elsewhere at the same time stays with it.
  it("indenting keeps an edit made at the same time", async () => {
    const { a, b, merge } = await pair("<ul><li><p>parent</p></li><li><p>child</p></li></ul>");
    cursorAfter(a, "child");
    press(a, "Tab");
    cursorAfter(b, "child");
    typeText(b, " edited");
    expect(await merge()).toEqual(["parent", "  child edited"]);
  });
});

describe("concurrent moves across parents (layout 3, §4.5 rule 4)", () => {
  it("outdenting keeps an edit made at the same time", async () => {
    const { a, b, merge } = await pair("<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li></ul>");
    cursorAfter(a, "child");
    press(a, "Shift-Tab");
    cursorAfter(b, "child");
    typeText(b, " edited");
    expect(await merge()).toEqual(["parent", "child edited"]);
  });

  it("both devices indenting the same block do not duplicate it", async () => {
    const { a, b, merge } = await pair("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    cursorAfter(a, "two");
    press(a, "Tab");
    cursorAfter(b, "two");
    press(b, "Tab");
    expect(await merge()).toEqual(["one", "  two"]);
  });

  it("moving two blocks into each other at once keeps both, without a loop", async () => {
    const { a, b, merge } = await pair("<ul><li><p>x</p></li><li><p>y</p></li></ul>");
    // A puts y under x; B puts x under y (after moving it below y).
    cursorAfter(a, "y");
    press(a, "Tab");
    cursorAfter(b, "x");
    b.view.dispatch(moveBlock(b.state, 1)!);
    cursorAfter(b, "x");
    press(b, "Tab");
    const lines = await merge();
    expect(lines.map((l) => l.trim()).sort()).toEqual(["x", "y"]);
  });

  it("a block moved into another list keeps a text edit and a new child made elsewhere", async () => {
    const { a, b, merge } = await pair("<ul><li><p>inbox</p></li><li><p>task</p></li><li><p>project</p></li></ul>");
    // A drags "task" under "project".
    cursorAfter(a, "task");
    a.view.dispatch(moveBlock(a.state, 1)!);
    cursorAfter(a, "task");
    press(a, "Tab");
    // B edits "task" and adds a child under it.
    cursorAfter(b, "task");
    typeText(b, " due friday");
    press(b, "Enter");
    press(b, "Tab");
    typeText(b, "subtask");
    expect(await merge()).toEqual(["inbox", "project", "  task due friday", "    subtask"]);
  });
});

/** A 1000-block card is 50 times a 20-block one; a keystroke in it costs
 *  about 10 times as much today (2026-10, the same alone or with the whole
 *  suite running). Redrawing the whole card per keystroke would come close
 *  to 50. */
const RATIO_LIMIT = 25;

describe("typing speed with a large card", () => {
  // Keystroke time depends on how busy the machine is (the suite runs files
  // in parallel), so an absolute limit fails under load. What must not
  // happen is typing slowing down as the card grows: compare a 1000-block
  // card with a small one, typing into both in turn so load hits both alike.
  it("a keystroke in a 1000-block card costs about what it does in a small one", async () => {
    const list = (n: number) => "<ul>" + Array.from({ length: n }, (_, i) => `<li><p>line ${i}</p></li>`).join("") + "</ul>";
    const { a: large } = await pair(list(1000));
    const { a: small } = await pair(list(20));
    cursorAfter(large, "line 500");
    cursorAfter(small, "line 10");
    const time = (ed: typeof large) => {
      const t = performance.now();
      typeText(ed, "x");
      return performance.now() - t;
    };
    // Warm up (first keystrokes compile and allocate).
    for (let i = 0; i < 5; i++) time(large), time(small);
    const big: number[] = [];
    const tiny: number[] = [];
    for (let i = 0; i < 41; i++) {
      big.push(time(large));
      tiny.push(time(small));
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];
    const [mBig, mSmall] = [median(big), median(tiny)];
    console.log(`median keystroke: 1000 blocks ${mBig.toFixed(2)} ms, 20 blocks ${mSmall.toFixed(2)} ms, ratio ${(mBig / mSmall).toFixed(1)}`);
    expect(mBig / Math.max(mSmall, 0.05)).toBeLessThan(RATIO_LIMIT);
    // A ceiling for a disaster only; a frame is 16 ms on an idle machine.
    expect(mBig).toBeLessThan(100);
  });
});
