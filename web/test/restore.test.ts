import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import type { DocHandle } from "../src/docs/hub";
import { restoreVersion } from "../src/docs/restore";
import { undo } from "../src/vendor/loro-prosemirror";
import { bind, device, settle } from "./helpers";

describe("restoring a card from a backup", () => {
  it("goes back to the backup's version in the open editor, as one undoable edit", async () => {
    const doc = device(1n);
    initCard(doc, "note", "卡片", 1);
    const history = new UndoManager(doc, { mergeInterval: 0 });
    const { editor } = await bind(doc, history);
    editor.commands.setContent("<p>第一版</p>");
    await settle();
    const backup = doc.export({ mode: "snapshot" });
    editor.commands.setContent("<p>第二版</p><p>新增的一段</p>");
    await settle();
    expect(editor.state.doc.textContent).toBe("第二版新增的一段");

    restoreVersion({ doc, undo: history } as unknown as DocHandle, backup);
    await settle();
    expect(editor.state.doc.textContent).toBe("第一版");

    editor.view.focus();
    expect(undo(editor.state, editor.view.dispatch, editor.view)).toBe(true);
    await settle();
    expect(editor.state.doc.textContent).toBe("第二版新增的一段");
    editor.destroy();
  });
});
