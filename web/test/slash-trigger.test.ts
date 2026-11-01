// When "/" opens the command menu (design/outliner.md "斜杠命令").
import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { bind, device, settle, typeText } from "./helpers";

/** Whether the slash menu is open in `e`. */
const slashOpen = (e: Editor) => {
  const plugin = e.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith("slashMenu$"))!;
  return Boolean((plugin.getState(e.state) as { active: boolean }).active);
};

async function typed(text: string) {
  const doc = device(1n);
  initCard(doc, "journal", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent("<ul><li><p></p></li></ul>");
  editor.commands.focus("end");
  typeText(editor, text);
  await settle();
  return editor;
}

describe("the slash menu", () => {
  it.each(["/", "记下 /", "记下/", "今天。/", "メモ/", "메모/", "（备注）/"])("opens after %j", async (text) => {
    expect(slashOpen(await typed(text))).toBe(true);
  });

  it.each(["a/", "and/or", "1/2", "http://", "a.b/"])("stays shut in %j", async (text) => {
    expect(slashOpen(await typed(text))).toBe(false);
  });
});
