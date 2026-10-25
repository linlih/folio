import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { bodyLines } from "../src/docs/card";
import { memoryBackend } from "../src/platform/memory";
import { bind, settle } from "./helpers";

describe("a new card from the host", () => {
  it("opens with an empty body and can be typed into", async () => {
    const backend = memoryBackend();
    const id = await backend.createCard("");
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    doc.import((await backend.docSnapshot(id))!);
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    const { editor } = await bind(doc);
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    editor.commands.insertContent("hello");
    await settle();
    expect(bodyLines(doc)).toEqual(["hello"]);
  });
});
