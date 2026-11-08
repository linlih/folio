import { Schema } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { useChatLive, type PendingWrite } from "../src/ai/chat";
import { diffText, inlineText, mostlyRewritten } from "../src/ai/diff";
import { parseInline } from "../src/ai/markdown";
import { changesFor, decideAll } from "../src/ai/review";
import { posAt, textblockOf } from "../src/editor/aiReview";

const apply = (ops: ReturnType<typeof diffText>, side: "-" | "+") => ops.filter((o) => o.t === "=" || o.t === side).map((o) => o.s).join("");

describe("diffText", () => {
  it("rebuilds both texts, Chinese by character and English by word", () => {
    const pairs: [string, string][] = [
      ["下次可以试试先让每个人推荐一本，然后投票决定。", "下次可以先让每人推荐一本，再投票决定；票数相同时，选篇幅更短的那本。"],
      ["The quick brown fox jumps.", "The quick red fox leaps."],
      ["", "全新的一段"],
      ["整段删掉", ""],
    ];
    for (const [a, b] of pairs) {
      const ops = diffText(a, b);
      expect(apply(ops, "-")).toBe(a);
      expect(apply(ops, "+")).toBe(b);
    }
    expect(diffText("The quick brown fox", "The quick red fox")).toEqual([
      { t: "=", s: "The quick " },
      { t: "-", s: "brown" },
      { t: "+", s: "red" },
      { t: "=", s: " fox" },
    ]);
  });

  it("folds a lone shared character into the changes around it", () => {
    const ops = diffText("选书的时候应该考虑大家的时间", "选书时看三点：篇幅读得完");
    // No "=" run of one or two characters between two changes.
    ops.forEach((o, i) => {
      if (o.t === "=" && i > 0 && i < ops.length - 1) expect([...o.s].length).toBeGreaterThan(2);
    });
  });

  it("is plain equality for the same text", () => {
    expect(diffText("一样", "一样")).toEqual([{ t: "=", s: "一样" }]);
  });

  it("tells a rewrite from an edit", () => {
    expect(mostlyRewritten(diffText("The quick brown fox jumps.", "The quick red fox jumps."))).toBe(false);
    expect(mostlyRewritten(diffText("选书的时候应该考虑大家的时间", "下周三晚上八点在图书馆见"))).toBe(true);
  });

  it("reads inline Markdown as its text", () => {
    expect(inlineText(parseInline("先看 **篇幅**，再看 `难度` 和 [讨论](https://x.y)"))).toBe("先看 篇幅，再看 难度 和 讨论");
  });
});

describe("positions in a block", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*", attrs: { bid: { default: null } } },
      list: { group: "block", content: "item+" },
      item: { content: "paragraph", attrs: { bid: { default: null } } },
      text: { group: "inline" },
      mention: { group: "inline", inline: true, atom: true },
    },
  });
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { bid: "p1" }, [schema.text("前面"), schema.node("mention"), schema.text("后面")]),
    schema.node("list", null, [schema.node("item", { bid: "i1" }, [schema.node("paragraph", null, [schema.text("一项")])])]),
  ]);

  it("finds a block's text, and a list item's first line", () => {
    expect(textblockOf(doc, "p1")?.node.textContent).toBe("前面后面");
    expect(textblockOf(doc, "i1")?.node.textContent).toBe("一项");
    expect(textblockOf(doc, "nope")).toBeNull();
  });

  it("maps character offsets past inline nodes that have no text", () => {
    const block = textblockOf(doc, "p1")!;
    const text = (from: number, to: number) => doc.textBetween(posAt(block, from), posAt(block, to));
    expect(text(0, 2)).toBe("前面");
    expect(text(2, 4)).toBe("后面");
    expect(text(1, 3)).toBe("面后");
  });
});

describe("a card's proposed changes", () => {
  afterEach(() => useChatLive.setState({ live: {}, errors: {} }));

  const pending = (id: string, name: string, cardId: string | null, input: Record<string, unknown> = {}): PendingWrite => ({
    part: { type: "tool", id, name, input } as PendingWrite["part"],
    proposal: { target: "卡片", cardId, before: "旧", after: "新" },
  });

  it("are the changes drawn in that card, from every conversation", () => {
    useChatLive.setState({
      live: {
        a: { text: "", tools: [], turn: "t", stopping: false, pending: [pending("1", "update_block", "c1", { block_id: "b1" }), pending("2", "create_card", null), pending("3", "set_card_topic", "c1")] },
        b: { text: "", tools: [], turn: "t", stopping: false, pending: [pending("4", "append_to_card", "c1"), pending("5", "update_block", "c2", { block_id: "b9" })] },
      },
      errors: {},
    });
    const changes = changesFor(useChatLive.getState().live, "c1");
    expect(changes.map((c) => [c.chatId, c.id, c.name, c.bid])).toEqual([
      ["a", "1", "update_block", "b1"],
      ["b", "4", "append_to_card", null],
    ]);
  });

  it("are answered together with accept all", () => {
    useChatLive.setState({ live: { a: { text: "", tools: [], turn: "t", stopping: false, pending: [pending("1", "update_block", "c1", { block_id: "b1" }), pending("2", "rename_card", "c1")] } }, errors: {} });
    decideAll(changesFor(useChatLive.getState().live, "c1"), true);
    expect(useChatLive.getState().live.a.pending!.map((p) => p.allowed)).toEqual([true, true]);
  });
});
