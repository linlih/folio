// A conversation with the assistant (design/ai.md): the user's message,
// then turns until the model is done — each turn its answer streamed in,
// its tool calls run and their results sent back. Every message is written
// to the conversation's document as it is complete, so it syncs and a
// conversation stopped half way keeps what came.

import { create } from "zustand";
import { docs } from "../app";
import { appendMessage, createChat, readMessages, touchChat, type ChatMessage } from "../docs/chat";
import type { DocHandle } from "../docs/hub";
import { localDate, uuidv7 } from "../docs/ids";
import { workspaceDoc } from "../docs/topics";
import i18n from "../i18n";
import { backend } from "../platform";
import { currentProvider } from "./settings";
import type { AiMessage, AiPart, AiTool, AiToolResult } from "./types";

/** At most this many turns for one message: a model that keeps calling
 *  tools is stopped. */
const MAX_TURNS = 16;

/** What the user was looking at, sent with their message. */
export interface ChatContext {
  cardId: string;
  title: string;
  /** Text selected in the card. */
  selection?: string;
}

/** A user message as kept: what they typed, and what they were looking at. */
export type UserMessage = { role: "user"; text: string; context?: ChatContext };

/** A conversation being answered on this device. */
export interface LiveTurn {
  /** Text of the turn streaming now. */
  text: string;
  /** Tool calls of the turn streaming now. */
  tools: { id: string; name: string }[];
  turn: string;
  stopping: boolean;
}

interface LiveState {
  live: Record<string, LiveTurn>;
  /** The last error per conversation, until the next message. */
  errors: Record<string, string>;
}

export const useChatLive = create<LiveState>(() => ({ live: {}, errors: {} }));

const setLive = (chatId: string, t: LiveTurn | null) =>
  useChatLive.setState((s) => {
    const live = { ...s.live };
    if (t) live[chatId] = t;
    else delete live[chatId];
    return { live };
  });

const setError = (chatId: string, e: string | null) =>
  useChatLive.setState((s) => {
    const errors = { ...s.errors };
    if (e) errors[chatId] = e;
    else delete errors[chatId];
    return { errors };
  });

/** Opens a conversation's document; always through here, so it is stored
 *  as what it is (docs/chat.ts). */
export const openChat = (id: string): Promise<DocHandle> => docs().open(id, "chat");

/** What the model is told about Folio, the user and how to answer. */
export function systemPrompt(now = new Date()): string {
  const lang = i18n.language.startsWith("zh") ? "Chinese" : "English";
  return [
    "You are the assistant inside Folio, the user's personal notes app. The notes are cards (each with a title) and a journal (one document per day, id journal:YYYY-MM-DD). Blocks are the lines of a card, each with a block id.",
    "Use the tools to find and read the user's notes before answering questions about them; search with several wordings when a first search finds little. Answer from what the notes say, and say so when they do not cover something rather than guessing. You may also help with things beyond the notes (explaining, studying, writing), using your own knowledge; then make clear what comes from the notes and what does not.",
    "When you use something from a note, link it so the user can open it: a card as [its title](folio:card/<card id>), a block as [a few words](folio:block/<card id>/<block id>). Only link ids the tools gave you.",
    `Write in Markdown. Answer in the user's language (the app is set to ${lang}).`,
    `Today is ${localDate(now)}.`,
  ].join("\n\n");
}

/** The message as the host takes it: what the user was looking at goes
 *  before what they typed. */
function forModel(m: AiMessage | UserMessage): AiMessage {
  if (m.role !== "user" || !("context" in m) || !m.context) return m.role === "user" ? { role: "user", text: m.text } : m;
  const c = m.context;
  const lines = [`[The user is looking at the card “${c.title || i18n.t("library.untitled")}” (id ${c.cardId}).]`];
  if (c.selection) lines.push(`[They selected this text in it:]\n${c.selection}`);
  return { role: "user", text: `${lines.join("\n")}\n\n${m.text}` };
}

