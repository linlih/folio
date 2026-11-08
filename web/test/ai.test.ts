// The assistant (design/ai.md): its conversations as synced documents, the
// Markdown its answers are read and kept in, and a message answered over
// several turns with tool calls.
import { LoroDoc, LoroMap } from "loro-crdt";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { docs, notes, startDocs } from "../src/app";
import { decide, editLast, openChat, regenerate, send, stop, useChatLive, newChat } from "../src/ai/chat";
import { effortLevels, turnEffort } from "../src/ai/effort";
import { mentionAt } from "../src/ai/Mention";
import { chatGroup } from "../src/ai/ChatPanel";
import { linkTarget, parseMarkdown, toHtml } from "../src/ai/markdown";
import { saveProvider, setWriteMode, useAiSettings } from "../src/ai/settings";
import { ChangedSince, undo } from "../src/ai/writes";
import { withHeadlessEditor } from "../src/editor/headless";
import type { AiTurnRequest, AiEvent, AiReply } from "../src/ai/types";
import { appendMessage, chatDeleted, createChat, deleteChat, readChats, readMessages, touchChat } from "../src/docs/chat";
import { readBoards } from "../src/docs/workspace";
import { backend } from "../src/platform";
import { memoryBackend } from "../src/platform/memory";
import { device, sync } from "./helpers";

type Fake = (request: AiTurnRequest, onEvent: (e: AiEvent) => void) => Promise<AiReply>;
const g = globalThis as { __folioFakeAi?: Fake };

describe("conversations in the workspace document", () => {
  it("are listed most recently used first, and deleting one takes it off every device", () => {
    const a = device(1n);
    const b = device(2n);
    const first = createChat(a, "第一个", 10);
    const second = createChat(a, "第二个", 20);
    touchChat(a, first, 30);
    sync(a, b);
    expect(readChats(b).map((c) => c.title)).toEqual(["第一个", "第二个"]);
    deleteChat(b, second, 40);
    sync(a, b);
    expect(readChats(a).map((c) => c.id)).toEqual([first]);
    expect(chatDeleted(a, second)).toBe(true);
    // Not whiteboards, though their documents are stored as such.
    expect(readBoards(a)).toEqual([]);
  });

  it("keep messages from both devices, and skip one that cannot be read", () => {
    const a = new LoroDoc();
    a.setPeerId(1n);
    appendMessage(a, { role: "user", text: "你好" }, 1);
    appendMessage(a, { role: "assistant", parts: [{ type: "text", text: "你好！" }] }, 2, "claude-opus-5-5");
    a.getList("messages").insertContainer(2, new LoroMap()).set("data", "{not json");
    a.commit();
    const b = new LoroDoc();
    b.import(a.export({ mode: "snapshot" }));
    const read = readMessages(b);
    expect(read.map((m) => m.message.role)).toEqual(["user", "assistant"]);
    expect(read[1].model).toBe("claude-opus-5-5");
  });
});

describe("answers in Markdown", () => {
  it("reads links into notes and keeps them when saved", () => {
    expect(linkTarget("folio:card/c1")).toEqual({ kind: "card", cardId: "c1", bid: null });
    expect(linkTarget("folio:block/c1/b2")).toEqual({ kind: "card", cardId: "c1", bid: "b2" });
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    const html = toHtml(parseMarkdown("## 结论\n\n见 [Rust 笔记](folio:card/c1) 和 [这句](folio:block/c1/b2)。\n\n- [ ] 复习\n- [x] 读完"));
    expect(html).toContain("<h2>结论</h2>");
    expect(html).toContain('<span data-card-id="c1">Rust 笔记</span>');
    expect(html).toContain('<span data-ref="b2" data-card-hint="c1"></span>');
    expect(html).toContain('data-checked="true"');
  });

  it("never lets an answer write markup", () => {
    const html = toHtml(parseMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) `<b>`'));
    expect(html).not.toMatch(/<img|<b>|javascript:/);
  });
});

describe("the memory backend", () => {
  it("does not list conversations as cards", async () => {
    const b = memoryBackend();
    const doc = new LoroDoc();
    appendMessage(doc, { role: "user", text: "hi" }, 1);
    await b.applyUpdate("0190a0b0-0000-7000-8000-000000000001", "board", doc.export({ mode: "snapshot" }));
    expect(await b.listCards()).toEqual([]);
  });
});

