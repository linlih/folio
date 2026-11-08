// A conversation with the assistant (design/ai.md): the user's message,
// then turns until the model is done — each turn its answer streamed in,
// its tool calls run and their results sent back. Every message is written
// to the conversation's document as it is complete, so it syncs and a
// conversation stopped half way keeps what came.

import { create } from "zustand";
import { docs } from "../app";
import { appendMessage, createChat, dropMessages, readMessages, touchChat, type ChatMessage } from "../docs/chat";
import type { DocHandle } from "../docs/hub";
import { localDate, uuidv7 } from "../docs/ids";
import { workspaceDoc } from "../docs/topics";
import i18n from "../i18n";
import { backend } from "../platform";
import { turnEffort } from "./effort";
import { currentProvider, modelInfo, useAiSettings } from "./settings";
import type { AiMessage, AiPart, AiTool, AiToolResult } from "./types";
import { openAt } from "../card/reveal";
import { goToChange, IN_CARD } from "./reviewState";
import { apply, isWriteTool, propose, WRITE_TOOLS, type Proposal, type WriteRecord } from "./writes";

type ToolPart = Extract<AiPart, { type: "tool" }>;

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

/** A card the user attached with @ (as Notion and Obsidian Copilot let
 *  notes be mentioned). */
export interface CardRef {
  cardId: string;
  title: string;
}

/** A user message as kept: what they typed, what they were looking at, and
 *  the cards they attached. Versions before `cards` keep it and leave it out. */
export type UserMessage = { role: "user"; text: string; context?: ChatContext; cards?: CardRef[] };

/** A conversation being answered on this device. */
export interface LiveTurn {
  /** Text of the turn streaming now. */
  text: string;
  /** Tool calls of the turn streaming now. */
  tools: { id: string; name: string }[];
  turn: string;
  stopping: boolean;
  /** Changes waiting for the user's yes or no ("ask" mode). */
  pending?: PendingWrite[];
}

