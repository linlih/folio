import { Editor } from "@tiptap/core";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { createNotesApi } from "../src/api";
import { bodyLines, readMeta } from "../src/docs/card";
import { DocHub } from "../src/docs/hub";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";
import { memoryBackend, MEMORY_API_PEER, MEMORY_FRONTEND_PEER } from "../src/platform/memory";
import { settle } from "./helpers";

function setup() {
  const backend = memoryBackend();
  const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
  return { backend, hub, api: createNotesApi(hub, backend, MEMORY_API_PEER) };
}

describe("notes API", () => {
  it("creates a card with provenance", async () => {
    const { backend, api } = setup();
    const id = await api.createCard({ title: "Summary", lines: ["one", "two"], source: "ai:test-model" });
    const card = await api.readCard(id);
    expect([card.title, card.source, card.lines]).toEqual(["Summary", "ai:test-model", ["one", "two"]]);
    expect((await backend.listCards())[0].id).toBe(id);
  });

  it("appends to a journal day whose editor is open, and the editor shows it", async () => {
    const { backend, hub, api } = setup();
    const handle = await hub.open("journal:2026-10-24");
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [...baseExtensions(isRemoteTx), LoroBinding(handle.doc, handle.undo)],
    });
    await settle();
    editor.commands.setContent("<ul><li><p>typed by me</p></li></ul>");
    await settle();

    await api.appendToJournal("2026-10-24", ["added by AI"], "ai:test-model");
    await settle();

    expect(editor.getText()).toContain("added by AI");
    // The block says who wrote it.
    const sources: (string | null)[] = [];
    editor.state.doc.descendants((n) => void (n.type.name === "paragraph" && sources.push(n.attrs.source as string | null)));
    expect(sources).toEqual([null, "ai:test-model"]);
    // The host has the whole day, metadata included, though the editor's own
    // edits were not saved yet.
    const saved = new LoroDoc();
    saved.import((await backend.docSnapshot("journal:2026-10-24"))!);
    expect(readMeta(saved).kind).toBe("journal");
    expect(bodyLines(saved)).toContain("added by AI");
    editor.destroy();
    await hub.release(handle.id);
  });

  it("creates a journal day that did not exist", async () => {
    const { backend, api } = setup();
    await api.appendToJournal("2026-01-02", ["note"], "human");
    const days = await backend.journalDays("2026-01-01", "2026-01-31");
    expect(days.map((d) => [d.date, d.text])).toEqual([["2026-01-02", "note"]]);
  });
});