describe("answering a message", () => {
  beforeAll(async () => {
    await startDocs();
    await saveProvider({ name: "Test", protocol: "anthropic", baseUrl: "https://example.test/v1", models: ["test-model"] }, "k");
  });
  afterEach(() => {
    delete g.__folioFakeAi;
  });

  it("runs the model's tool calls and sends their results back until it is done", async () => {
    await backend.createCard("所有权");
    const requests: AiTurnRequest[] = [];
    g.__folioFakeAi = async (request, onEvent) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        onEvent({ type: "tool", id: "t1", name: "search" });
        return { parts: [{ type: "tool", id: "t1", name: "search", input: { query: "所有权" } }], raw: null, stop: "toolUse", inputTokens: 1, outputTokens: 1 };
      }
      onEvent({ type: "text", text: "找到了" });
      return { parts: [{ type: "text", text: "找到了。" }], raw: null, stop: "end", inputTokens: 1, outputTokens: 1 };
    };
    const id = await newChat("所有权是什么？");
    await send(id, "所有权是什么？", { cardId: "c9", title: "Rust" });
    expect(useChatLive.getState().errors[id]).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].provider).toBe(useAiSettings.getState().current);
    expect(requests[0].messages[0]).toMatchObject({ role: "user" });
    expect((requests[0].messages[0] as { text: string }).text).toMatch(/Rust.*c9[\s\S]*所有权是什么？/);
    const results = requests[1].messages[2];
    expect(results.role).toBe("tools");
    expect(results.role === "tools" && results.results[0]).toMatchObject({ id: "t1", isError: false });
    const h = await openChat(id);
    expect(readMessages(h.doc).map((m) => m.message.role)).toEqual(["user", "assistant", "tools", "assistant"]);
  });

  it("reports a refusal and a missing key", async () => {
    g.__folioFakeAi = async () => ({ parts: [], raw: null, stop: "refusal", inputTokens: 0, outputTokens: 0 });
    const id = await newChat("x");
    await send(id, "x", null);
    expect(useChatLive.getState().errors[id]).toBeTruthy();
    g.__folioFakeAi = async () => {
      throw new Error("no-key");
    };
    await send(id, "y", null);
    expect(useChatLive.getState().errors[id]).toMatch(/key/i);
  });

  it("sends the cards attached with @, asks an answer again, and takes an edited message's place", async () => {
    const requests: AiTurnRequest[] = [];
    let n = 0;
    g.__folioFakeAi = async (request) => {
      requests.push(structuredClone(request));
      return { parts: [{ type: "text", text: `答${++n}` }], raw: null, stop: "end", inputTokens: 0, outputTokens: 0 };
    };
    const id = await newChat("比较");
    await send(id, "比较这两张", null, [{ cardId: "a1", title: "甲" }, { cardId: "b2", title: "乙" }]);
    expect((requests[0].messages[0] as { text: string }).text).toMatch(/read_card[\s\S]*“甲” \(id a1\), “乙” \(id b2\)[\s\S]*比较这两张$/);
    const h = await openChat(id);
    const texts = () => readMessages(h.doc).map((m) => (m.message.role === "user" ? m.message.text : m.message.role === "assistant" && m.message.parts[0]?.type === "text" ? m.message.parts[0].text : ""));
    await regenerate(id);
    expect(texts()).toEqual(["比较这两张", "答2"]);
    expect(requests[1].messages).toHaveLength(1);
    await editLast(id, "只看甲");
    expect(texts()).toEqual(["只看甲", "答3"]);
    // What it was sent with goes again.
    expect((requests[2].messages[0] as { text: string }).text).toMatch(/a1[\s\S]*只看甲$/);
    // Taken back, not removed: the list only grows.
    expect(h.doc.getList("messages").length).toBe(5);
  });

  it("asks the thinking level only of models that take it", async () => {
    expect(effortLevels("anthropic", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevels("anthropic", "claude-opus-4-5-20251101")).toContain("max");
    expect(effortLevels("anthropic", "claude-haiku-4-5")).toEqual([]);
    expect(effortLevels("anthropic", "claude-3-5-sonnet-latest")).toEqual([]);
    expect(effortLevels("openai", "gpt-5-mini")).toEqual(["low", "medium", "high"]);
    expect(effortLevels("openai", "openai/o4-mini")).toHaveLength(3);
    expect(effortLevels("openai", "deepseek-chat")).toEqual([]);
    expect(turnEffort("openai", "deepseek-chat", "high")).toBe("");
    const requests: AiTurnRequest[] = [];
    g.__folioFakeAi = async (request) => (requests.push(request), { parts: [{ type: "text", text: "好" }], raw: null, stop: "end", inputTokens: 0, outputTokens: 0 });
    await saveProvider({ name: "Test", protocol: "anthropic", baseUrl: "https://example.test/v1", models: ["test-model"], effort: "high" }, "k");
    const id = await newChat("x");
    await send(id, "x", null);
    expect(requests[0]).toMatchObject({ model: "test-model", effort: "" });
  });

  it("stops between turns when asked", async () => {
    let turns = 0;
    const id = await newChat("loop");
    g.__folioFakeAi = async () => {
      turns++;
      stop(id);
      return { parts: [{ type: "tool", id: `t${turns}`, name: "search", input: { query: "a" } }], raw: null, stop: "toolUse", inputTokens: 0, outputTokens: 0 };
    };
    await send(id, "loop", null);
    expect(turns).toBe(1);
    expect(useChatLive.getState().live[id]).toBeUndefined();
  });
});

