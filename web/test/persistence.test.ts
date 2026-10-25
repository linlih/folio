import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";
import { appendBlocks, initCard } from "../src/docs/card";
import { Persistence } from "../src/docs/persistence";
import { memoryBackend } from "../src/platform/memory";

function para(doc: LoroDoc, text: string) {
  // Same layout the editor binding writes (layout 3).
  appendBlocks(doc, [text], false, null);
  doc.commit();
}

describe("persistence", () => {
  it("batches edits and sends them once", async () => {
    vi.useFakeTimers();
    const backend = memoryBackend();
    const spy = vi.spyOn(backend, "applyUpdate");
    const doc = new LoroDoc();
    const p = new Persistence("journal:2026-10-23", doc, backend);
    initCard(doc, "journal", "", 1);
    para(doc, "a");
    para(doc, "b");
    expect(p.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(p.dirty).toBe(false);
    vi.useRealTimers();
  });

  it("does not create an untouched journal day", async () => {
    const backend = memoryBackend();
    const doc = new LoroDoc();
    initCard(doc, "journal", "", 1);
    const p = new Persistence("journal:2026-10-23", doc, backend, { born: false });
    initCard(doc, "journal", "", 2); // more metadata, still no content
    await p.flush();
    expect(await backend.docSnapshot("journal:2026-10-23")).toBeNull();
    para(doc, "now it exists");
    await p.flush();
    const saved = new LoroDoc();
    saved.import((await backend.docSnapshot("journal:2026-10-23"))!);
    // Everything since the start is written, metadata included.
    expect(saved.getMap("meta").get("kind")).toBe("journal");
  });

  it("a failed write is carried by the next one", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const doc = new LoroDoc();
    doc.import((await backend.docSnapshot(id))!);
    const errors: unknown[] = [];
    const p = new Persistence(id, doc, backend, { onError: (e) => errors.push(e) });
    const real = backend.applyUpdate;
    backend.applyUpdate = async () => {
      throw new Error("disk full");
    };
    para(doc, "first");
    await p.flush();
    expect(errors).toHaveLength(1);
    expect(p.dirty).toBe(true);
    backend.applyUpdate = real;
    para(doc, "second");
    await p.flush();
    expect(p.dirty).toBe(false);
    const rows = await backend.listCards();
    expect(rows[0].preview).toBe("first second");
    await p.dispose();
  });
});
