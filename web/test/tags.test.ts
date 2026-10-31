import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { DocHub } from "../src/docs/hub";
import { extractIndex } from "../src/docs/index";
import { memoryBackend, MEMORY_FRONTEND_PEER } from "../src/platform/memory";
import { bind, device, settle, typeText } from "./helpers";

async function card(html = "<p></p>") {
  const doc = device(1n);
  initCard(doc, "note", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  return { editor, doc };
}

const tags = (e: Editor) => {
  const out: string[] = [];
  e.state.doc.descendants((n) => void (n.type.name === "tag" && out.push(n.attrs.name as string)));
  return out;
};

describe("#tags", () => {
  it("#name and a space becomes a tag, in Chinese and English", async () => {
    const { editor } = await card();
    typeText(editor, "讨论 #会议 and #ToDo next");
    expect(tags(editor)).toEqual(["会议", "ToDo"]);
    expect(editor.state.doc.textContent).toBe("讨论  and  next");
  });

  it("leaves headings, words and code alone", async () => {
    const { editor } = await card();
    typeText(editor, "# Title");
    expect(editor.state.doc.firstChild!.type.name).toBe("heading");
    const second = await card("<p></p>");
    typeText(second.editor, "C# and a#b and #, too ");
    expect(tags(second.editor)).toEqual([]);
    const code = await card("<pre><code></code></pre>");
    typeText(code.editor, "x = #define ");
    expect(tags(code.editor)).toEqual([]);
  });

  it("is indexed with its block, and pages group any spelling", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const id = await backend.createCard("周会");
    const handle = await hub.open(id);
    const { editor } = await bind(handle.doc, handle.undo);
    editor.commands.setContent('<p>排期 <span data-tag="会议">#会议</span></p><p>记录 <span data-tag="Todo">#Todo</span> <span data-tag="todo">#todo</span></p>');
    await settle();
    const x = extractIndex(handle.doc);
    expect(x.tags.map(([, name]) => name)).toEqual(["会议", "Todo", "todo"]);
    expect(x.blocks.map((b) => b.text)).toEqual(["排期 #会议", "记录 #Todo #todo"]);
    editor.destroy();
    await handle.persistence.flush();

    const all = await backend.tags();
    expect(all.map((t) => [t.key, t.blocks, t.cards])).toEqual([
      ["会议", 1, 1],
      ["todo", 2, 1],
    ]);
    const todo = await backend.tagged("TODO");
    expect(todo.map((r) => r.text)).toEqual(["记录 #Todo #todo"]);
  });

  it("a tag alone on an item brings the items under it", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const id = await backend.createCard("日记");
    const handle = await hub.open(id);
    const { editor } = await bind(handle.doc, handle.undo);
    editor.commands.setContent(
      '<ul><li><p><span data-tag="想法">#想法</span></p><ul><li><p>第一条</p><ul><li><p>补充</p></li></ul></li><li><p>第二条</p></li></ul></li><li><p>别的事</p></li></ul>',
    );
    await settle();
    editor.destroy();
    await handle.persistence.flush();

    const [row, ...rest] = await backend.tagged("想法");
    expect(rest).toEqual([]);
    expect(row.children?.map((c) => [c.depth, c.text])).toEqual([
      [1, "第一条"],
      [2, "补充"],
      [1, "第二条"],
    ]);
  });
});
