// Writes documents produced by the real editor for the Rust tests
// (crates/folio-core/tests/editor_fixtures.rs), so the indexer is checked
// against the binding's actual layout. Run with UPDATE_FIXTURES=1 to refresh.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { bind, device, settle } from "./helpers";

// Tests run from web/.
const OUT = resolve(process.cwd(), "../crates/folio-core/tests/fixtures");
const IO_OUT = resolve(process.cwd(), "../crates/folio-io/tests/fixtures");

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const item = (type: string, attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent => ({ type, attrs, content });

describe("fixtures for Rust", () => {
  it.runIf(process.env.UPDATE_FIXTURES)("journal written in the editor", async () => {
    const doc = device(7n);
    initCard(doc, "journal", "", 1_000);
    const { editor } = await bind(doc);
    editor.commands.setContent(
      "<ul><li><p>parent <strong>bold</strong></p><ul><li><p>child</p></li></ul></li><li><p>中文条目</p></li></ul>",
    );
    await settle();
    writeFileSync(resolve(OUT, "journal-from-editor.loro"), doc.export({ mode: "snapshot" }));
    expect(true).toBe(true);
  });

  // Markdown export (crates/folio-io/tests): every kind of content a card holds.
  it.runIf(process.env.UPDATE_FIXTURES)("card with every kind of content", async () => {
    const doc = device(8n);
    initCard(doc, "note", "Rich", 1_000);
    const { editor } = await bind(doc);
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [t("Plan")] },
        p(t("Some "), t("bold", { type: "bold" }), t(" and "), t("italic", { type: "italic" }), t(" text, "), t("code", { type: "code" }), t(", a "), t("link", { type: "link", attrs: { href: "https://example.com" } }), t(".")),
        p(t("See "), { type: "cardLink", attrs: { cardId: "card-2", title: "Other card" } }, t(" and "), { type: "blockRef", attrs: { bid: "blk-9" } }, t(", math "), { type: "inlineMath", attrs: { latex: "e^{i\\pi}" } }, t(".")),
        {
          type: "bulletList",
          content: [
            item("listItem", {}, p(t("parent")), { type: "bulletList", content: [item("listItem", {}, p(t("child")))] }),
            item("taskItem", { checked: false }, p(t("todo"))),
            item("taskItem", { checked: false, status: "doing", priority: "high", deadline: "2026-11-01" }, p(t("doing"))),
            item("taskItem", { checked: true }, p(t("done"))),
            item("taskItem", { checked: false, status: "canceled" }, p(t("canceled"))),
          ],
        },
        { type: "orderedList", content: [item("listItem", {}, p(t("first"))), item("listItem", {}, p(t("second")))] },
        { type: "blockquote", content: [p(t("quoted"))] },
        { type: "codeBlock", attrs: { language: "rust" }, content: [t("fn main() {}")] },
        p(t("中文段落 *not emphasis*")),
      ],
    });
    await settle();
    writeFileSync(resolve(IO_OUT, "card-rich.loro"), doc.export({ mode: "snapshot" }));
    expect(true).toBe(true);
  });
  // Tables (crates/folio-io and folio-core tests): at the top level, with a
  // link, marks, a `|` and two lines in a cell; and under an outline item.
  it.runIf(process.env.UPDATE_FIXTURES)("card with tables", async () => {
    const doc = device(9n);
    initCard(doc, "note", "Tables", 1_000);
    const { editor } = await bind(doc);
    const cell = (type: string, ...lines: JSONContent[]) => ({ type, content: lines });
    const row = (...cells: JSONContent[]) => ({ type: "tableRow", content: cells });
    editor.commands.setContent({
      type: "doc",
      content: [
        p(t("Before")),
        {
          type: "table",
          content: [
            row(cell("tableHeader", p(t("Name"))), cell("tableHeader", p(t("Note", { type: "bold" })))),
            row(cell("tableCell", p({ type: "cardLink", attrs: { cardId: "card-2", title: "Other card" } })), cell("tableCell", p(t("a|b")), p(t("second line")))),
            row(cell("tableCell", p(t("#x"))), cell("tableCell", p())),
          ],
        },
        { type: "bulletList", content: [item("listItem", {}, p(t("item")), { type: "table", content: [row(cell("tableHeader", p(t("k"))), cell("tableHeader", p(t("v")))), row(cell("tableCell", p(t("1"))), cell("tableCell", p(t("2"))))] })] },
      ],
    });
    await settle();
    writeFileSync(resolve(IO_OUT, "card-table.loro"), doc.export({ mode: "snapshot" }));
    expect(true).toBe(true);
  });
});