export interface PendingWrite {
  part: ToolPart;
  proposal: Proposal;
  /** The user's answer, once given. */
  allowed?: boolean;
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

/** Answers awaited by a conversation, and conversations allowed to change
 *  notes without asking until the app restarts. */
const waiting = new Map<string, () => void>();
const allowedChats = new Set<string>();

const patchLive = (chatId: string, f: (t: LiveTurn) => LiveTurn) => {
  const cur = useChatLive.getState().live[chatId];
  if (cur) setLive(chatId, f(cur));
};

/** The user's answer to a proposed change. */
export function decide(chatId: string, toolId: string, allowed: boolean) {
  patchLive(chatId, (t) => ({ ...t, pending: t.pending?.map((p) => (p.part.id === toolId ? { ...p, allowed } : p)) }));
  const pending = useChatLive.getState().live[chatId]?.pending ?? [];
  if (pending.every((p) => p.allowed !== undefined)) waiting.get(chatId)?.();
}

/** Allows every change proposed now, and with `forChat` the conversation's
 *  later ones too. */
export function allowAll(chatId: string, forChat = false) {
  if (forChat) allowedChats.add(chatId);
  for (const p of useChatLive.getState().live[chatId]?.pending ?? []) if (p.allowed === undefined) decide(chatId, p.part.id, true);
}

/** Shows the proposals and resolves once each is answered (or the answer stopped). */
function ask(chatId: string, pending: PendingWrite[]): Promise<void> {
  patchLive(chatId, (t) => ({ ...t, pending }));
  // Changes to a card are shown in it too (ai/review.ts): open it at the first.
  const first = pending.find((p) => IN_CARD.has(p.part.name) && p.proposal.cardId);
  if (first?.proposal.cardId) {
    const bid = typeof first.part.input?.block_id === "string" ? first.part.input.block_id : null;
    openAt(first.proposal.cardId, first.proposal.target, bid);
    setTimeout(() => goToChange(first.part.id), 300);
  }
  return new Promise<void>((resolve) => waiting.set(chatId, resolve)).finally(() => waiting.delete(chatId));
}

/** Runs a reply's write calls: proposed first unless the user lets the
 *  assistant change notes directly, then made one by one, in order. */
async function runWrites(chatId: string, parts: ToolPart[], source: string): Promise<{ results: AiToolResult[]; writes: Record<string, WriteRecord> }> {
  const results: AiToolResult[] = [];
  const writes: Record<string, WriteRecord> = {};
  const proposals: PendingWrite[] = [];
  for (const part of parts) {
    try {
      proposals.push({ part, proposal: await propose(part.name, part.input) });
    } catch (e) {
      results.push({ id: part.id, content: e instanceof Error ? e.message : String(e), isError: true });
    }
  }
  const direct = useAiSettings.getState().writes === "auto" || allowedChats.has(chatId);
  if (proposals.length && !direct) {
    await ask(chatId, proposals);
    proposals.splice(0, proposals.length, ...(useChatLive.getState().live[chatId]?.pending ?? proposals));
  }
  for (const { part, proposal, allowed } of proposals) {
    const at = { target: proposal.target, cardId: proposal.cardId };
    if (!direct && !allowed) {
      const stopped = useChatLive.getState().live[chatId]?.stopping;
      results.push({ id: part.id, content: stopped ? "Stopped by the user before this change was made." : "The user declined this change.", isError: true });
      writes[part.id] = { ...at, status: "declined" };
      continue;
    }
    try {
      const r = await apply(part.name, part.input, source, direct ? undefined : proposal);
      results.push({ id: part.id, content: r.content, isError: false });
      writes[part.id] = { ...at, cardId: r.change?.cardId ?? at.cardId, status: "done", ...(r.change ? { change: r.change } : {}) };
    } catch (e) {
      results.push({ id: part.id, content: e instanceof Error ? e.message : String(e), isError: true });
      writes[part.id] = { ...at, status: "failed" };
    }
  }
  patchLive(chatId, (t) => ({ ...t, pending: undefined }));
  return { results, writes };
}

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
    "You can also change the notes with the write tools: create cards, add to a card or the journal, change a block's text, rename a card, file a card under a topic. Change notes only when the user asks for it or clearly wants it, and read first so you change the right place. Never remove or overwrite what the user wrote unless they ask. The user may be asked to approve each change; when they decline one, do not make it again — ask what they want instead. Content you write may link to notes in the same folio: forms; they become links in the notes.",
    `Write in Markdown. Answer in the user's language (the app is set to ${lang}).`,
    `Today is ${localDate(now)}.`,
  ].join("\n\n");
}

/** The message as the host takes it: what the user was looking at goes
 *  before what they typed. */
function forModel(m: AiMessage | UserMessage): AiMessage {
  if (m.role === "tools") return { role: "tools", results: m.results };
  if (m.role !== "user") return m;
  const u = m as UserMessage;
  const name = (title: string) => title || i18n.t("library.untitled");
  const lines: string[] = [];
  if (u.context) {
    lines.push(`[The user is looking at the card “${name(u.context.title)}” (id ${u.context.cardId}).]`);
    if (u.context.selection) lines.push(`[They selected this text in it:]\n${u.context.selection}`);
  }
  const cards = Array.isArray(u.cards) ? u.cards.filter((c) => c && typeof c.cardId === "string") : [];
  if (cards.length) lines.push(`[The user attached these cards to this message; read them with read_card before answering: ${cards.map((c) => `“${name(c.title)}” (id ${c.cardId})`).join(", ")}.]`);
  return { role: "user", text: lines.length ? `${lines.join("\n")}\n\n${u.text}` : u.text };
}

let tools: Promise<AiTool[]> | null = null;
const readTools = () => (tools ??= backend.aiTools().then((read) => [...read, ...WRITE_TOOLS]).catch((e) => ((tools = null), Promise.reject(e))));

