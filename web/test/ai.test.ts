// The assistant (design/ai.md): its conversations as synced documents, the
// Markdown its answers are read and kept in, and a message answered over
// several turns with tool calls.
import { LoroDoc, LoroMap } from "loro-crdt";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startDocs } from "../src/app";
import { openChat, send, stop, useChatLive, newChat } from "../src/ai/chat";
import { linkTarget, parseMarkdown, toHtml } from "../src/ai/markdown";
import { saveProvider, useAiSettings } from "../src/ai/settings";
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
    await saveProvider({ name: "Test", protocol: "anthropic", baseUrl: "https://example.test/v1", model: "test-model" }, "k");
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