describe("changing notes", () => {
  beforeAll(async () => {
    await startDocs();
    if (!useAiSettings.getState().current) await saveProvider({ name: "Test", protocol: "anthropic", baseUrl: "https://example.test/v1", models: ["test-model"] }, "k");
  });
  afterEach(() => {
    delete g.__folioFakeAi;
  });

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  /** A model that makes one tool call, then ends. */
  const once = (name: string, input: Record<string, unknown>) => {
    let n = 0;
    const seen: AiTurnRequest[] = [];
    g.__folioFakeAi = async (request) => {
      seen.push(structuredClone(request));
      return n++ === 0
        ? { parts: [{ type: "tool", id: `w${Math.random()}`, name, input }], raw: null, stop: "toolUse", inputTokens: 0, outputTokens: 0 }
        : { parts: [{ type: "text", text: "好了" }], raw: null, stop: "end", inputTokens: 0, outputTokens: 0 };
    };
    return seen;
  };

  const lastTools = async (chatId: string) => {
    const h = await openChat(chatId);
    const tools = readMessages(h.doc).filter((m) => m.message.role === "tools").at(-1)!.message;
    return tools.role === "tools" ? tools : null!;
  };

  const blocks = async (cardId: string) => {
    const h = await docs().open(cardId);
    try {
      return await withHeadlessEditor(h, (e) => {
        const out: { bid: string; text: string; source: string | null }[] = [];
        e.state.doc.descendants((n) => {
          if (n.isTextblock) out.push({ bid: n.attrs.bid, text: n.textContent, source: n.attrs.source });
        });
        return out;
      });
    } finally {
      await docs().release(cardId);
    }
  };

  it("creates a card directly in auto mode, marked as the model's, and undoes it", async () => {
    await setWriteMode("auto");
    once("create_card", { title: "复习计划", content: "## 第一周\n\n- [ ] 所有权\n- [ ] 借用" });
    const id = await newChat("做个复习计划");
    await send(id, "做个复习计划", null);
    const tools = await lastTools(id);
    const record = Object.values(tools.writes!)[0];
    expect(record.status).toBe("done");
    const cardId = record.cardId!;
    const card = await notes().readCard(cardId);
    expect(card.title).toBe("复习计划");
    const written = await blocks(cardId);
    expect(written.map((b) => b.text)).toEqual(["第一周", "所有权", "借用"]);
    expect(written.every((b) => b.source === "ai:test-model")).toBe(true);
    await undo(record.change!);
    expect((await backend.listCards()).map((c) => c.id)).not.toContain(cardId);
  });

  it("asks first in ask mode, and writes only once allowed", async () => {
    await setWriteMode("ask");
    const cardId = await notes().createCard({ title: "Rust", lines: ["所有权"], source: "human" });
    once("append_to_card", { card_id: cardId, content: "补充：**借用**不转移所有权" });
    const id = await newChat("补充一下");
    const done = send(id, "补充一下", null);
    await until(() => !!useChatLive.getState().live[id]?.pending);
    const pending = useChatLive.getState().live[id]!.pending!;
    expect(pending[0].proposal).toMatchObject({ target: "Rust", cardId });
    expect((await blocks(cardId)).map((b) => b.text)).toEqual(["所有权"]);
    decide(id, pending[0].part.id, true);
    await done;
    expect((await blocks(cardId)).map((b) => b.text)).toEqual(["所有权", "补充：借用不转移所有权"]);
    const record = Object.values((await lastTools(id)).writes!)[0];
    await undo(record.change!);
    expect((await blocks(cardId)).map((b) => b.text)).toEqual(["所有权"]);
  });

  it("tells the model when the user declines or stops, and changes nothing", async () => {
    await setWriteMode("ask");
    const cardId = await notes().createCard({ title: "旧标题", source: "human" });
    const seen = once("rename_card", { card_id: cardId, title: "新标题" });
    const id = await newChat("改名");
    const done = send(id, "改名", null);
    await until(() => !!useChatLive.getState().live[id]?.pending);
    decide(id, useChatLive.getState().live[id]!.pending![0].part.id, false);
    await done;
    const result = seen[1].messages.at(-1)!;
    expect(result.role === "tools" && result.results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
    expect("writes" in result).toBe(false);
    expect((await notes().readCard(cardId)).title).toBe("旧标题");

    once("rename_card", { card_id: cardId, title: "新标题" });
    const again = send(id, "还是改吧", null);
    await until(() => !!useChatLive.getState().live[id]?.pending);
    stop(id);
    await again;
    expect((await notes().readCard(cardId)).title).toBe("旧标题");
    expect(Object.values((await lastTools(id)).writes!)[0].status).toBe("declined");
  });

  it("changes a block's text, and does not undo over a later edit", async () => {
    await setWriteMode("auto");
    const cardId = await notes().createCard({ title: "笔记", lines: ["第一行", "第二行"], source: "human" });
    const [, second] = await blocks(cardId);
    once("update_block", { card_id: cardId, block_id: second.bid, text: "第二行，**改过**" });
    const id = await newChat("改");
    await send(id, "改", null);
    const after = await blocks(cardId);
    expect(after[1]).toMatchObject({ text: "第二行，改过", source: "ai:test-model" });
    const record = Object.values((await lastTools(id)).writes!)[0];
    await undo(record.change!);
    expect((await blocks(cardId))[1]).toMatchObject({ text: "第二行", source: null });
    await expect(undo(record.change!)).rejects.toBeInstanceOf(ChangedSince);
  });

  it("leaves a block the user edited after the change to it was proposed", async () => {
    await setWriteMode("ask");
    const cardId = await notes().createCard({ title: "笔记", lines: ["第一行", "第二行"], source: "human" });
    const [, second] = await blocks(cardId);
    const seen = once("update_block", { card_id: cardId, block_id: second.bid, text: "AI 改的" });
    const id = await newChat("改");
    const done = send(id, "改", null);
    await until(() => !!useChatLive.getState().live[id]?.pending);
    const h = await docs().open(cardId);
    await withHeadlessEditor(h, (editor) => void editor.commands.insertContentAt(editor.state.doc.content.size - 1, "，我加的"));
    await docs().release(cardId);
    decide(id, useChatLive.getState().live[id]!.pending![0].part.id, true);
    await done;
    expect((await blocks(cardId))[1].text).toBe("第二行，我加的");
    const result = seen[1].messages.at(-1)!;
    expect(result.role === "tools" && result.results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/edited this block/) });
  });

  it("reports a card that does not exist without asking", async () => {
    await setWriteMode("ask");
    const seen = once("append_to_card", { card_id: "no-such-card", content: "x" });
    const id = await newChat("x");
    await send(id, "x", null);
    const result = seen[1].messages.at(-1)!;
    expect(result.role === "tools" && result.results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/No card/) });
  });
});

describe("writing a message", () => {
  it("finds the @ being typed", () => {
    expect(mentionAt("看看 @Ru", 7)).toEqual({ start: 3, query: "Ru" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("a@b.com", 7)).toBeNull();
    expect(mentionAt("@x\ny", 4)).toBeNull();
  });

  it("groups the history by when each conversation was last used", () => {
    const now = new Date(2026, 10, 2, 15).getTime();
    expect(chatGroup(new Date(2026, 10, 2, 1).getTime(), now)).toBe("today");
    expect(chatGroup(new Date(2026, 10, 1, 23).getTime(), now)).toBe("yesterday");
    expect(chatGroup(new Date(2026, 9, 28).getTime(), now)).toBe("week");
    expect(chatGroup(new Date(2026, 9, 10).getTime(), now)).toBe("month");
    expect(chatGroup(new Date(2025, 0, 1).getTime(), now)).toBe("older");
  });
});
