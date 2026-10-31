import { LoroDoc, UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { appendBlocks, bodyLines, initCard, readMeta } from "../src/docs/card";
import { restoreTo, versionDoc, versions } from "../src/docs/history";
import type { DocHandle } from "../src/docs/hub";
import { undo } from "../src/vendor/loro-prosemirror";
import { bind, device, settle, sync } from "./helpers";

const MIN = 60;
const T0 = 1_790_000_000; // seconds, as Loro dates changes

describe("a card's history", () => {
  it("lists sittings, shows each as it was, and restores one as an undoable edit", async () => {
    const doc = device(1n);
    initCard(doc, "note", "卡片", 1);
    doc.commit();
    // Dated from here (the test's clock, not the machine's).
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(0);
    const write = (line: string, at: number) => {
      appendBlocks(doc, [line], false, null);
      doc.commit({ timestamp: at });
    };
    write("第一版", T0 + 1 * MIN);
    write("补一句", T0 + 3 * MIN);
    write("第二版的一段", T0 + 60 * MIN);
    // Another device's edit, synced in later.
    const other = device(2n);
    other.setRecordTimestamp(true);
    sync(doc, other);
    other.getMap("meta").set("title", "改过的标题");
    other.commit({ timestamp: T0 + 120 * MIN });
    sync(doc, other);
    await settle();

    const list = versions(doc);
    // Newest first: the other device's title, the second version, the
    // first sitting (made, then written twice within ten minutes).
    expect(list.map((v) => [v.at, v.here])).toEqual([
      [(T0 + 120 * MIN) * 1000, false],
      [(T0 + 60 * MIN) * 1000, true],
      [(T0 + 3 * MIN) * 1000, true],
    ]);
    const first = versionDoc(doc, list[2].frontiers);
    expect(bodyLines(first)).toEqual(["第一版", "补一句"]);
    expect(readMeta(first).title).toBe("卡片");
    expect(bodyLines(doc)).toEqual(["第一版", "补一句", "第二版的一段"]);

    const history = new UndoManager(doc, { mergeInterval: 0 });
    const { editor } = await bind(doc, history);
    restoreTo({ doc, undo: history } as unknown as DocHandle, list[2].frontiers);
    await settle();
    expect(editor.state.doc.textContent).toBe("第一版补一句");
    expect(readMeta(doc).title).toBe("卡片");
    // The restore is a version of its own, and Mod+Z takes it back.
    expect(versions(doc)).toHaveLength(4);
    editor.view.focus();
    expect(undo(editor.state, editor.view.dispatch, editor.view)).toBe(true);
    await settle();
    expect(editor.state.doc.textContent).toBe("第一版补一句第二版的一段");
    expect(readMeta(doc).title).toBe("改过的标题");
    editor.destroy();
  });

  it("reaches back to the first edit after the document was compacted, dated or not", () => {
    const doc = device(1n);
    initCard(doc, "note", "旧卡片", 1);
    doc.getMap("meta").set("title", "从前没有记时间");
    doc.commit();
    doc.setRecordTimestamp(true);
    doc.getMap("meta").set("title", "现在记了");
    doc.commit({ timestamp: T0 });

    // Compaction keeps a full snapshot (§5.3): the history comes along.
    const loaded = new LoroDoc();
    loaded.import(doc.export({ mode: "snapshot" }));
    const list = versions(loaded);
    expect(list).toHaveLength(1);
    expect(list[0].at).toBe(T0 * 1000);
    // Undated edits join the sitting after them; their states are still
    // there to read.
    expect(readMeta(loaded.forkAt([{ peer: "1", counter: 0 }])).title).toBe("");
  });
});
