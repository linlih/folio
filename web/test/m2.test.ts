// M2: index extraction, backlinks, search, block references, quick capture.
import { Slice } from "@tiptap/pm/model";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { createNotesApi } from "../src/api";
import { bodyLines, initCard } from "../src/docs/card";
import { DocHub } from "../src/docs/hub";
import { extractIndex } from "../src/docs/index";
import { _test as pasteTest } from "../src/editor/pasteIds";
import { memoryBackend, MEMORY_API_PEER, MEMORY_FRONTEND_PEER } from "../src/platform/memory";
import { snippet } from "../src/search/SearchPalette";
import { bind, device, outline, settle } from "./helpers";

/** A card in the memory backend whose body is written by a real editor. */
async function editorCard(backend: ReturnType<typeof memoryBackend>, title: string, html: string) {
  const id = await backend.createCard(title);
  const doc = device(5n);
  doc.import((await backend.docSnapshot(id))!);
  const v = doc.oplogVersion();
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  await backend.applyUpdate(id, "card", doc.export({ mode: "update", from: v }));
  return { id, editor, doc };
}

describe("index extraction", () => {
  it("matches the Rust extractor: blocks, links, refs, inline nodes inline", async () => {
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent(
      "<p data-bid='p1'>intro <span data-card-id='c2'>Card Two</span> end</p>" +
        "<ul><li data-bid='i1'><p>see <span data-ref='p1'></span></p><ul><li data-type='taskItem' data-bid='i2'><p>todo</p></li></ul></li></ul>",
    );
    await settle();
    const x = extractIndex(doc);
    expect(x.blocks.map((b) => [b.bid, b.parent, b.kind, b.text])).toEqual([
      ["p1", null, "paragraph", "intro Card Two end"],
      ["i1", null, "listItem", "see "],
      ["i2", "i1", "taskItem", "todo"],
    ]);
    expect(x.links).toEqual([["p1", "c2"]]);
    expect(x.refs).toEqual([["i1", "p1"]]);
    // Previews and the journal stream read the link as part of the line.
    expect(bodyLines(doc)[0]).toBe("intro Card Two end");
  });
});

describe("backlinks and search (memory backend, same rules as folio-store)", () => {
  it("finds links, block references and unlinked mentions; search ranks titles first", async () => {
    const backend = memoryBackend();
    const target = await editorCard(backend, "卡片写作", "<p data-bid='t1'>先写结论再写理由</p>");
    const linking = await editorCard(backend, "读书笔记", `<p data-bid='a1'>关于 <span data-card-id='${target.id}'>卡片写作</span></p>`);
    const referencing = await editorCard(backend, "周报", "<p data-bid='b1'>引用了 <span data-ref='t1'></span></p>");
    const mentioning = await editorCard(backend, "随想", "<p data-bid='c1'>今天想到卡片写作的好处</p>");

    const back = (await backend.backlinks(target.id)).map((b) => [b.cardId, b.bid, b.via]);
    expect(back).toContainEqual([linking.id, "a1", "link"]);
    expect(back).toContainEqual([referencing.id, "b1", "ref"]);
    expect(back).toHaveLength(2);
    expect((await backend.unlinkedReferences(target.id)).map((b) => b.cardId)).toEqual([mentioning.id]);

    const hits = await backend.search("卡片写作");
    expect(hits[0]).toMatchObject({ cardId: target.id, bid: null });
    expect(hits.some((h) => h.cardId === mentioning.id && h.bid === "c1")).toBe(true);
    expect((await backend.blockTexts(["t1"]))[0].text).toBe("先写结论再写理由");
  });

  it("the search snippet marks the match", () => {
    expect(snippet("一张卡片应该脱离上下文也能读懂", "上下文", 4)).toEqual({ before: "…应该脱离", match: "上下文", after: "也能读懂" });
  });
});

describe("block references", () => {
  it("copying with nothing selected copies the block's reference; pasting it back makes a reference", async () => {
    pasteTest.reset();
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent("<ul><li data-bid='0190f5a2-7c00-7000-8000-00000000abcd'><p>source</p></li><li><p></p></li></ul>");
    editor.commands.setTextSelection(4);
    const data = new Map<string, string>();
    const copy = { clipboardData: { setData: (k: string, v: string) => data.set(k, v) }, preventDefault() {} } as unknown as ClipboardEvent;
    editor.view.someProp("handleDOMEvents", (h) => void h.copy?.(editor.view, copy));
    const bid = editor.state.doc.firstChild!.firstChild!.attrs.bid as string;
    expect(data.get("text/plain")).toBe(`((${bid}))`);

    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    const paste = { clipboardData: { getData: (k: string) => (k === "text/plain" ? `((${bid}))` : "") } } as unknown as ClipboardEvent;
    editor.view.someProp("handlePaste", (f) => f(editor.view, paste, Slice.empty));
    let ref: string | null = null;
    editor.state.doc.descendants((n) => void (n.type.name === "blockRef" && (ref = n.attrs.bid as string)));
    expect(ref).toBe(bid);
  });

  it("copy-pasting a block keeps the reference's target", async () => {
    pasteTest.reset();
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent("<ul><li><p>a <span data-ref='target-bid'></span></p></li></ul>");
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    let out = slice;
    editor.view.someProp("transformPasted", (f) => void (out = f(out, editor.view, false)));
    const refs: string[] = [];
    out.content.descendants((n) => void (n.type.name === "blockRef" && refs.push(n.attrs.bid as string)));
    expect(refs).toEqual(["target-bid"]);
  });
});

describe("quick capture", () => {
  it("appends lines to today's journal; [ ] lines are tasks", async () => {
    const backend = memoryBackend();
    const api = createNotesApi(new DocHub(backend, MEMORY_FRONTEND_PEER), backend, MEMORY_API_PEER);
    await api.appendToJournal("2026-10-24", ["call mum", "[ ] pay rent", "- [x] done already"], "human");
    const doc = new LoroDoc();
    doc.import((await backend.docSnapshot("journal:2026-10-24"))!);
    const { editor } = await bind(doc);
    expect(outline(editor)).toEqual(["call mum", "[ ] pay rent", "[x] done already"]);
  });
});