async function runTool(part: ToolPart): Promise<AiToolResult> {
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
export function send(id: string, text: string, context: ChatContext | null, cards: CardRef[] = [], now: () => number = Date.now): Promise<void> {
  const user: UserMessage = { role: "user", text, ...(context ? { context } : {}), ...(cards.length ? { cards } : {}) };
  return run(id, user, () => [], now);
}

/** The messages after the last one the user sent (its answer), and with
 *  `withIt` that one too. */
const lastExchange = (messages: ChatMessage[], withIt: boolean) => {
  const at = messages.map((m) => m.message.role).lastIndexOf("user");
  return at < 0 ? [] : messages.slice(withIt ? at : at + 1).map((m) => m.id);
};

/** Asks again for the answer to the last message, the old answer taken back. */
export function regenerate(id: string, now: () => number = Date.now): Promise<void> {
  return run(id, null, (messages) => lastExchange(messages, false), now);
}

/** Sends `text` in place of the last message the user sent, which is taken
 *  back with its answer; what it was sent with goes again. */
export function editLast(id: string, text: string, now: () => number = Date.now): Promise<void> {
  let user: UserMessage | null = null;
  return run(
    id,
    () => user,
    (messages) => {
      const last = [...messages].reverse().find((m) => m.message.role === "user");
      const was = last?.message as UserMessage | undefined;
      user = { role: "user", text, ...(was?.context ? { context: was.context } : {}), ...(was?.cards?.length ? { cards: was.cards } : {}) };
      return lastExchange(messages, true);
    },
    now,
  );
}

/** One message answered: `drop` names what is taken back first, `user` is
 *  the message sent (none when an answer is asked again). */
async function run(id: string, user: UserMessage | null | (() => UserMessage | null), drop: (messages: ChatMessage[]) => string[], now: () => number): Promise<void> {
  const provider = currentProvider();
  const ws = await workspaceDoc();
  setError(id, null);
  const handle = await openChat(id);
  const turn = uuidv7();
  setLive(id, { text: "", tools: [], turn, stopping: false });
  try {
    const gone = drop(readMessages(handle.doc));
    if (gone.length) dropMessages(handle.doc, gone, now());
    const message = typeof user === "function" ? user() : user;
    if (message) appendMessage(handle.doc, message as AiMessage, now());
    touchChat(ws.doc, id, now());
    if (!provider) throw new Error("no-provider");
    const toolList = await readTools();
    for (let i = 0; i < MAX_TURNS; i++) {
      if (useChatLive.getState().live[id]?.stopping) break;
      const messages = readMessages(handle.doc).map((m) => forModel(m.message));
      let streamed = "";
      const calls: { id: string; name: string }[] = [];
      setLive(id, { text: "", tools: [], turn, stopping: useChatLive.getState().live[id]?.stopping ?? false });
      const reply = await backend.aiTurn({ turn, provider: provider.id, model: provider.model, effort: turnEffort(provider.protocol, provider.model, provider.effort, modelInfo(provider.id, provider.model)?.efforts), system: systemPrompt(new Date(now())), messages, tools: toolList }, (e) => {
        if (e.type === "text") streamed += e.text;
        else calls.push({ id: e.id, name: e.name });
        const cur = useChatLive.getState().live[id];
        setLive(id, { text: streamed, tools: [...calls], turn, stopping: cur?.stopping ?? false });
      });
      const parts = reply.parts.filter((p) => p.type !== "text" || p.text);
      if (parts.length || reply.raw) appendMessage(handle.doc, { role: "assistant", parts, ...(reply.raw ? { raw: reply.raw } : {}) }, now(), provider.model);
      // Shown from the conversation now, not from what streamed.
      patchLive(id, (t) => ({ ...t, text: "", tools: [] }));
      if (reply.stop === "refusal") throw new Error("refusal");
      if (reply.stop === "maxTokens") throw new Error("max-tokens");
      const toolParts = parts.filter((p): p is ToolPart => p.type === "tool");
      if (reply.stop !== "toolUse" || toolParts.length === 0) break;
      const isWrite = (p: ToolPart) => isWriteTool(p.name) && p.invalid === undefined;
      const [read, written] = await Promise.all([Promise.all(toolParts.filter((p) => !isWrite(p)).map(runTool)), runWrites(id, toolParts.filter(isWrite), `ai:${provider.model}`)]);
      // In the order called.
      const byId = new Map([...read, ...written.results].map((r) => [r.id, r]));
      const results = toolParts.map((p) => byId.get(p.id)!);
      const hasWrites = Object.keys(written.writes).length > 0;
      appendMessage(handle.doc, { role: "tools", results, ...(hasWrites ? { writes: written.writes } : {}) }, now());
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
  // Proposals not answered are declined.
  for (const p of cur.pending ?? []) if (p.allowed === undefined) decide(chatId, p.part.id, false);
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
