import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { bodyLines, dayLines, initCard } from "../src/docs/card";
import { extractIndex } from "../src/docs/index";
import { bind, device, settle } from "./helpers";

describe("a journal day's lines", () => {
  it("keep card links, block references, tags and web links", async () => {
    const doc = device(1n);
    initCard(doc, "journal", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent(
      '<ul><li><p>读了 <span data-card-id="c1">一本书</span> 见<a href="https://example.com">官网</a> <span data-tag="读书">#读书</span></p>' +
        '<ul><li><p><span data-ref="b9"></span></p></li></ul></li></ul>',
    );
    await settle();
    expect(dayLines(doc)).toEqual([
      {
        parts: [
          { text: "读了 " },
          { text: "一本书", card: "c1" },
          { text: " 见" },
          { text: "官网", href: "https://example.com" },
          { text: " " },
          { text: "#读书", tag: "读书" },
        ],
      },
      { depth: 1, parts: [{ block: "b9" }] },
    ]);
    // A line of only a reference is empty text: left out there, kept here.
    expect(bodyLines(doc)).toEqual(["读了 一本书 见官网 #读书"]);
    editor.destroy();
  });

  it("are the lines the desktop app indexes", () => {
    // Written by the editor (fixtures.test.ts); Rust reads the same parts
    // (crates/folio-core/tests/editor_fixtures.rs).
    const doc = new LoroDoc();
    doc.import(readFileSync(resolve(process.cwd(), "../crates/folio-io/tests/fixtures/card-rich.loro")));
    const lines = dayLines(doc);
    expect(lines[1].parts).toContainEqual({ text: "link", href: "https://example.com" });
    expect(lines[1].parts[0]).toEqual({ text: "Some bold and italic text, code, a " });
    expect(lines[2].parts).toContainEqual({ text: "Other card", card: "card-2" });
    expect(lines[2].parts).toContainEqual({ block: "blk-9" });
    const text = lines.map((l) => "\t".repeat(l.depth ?? 0) + l.parts.map((p) => p.text ?? "").join(""));
    expect(text).toEqual(bodyLines(doc));
  });
  it("show a table a row per line, as the desktop app does", () => {
    // Same fixture and expectations as crates/folio-core/tests/editor_fixtures.rs.
    const doc = new LoroDoc();
    doc.import(readFileSync(resolve(process.cwd(), "../crates/folio-io/tests/fixtures/card-table.loro")));
    expect(dayLines(doc).map((l) => l.parts.map((p) => p.text ?? "").join(""))).toEqual(["Before", "Name | Note", "Other card | a|b second line", "#x | ", "item", "k | v", "1 | 2"]);
    const x = extractIndex(doc);
    const tables = x.blocks.filter((b) => b.kind === "table");
    expect(tables.map((b) => b.text)).toEqual(["Name | Note\nOther card | a|b second line\n#x | ", "k | v\n1 | 2"]);
    expect(tables[1].parent).toBe(x.blocks.find((b) => b.text === "item")!.bid);
    expect(x.links).toEqual([[tables[0].bid, "card-2"]]);
  });
});
