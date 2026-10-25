import { afterEach, describe, expect, it, vi } from "vitest";
import { initCard } from "../src/docs/card";
import { bind, caret, device, press, settle, typeText } from "./helpers";

describe("selection bookkeeping while typing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds the Loro node of every line typed (no 'Cannot find the loroNode')", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = device(1n);
    initCard(doc, "note", "卡", 1);
    const { editor } = await bind(doc);
    editor.commands.focus("end");
    typeText(editor, "低成本");
    press(editor, "Enter");
    typeText(editor, "分散");
    press(editor, "Enter");
    await settle();
    editor.commands.focus("end");
    typeText(editor, "在卡片里写的一行");
    press(editor, "Enter");
    typeText(editor, "再一行");
    await settle();
    const messages = errors.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes("loroNode"))).toEqual([]);
  });

  it("undoing a new line puts the cursor back where it was", async () => {
    const doc = device(2n);
    initCard(doc, "note", "卡", 1);
    const { editor, undo } = await bind(doc);
    editor.commands.focus("end");
    typeText(editor, "第一行");
    await settle();
    press(editor, "Enter");
    typeText(editor, "第二行");
    await settle();
    // Each commit is a step here (merge interval 0): undo back to one line.
    for (let i = 0; i < 10 && editor.state.doc.childCount > 1; i++) {
      undo.undo();
      await settle();
    }
    expect(editor.state.doc.textContent).toBe("第一行");
    expect(caret(editor)).toContain("第一行|");
  });
});
