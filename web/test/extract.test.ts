// M1a acceptance: after extracting a block into a card, one undo brings
// everything back (design/ARCHITECTURE.md §0.2, §5.1, §8).
import { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { docs, startDocs } from "../src/app";
import { bodyLines, readMeta } from "../src/docs/card";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { extractExtension, extractToCard } from "../src/editor/extract";
import { backend } from "../src/platform";
import { undo as loroUndo, redo as loroRedo } from "../src/vendor/loro-prosemirror";
import { settle } from "./helpers";

beforeAll(async () => {
  await startDocs();
});

async function openJournal(date: string) {
  const handle = await docs().open(`journal:${date}`);
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...baseExtensions(isRemoteTx), LoroBinding(handle.doc, handle.undo), extractExtension(handle)],
  });
  await settle();
  return { handle, editor };
}

const cursorIn = (editor: Editor, text: string) => {
  let at = -1;
  editor.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(text)) at = pos + n.text.indexOf(text) + text.length;
  });
  editor.commands.setTextSelection(at);
};

describe("extract to card", () => {
  it("moves the item and its children into a new card, and one undo reverts it", async () => {
    const { handle, editor } = await openJournal("2026-10-20");
    editor.commands.setContent(
      "<ul><li><p>卡片要独立可读</p><ul><li><p>先写结论</p></li><li><p>再写理由</p></li></ul></li><li><p>other</p></li></ul>",
    );
    await settle();
    const before = bodyLines(handle.doc);
    cursorIn(editor, "独立");

    const cardId = (await extractToCard(editor, handle))!;
    await settle();

    // The card has the title and the children, ids kept.
    const snap = (await backend.docSnapshot(cardId))!;
    const { LoroDoc } = await import("loro-crdt");
    const card = new LoroDoc();
    card.import(snap);
    expect(readMeta(card).title).toBe("卡片要独立可读");
    expect(bodyLines(card)).toEqual(["先写结论", "再写理由"]);
    // The journal keeps a link where the item was; the children left.
    expect(editor.getText()).not.toContain("先写结论");
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", (n) => (n.type.name === "cardLink" ? `[${n.attrs.title}]` : ""))).toContain("[卡片要独立可读]");
    expect((await backend.listCards()).map((c) => c.id)).toContain(cardId);

    // One undo: the journal is as before and the card is in the trash.
    loroUndo(editor.state, editor.view.dispatch, editor.view);
    await settle();
    expect(bodyLines(handle.doc)).toEqual(before);
    expect((await backend.listCards()).map((c) => c.id)).not.toContain(cardId);
    expect((await backend.listTrash()).map((c) => c.id)).toContain(cardId);

    // Redo brings both back.
    loroRedo(editor.state, editor.view.dispatch, editor.view);
    await settle();
    expect(editor.getText()).not.toContain("先写结论");
    expect((await backend.listCards()).map((c) => c.id)).toContain(cardId);
    editor.destroy();
    await docs().release(handle.id);
  });

  it("typing right before extracting is not undone with it", async () => {
    const { handle, editor } = await openJournal("2026-10-21");
    editor.commands.setContent("<ul><li><p>idea</p></li></ul>");
    await settle();
    handle.undo.clear();
    cursorIn(editor, "idea");
    editor.commands.insertContent(" more");
    await extractToCard(editor, handle);
    await settle();
    loroUndo(editor.state, editor.view.dispatch, editor.view);
    await settle();
    // Only the extraction is undone; the typed text stays.
    expect(bodyLines(handle.doc)).toEqual(["idea more"]);
    editor.destroy();
    await docs().release(handle.id);
  });
});
