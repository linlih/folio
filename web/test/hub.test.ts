import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { DocHub } from "../src/docs/hub";
import { memoryBackend, MEMORY_FRONTEND_PEER } from "../src/platform/memory";

describe("DocHub", () => {
  it("shares one replica per document and closes it after the last release", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const a = await hub.open(id);
    const b = await hub.open(id);
    expect(a).toBe(b);
    expect(a.doc.peerIdStr).toBe(MEMORY_FRONTEND_PEER);
    await hub.release(id);
    expect(hub.isOpen(id)).toBe(true);
    await hub.release(id);
    expect(hub.isOpen(id)).toBe(false);
  });

  it("keeps a released document open for the grace period, so a reopen reuses it", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER, console.error, Date.now, 30);
    const a = await hub.open(id);
    await hub.release(id);
    expect(hub.isOpen(id)).toBe(true);
    // Moved to the other pane: opened again within the grace period.
    expect(await hub.open(id)).toBe(a);
    await hub.release(id);
    await new Promise((r) => setTimeout(r, 60));
    expect(hub.isOpen(id)).toBe(false);
  });

  it("a document opened again while its last write is under way continues from it, not from the host's older copy", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const errors: unknown[] = [];
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER, (e) => errors.push(e));
    const a = await hub.open(id);
    const text = a.doc.getText("body");
    text.insert(0, "hello!");
    a.doc.commit();
    await a.persistence.flush();
    text.delete(4, 2);
    a.doc.commit();
    // Closed (the last write not yet on the host) and at once opened again.
    const closing = hub.release(id);
    const b = await hub.open(id);
    expect(b.doc.getText("body").toString()).toBe("hell");
    b.doc.getText("body").insert(4, " world");
    b.doc.commit();
    await closing;
    await b.persistence.flush();
    expect(errors.map(String)).toEqual([]);
    const host = new LoroDoc();
    host.import((await backend.docSnapshot(id))!);
    expect(host.getText("body").toString()).toBe("hell world");
    await hub.release(id);
  });

  it("takes over what a closed replica could not write, and that replica stops trying", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    let fail = false;
    let writes = 0;
    const flaky = {
      ...backend,
      applyUpdate: async (...args: Parameters<typeof backend.applyUpdate>) => {
        writes++;
        if (fail) throw new Error("disk full");
        return backend.applyUpdate(...args);
      },
    };
    const errors: unknown[] = [];
    const hub = new DocHub(flaky, MEMORY_FRONTEND_PEER, (e) => errors.push(e));
    const a = await hub.open(id);
    a.doc.getText("body").insert(0, "unsaved");
    a.doc.commit();
    fail = true;
    await hub.release(id);
    expect(errors).toHaveLength(1);
    fail = false;
    const b = await hub.open(id);
    expect(b.doc.getText("body").toString()).toBe("unsaved");
    b.doc.getText("body").insert(7, "!");
    b.doc.commit();
    await b.persistence.flush();
    const host = new LoroDoc();
    host.import((await backend.docSnapshot(id))!);
    expect(host.getText("body").toString()).toBe("unsaved!");
    // The first replica's retry never comes.
    const before = writes;
    await new Promise((r) => setTimeout(r, 2100));
    expect(writes).toBe(before);
    await hub.release(id);
  });

  it("starts an unwritten journal day but refuses unknown cards", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const day = await hub.open("journal:2026-10-24");
    await hub.release(day.id);
    // Opened and closed without content: nothing was written.
    expect(await backend.docSnapshot("journal:2026-10-24")).toBeNull();
    await expect(hub.open("0190f5a2-0000-7000-8000-000000000000")).rejects.toThrow();
    // A failed open is not cached.
    expect(hub.isOpen("0190f5a2-0000-7000-8000-000000000000")).toBe(false);
  });

  it("takes in another device's change to an open document without writing it back", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const open = await hub.open(id);
    // Another device's edit, as sync applies it on the host.
    const other = new LoroDoc();
    other.setPeerId(77n);
    other.import((await backend.docSnapshot(id))!);
    const before = other.oplogVersion();
    other.getMap("synced").set("from", "elsewhere");
    other.commit();
    await backend.applyUpdate(id, "card", other.export({ mode: "update", from: before }));
    await hub.refresh([id, "journal:2026-01-01"]);
    expect(open.doc.getMap("synced").get("from")).toBe("elsewhere");
    expect(open.persistence.dirty).toBe(false);
    await hub.release(id);
  });

  it("holds another device's change while an input method composes", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const open = await hub.open(id);
    const other = new LoroDoc();
    other.setPeerId(77n);
    other.import((await backend.docSnapshot(id))!);
    const before = other.oplogVersion();
    other.getMap("synced").set("from", "elsewhere");
    other.commit();
    await backend.applyUpdate(id, "card", other.export({ mode: "update", from: before }));
    document.dispatchEvent(new CompositionEvent("compositionstart"));
    let done = false;
    const refreshed = hub.refresh([id]).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(open.doc.getMap("synced").get("from")).toBeUndefined();
    document.dispatchEvent(new CompositionEvent("compositionend", { data: "中文" }));
    await refreshed;
    expect(open.doc.getMap("synced").get("from")).toBe("elsewhere");
    await hub.release(id);
  });

  it("holds it too when the next word starts while the host's copy is being read", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("t");
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const open = await hub.open(id);
    const other = new LoroDoc();
    other.setPeerId(78n);
    other.import((await backend.docSnapshot(id))!);
    const before = other.oplogVersion();
    other.getMap("synced").set("from", "elsewhere");
    other.commit();
    await backend.applyUpdate(id, "card", other.export({ mode: "update", from: before }));
    // Reading the host's copy takes a while (IPC); a word starts meanwhile.
    const read = backend.docSnapshot.bind(backend);
    let arrive!: () => void;
    const slow = new Promise<void>((r) => (arrive = r));
    backend.docSnapshot = async (doc: string) => {
      const snapshot = await read(doc);
      await slow;
      return snapshot;
    };
    let done = false;
    const refreshed = hub.refresh([id]).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new CompositionEvent("compositionstart"));
    arrive();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(open.doc.getMap("synced").get("from")).toBeUndefined();
    document.dispatchEvent(new CompositionEvent("compositionend", { data: "中文" }));
    await refreshed;
    expect(open.doc.getMap("synced").get("from")).toBe("elsewhere");
    await hub.release(id);
  });
});
