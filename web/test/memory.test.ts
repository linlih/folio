import { describe, expect, it } from "vitest";
import { memoryBackend } from "../src/platform/memory";

describe("memory backend", () => {
  it("lists cards newest first", async () => {
    let t = 1000;
    const b = memoryBackend(() => t++);
    const first = await b.createCard("first");
    const second = await b.createCard("second");
    const rows = await b.listCards();
    expect(rows.map((r) => r.id)).toEqual([second, first]);
    expect(await b.listCards(1)).toHaveLength(1);
  });

  it("keeps local settings as copies", async () => {
    const b = memoryBackend();
    const value = { a: 1 };
    await b.setLocalSetting("k", value);
    value.a = 2;
    expect(await b.getLocalSetting("k")).toEqual({ a: 1 });
    expect(await b.getLocalSetting("missing")).toBeNull();
  });

  it("has no snapshot for documents never written", async () => {
    expect(await memoryBackend().docSnapshot("journal:2026-01-01")).toBeNull();
  });
});
