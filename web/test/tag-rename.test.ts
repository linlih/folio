import { describe, expect, it } from "vitest";
import { startDocs } from "../src/app";
import { appendBlocks, appendTag, bodyLines, initCard, readProps, renameTagIn, setProp, TAG_RENAME_ORIGIN } from "../src/docs/card";
import { addField, addOption, readDatabase, setView } from "../src/docs/database";
import { journalId } from "../src/docs/ids";
import { workspaceDoc } from "../src/docs/topics";
import { backend } from "../src/platform";
import { cleanTagName, renameTag, validTagName } from "../src/tags/rename";
import { bind, device, settle } from "./helpers";

describe("renaming a tag", () => {
  it("renames it in every document and merges its fields into the tag it joins", async () => {
    const hub = await startDocs();
    const tagged = async (id: string, ...tags: string[]) => {
      const h = await hub.open(id);
      for (const t of tags) appendTag(h.doc, t);
      h.doc.commit();
      await h.persistence.flush();
      return h;
    };
    const book = await backend.createCard("一本书");
    const old = await backend.createCard("旧卡片");
    const other = await backend.createCard("别的");
    const target = await backend.createCard("已经是灵感");
    const day = journalId("2026-10-30");
    const dayDoc = await hub.open(day);
    initCard(dayDoc.doc, "journal", "", 1);
    // A day with nothing written is not kept: some words first.
    appendBlocks(dayDoc.doc, ["散步时想到的"], true, null);
    await tagged(book, "想法", "Idea");
    await tagged(old, "想法");
    await tagged(day, "想法");
    await tagged(other, "别的");
    await tagged(target, "灵感");
    await backend.trashCard(old);

    // #想法 has 状态 (select) and 作者; #灵感 already has its own 状态.
    const ws = (await workspaceDoc()).doc;
    const status = addField(ws, "想法", "状态", "select");
    const reading = addOption(ws, "想法", status, "在读")!;
    const author = addField(ws, "想法", "作者", "text");
    setView(ws, "想法", { mode: "board", groupBy: status });
    const theirStatus = addField(ws, "灵感", "状态", "select");
    const done = addOption(ws, "灵感", theirStatus, "读完")!;
    const h = await hub.open(book);
    setProp(h.doc, status, reading);
    setProp(h.doc, author, "某人");
    const t = await hub.open(target);
    setProp(t.doc, theirStatus, done);

    // Case does not matter: #Idea is the same tag as #idea, not #想法.
    expect(await renameTag("想法", "灵感")).toBe(3);
    expect(await backend.tagDocs("想法")).toEqual([]);
    expect(await backend.tagDocs("灵感")).toEqual([book, old, target, day].sort());
    expect(await backend.tagDocs("idea")).toEqual([book]);
    expect(await backend.tagDocs("别的")).toEqual([other]);

    const db = readDatabase(ws, "灵感");
    expect(db.fields.map((f) => f.name)).toEqual(["状态", "作者"]);
    const merged = db.fields[0];
    expect(merged.id).toBe(theirStatus);
    expect(merged.options.map((o) => o.name)).toEqual(["读完", "在读"]);
    // The value follows its choice by name; the moved field keeps its id.
    const props = readProps(h.doc);
    expect(props[theirStatus]).toBe(merged.options.find((o) => o.name === "在读")!.id);
    expect(props[author]).toBe("某人");
    expect(readProps(t.doc)[theirStatus]).toBe(done);
    // #灵感 had no view of its own: it takes #想法's, by the merged field.
    expect(db.view).toMatchObject({ mode: "board", groupBy: theirStatus });
    expect(readDatabase(ws, "想法").fields).toEqual([]);

    // Again (as after an interruption): nothing left to change.
    expect(await renameTag("想法", "灵感")).toBe(0);
    expect(readDatabase(ws, "灵感").fields.map((f) => f.name)).toEqual(["状态", "作者"]);

    // Only the case: same tag, same fields, the new spelling everywhere.
    expect(await renameTag("灵感", "LingGan")).toBe(4);
    expect(await renameTag("LingGan", "linggan")).toBe(4);
    expect(readDatabase(ws, "LINGGAN").fields.map((f) => f.name)).toEqual(["状态", "作者"]);
    expect((await backend.tags()).find((x) => x.key === "linggan")?.name).toBe("linggan");
  });

  it("leaves one tag on a line that had both", async () => {
    const doc = device(1n);
    initCard(doc, "note", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent(
      '<p>甲 <span data-tag="产品">#产品</span> <span data-tag="灵感">#灵感</span></p><p>乙 <span data-tag="产品">#产品</span> 和 <span data-tag="产品">#产品</span></p><p>丙 <span data-tag="Idea">#Idea</span></p>',
    );
    await settle();
    const bids = () => editor.getJSON().content!.map((p) => p.attrs!.bid);
    const before = bids();
    expect(renameTagIn(doc, "产品", "灵感")).toBe(3);
    doc.commit({ origin: TAG_RENAME_ORIGIN });
    await settle();
    expect(bodyLines(doc)).toEqual(["甲  #灵感", "乙 #灵感 和 ", "丙 #Idea"]);
    // The editor shows it, the blocks are the same blocks.
    expect(editor.getText({ blockSeparator: "|" })).toBe("甲  #灵感|乙 #灵感 和 |丙 #Idea");
    expect(bids()).toEqual(before);
    // Only the case: renamed in place, never dropped.
    expect(renameTagIn(doc, "idea", "IDEA")).toBe(1);
    expect(bodyLines(doc)[2]).toBe("丙 #IDEA");
    editor.destroy();
  });

  it("takes names as typed, and only what could be typed as a tag", () => {
    expect(cleanTagName("  #读书 ")).toBe("读书");
    expect(validTagName("读书")).toBe(true);
    expect(validTagName("read-later")).toBe(true);
    expect(validTagName("")).toBe(false);
    expect(validTagName("两 个")).toBe(false);
    expect(validTagName("a,b")).toBe(false);
    expect(validTagName("书，单")).toBe(false);
  });
});