let tools: Promise<AiTool[]> | null = null;
const readTools = () => (tools ??= backend.aiTools().catch((e) => ((tools = null), Promise.reject(e))));

async function runTool(part: Extract<AiPart, { type: "tool" }>): Promise<AiToolResult> {
  if (part.invalid !== undefined) return { id: part.id, content: JSON.stringify({ INVALID_JSON: part.invalid }), isError: true };
  try {
    const r = await backend.aiTool(part.name, part.input);
    return { id: part.id, content: r.content, isError: r.isError };
  } catch (e) {
    return { id: part.id, content: String(e), isError: true };
  }
}

/** A short title from the first message. */
export const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0].trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

/** A new conversation, titled after its first message. */
export async function newChat(firstMessage: string, now = Date.now()): Promise<string> {
  return createChat((await workspaceDoc()).doc, titleFrom(firstMessage), now);
}

/** Sends `text` in the conversation `id` and answers it; resolves once the
 *  answer is done, stopped or failed (the error is in `useChatLive`). */
export async function send(id: string, text: string, context: ChatContext | null, now: () => number = Date.now): Promise<void> {
  const provider = currentProvider();
  const ws = await workspaceDoc();
  setError(id, null);
  const handle = await openChat(id);
  const turn = uuidv7();
  setLive(id, { text: "", tools: [], turn, stopping: false });
  try {
    const user: UserMessage = { role: "user", text, ...(context ? { context } : {}) };
    appendMessage(handle.doc, user as AiMessage, now());
    touchChat(ws.doc, id, now());
    if (!provider) throw new Error("no-provider");
    const toolList = await readTools();
    for (let i = 0; i < MAX_TURNS; i++) {
      if (useChatLive.getState().live[id]?.stopping) break;
      const messages = readMessages(handle.doc).map((m) => forModel(m.message));
      let streamed = "";
      const calls: { id: string; name: string }[] = [];
      setLive(id, { text: "", tools: [], turn, stopping: useChatLive.getState().live[id]?.stopping ?? false });
      const reply = await backend.aiTurn({ turn, provider: provider.id, system: systemPrompt(new Date(now())), messages, tools: toolList }, (e) => {
        if (e.type === "text") streamed += e.text;
        else calls.push({ id: e.id, name: e.name });
        const cur = useChatLive.getState().live[id];
        setLive(id, { text: streamed, tools: [...calls], turn, stopping: cur?.stopping ?? false });
      });
      const parts = reply.parts.filter((p) => p.type !== "text" || p.text);
      if (parts.length || reply.raw) appendMessage(handle.doc, { role: "assistant", parts, ...(reply.raw ? { raw: reply.raw } : {}) }, now(), provider.model);
      if (reply.stop === "refusal") throw new Error("refusal");
      if (reply.stop === "maxTokens") throw new Error("max-tokens");
      const toolParts = parts.filter((p): p is Extract<AiPart, { type: "tool" }> => p.type === "tool");
      if (reply.stop !== "toolUse" || toolParts.length === 0) break;
      const results = await Promise.all(toolParts.map(runTool));
      appendMessage(handle.doc, { role: "tools", results }, now());
      if (i === MAX_TURNS - 1) throw new Error("too-many-turns");
    }
  } catch (e) {
    setError(id, errorText(e));
  } finally {
    setLive(id, null);
    await docs().release(id);
  }
}

/** Stops the answer being written in `chatId`. */
export function stop(chatId: string) {
  const cur = useChatLive.getState().live[chatId];
  if (!cur) return;
  setLive(chatId, { ...cur, stopping: true });
  void backend.aiCancel(cur.turn);
}

/** The error as the user reads it. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const code of ["no-provider", "no-key", "unavailable", "refusal", "max-tokens", "too-many-turns"]) {
    if (raw === code || raw.endsWith(code)) return i18n.t(`ai.errors.${code}`);
  }
  return i18n.t("ai.errors.other", { message: raw });
}

/** The text of an assistant message (its tool calls left out). */
export const messageText = (m: ChatMessage) => (m.message.role === "assistant" ? m.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "");
