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
});
