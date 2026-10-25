import { describe, expect, it } from "vitest";
import { bodyLines, hasContent, initCard, readMeta, setTitle } from "../src/docs/card";
import { bind, device, settle } from "./helpers";

describe("card layout", () => {
  it("reads outlines the way the Rust indexer does", async () => {
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent("<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li><li><p>sibling</p></li></ul>");
    await settle();
    // Same expectation as folio-core's outline_text_keeps_nesting.
    expect(bodyLines(doc)).toEqual(["parent", "\tchild", "sibling"]);
  });

  it("an empty outline is not content; text is", async () => {
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent("<ul><li><p></p></li></ul>");
    await settle();
    expect(hasContent(doc)).toBe(false);
    editor.commands.insertContent("x");
    await settle();
    expect(hasContent(doc)).toBe(true);
  });

  it("journals default to outline mode; titles are metadata", () => {
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    setTitle(doc, "标题");
    const m = readMeta(doc);
    expect([m.kind, m.editorMode, m.title, m.source]).toEqual(["journal", "outline", "标题", "human"]);
  });
});
