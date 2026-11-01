import { describe, expect, it } from "vitest";
import { embedContent } from "../src/editor/embed";
import { bind, device, settle } from "./helpers";

describe("embeds", () => {
  it("show a block with what is under it, a whole card, or nothing once the block is gone", async () => {
    const doc = device(1n);
    const { editor } = await bind(doc);
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { bid: "p1" }, content: [{ type: "text", text: "intro" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { bid: "i1" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "parent" }] },
                { type: "bulletList", content: [{ type: "listItem", attrs: { bid: "i2" }, content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] }] },
              ],
            },
          ],
        },
      ],
    });
    await settle();

    // An item keeps its bullet and brings its children.
    const item = embedContent(editor.schema, doc, "i1")!;
    expect(item.childCount).toBe(1);
    expect(item.firstChild!.type.name).toBe("bulletList");
    expect(item.firstChild!.textContent).toBe("parentchild");
    // A paragraph is itself.
    expect(embedContent(editor.schema, doc, "p1")!.firstChild!.type.name).toBe("paragraph");
    // The whole card.
    expect(embedContent(editor.schema, doc, null)!.childCount).toBe(2);
    // Deleted (or moved to another card): nothing here.
    expect(embedContent(editor.schema, doc, "gone")).toBeNull();
    editor.destroy();
  });

  it("is written as an inline node and read back", async () => {
    const doc = device(2n);
    const { editor } = await bind(doc);
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "blockEmbed", attrs: { bid: "b9", cardId: "c1" } }] }] });
    await settle();
    const json = editor.getJSON();
    expect(json.content?.[0].content?.[0]).toMatchObject({ type: "blockEmbed", attrs: { bid: "b9", cardId: "c1" } });
    // Copied as text, it reads like Logseq's embed.
    expect(editor.getText()).toBe("{{embed ((b9))}}");
    editor.destroy();
  });
});
