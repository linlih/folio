// The assistant's conversations (design/ai.md "对话记录"). Each is a document
// of its own that syncs like the notes, stored as a whiteboard-kind
// document under a bare id: versions before the assistant sync it without
// error and show nothing of it (their whiteboard list is the workspace's
// `boards`, and they index only cards). The list of conversations, with
// their titles, is the workspace's `chats` map.
//
// A conversation is a list of messages, each made once by the device that
// sent or received it and never changed: the message as the host takes it
// (ai/types.ts), as JSON.

import { LoroMap, type LoroDoc } from "loro-crdt";
import type { AiMessage } from "../ai/types";
import { uuidv7 } from "./ids";

const CHATS = "chats";
const MESSAGES = "messages";
/** Origin of chat list edits: not undoable from a card. */
export const CHAT_ORIGIN = "meta:chat";

export interface ChatInfo {
  id: string;
  title: string;
  createdAt: number;
  /** The last message sent. */
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  at: number;
  message: AiMessage;
  /** The model that wrote an assistant message, as the provider names it. */
  model?: string;
}

const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");
const num = (m: LoroMap, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : null);

/** Conversations not deleted, the most recently used first. */
export function readChats(ws: LoroDoc): ChatInfo[] {
  const all = ws.getMap(CHATS);
  const out: ChatInfo[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap) || num(m, "deleted_at") !== null) continue;
    const createdAt = num(m, "created_at") ?? 0;
    out.push({ id, title: str(m, "title"), createdAt, updatedAt: num(m, "updated_at") ?? createdAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
}

/** Adds a conversation to the list; its document is written with its first message. */
export function createChat(ws: LoroDoc, title: string, now = Date.now(), id = uuidv7(now)): string {
  const m = ws.getMap(CHATS).setContainer(id, new LoroMap());
  m.set("title", title);
  m.set("created_at", now);
  m.set("updated_at", now);
  ws.commit({ origin: CHAT_ORIGIN });
  return id;
}

export function touchChat(ws: LoroDoc, id: string, now = Date.now()) {
  const m = ws.getMap(CHATS).get(id);
  if (!(m instanceof LoroMap)) return;
  m.set("updated_at", now);
  ws.commit({ origin: CHAT_ORIGIN });
}

export function renameChat(ws: LoroDoc, id: string, title: string) {
  const m = ws.getMap(CHATS).get(id);
  if (!(m instanceof LoroMap) || !title.trim()) return;
  m.set("title", title.trim());
  ws.commit({ origin: CHAT_ORIGIN });
}

/** Takes a conversation off the list, on every device. */
export function deleteChat(ws: LoroDoc, id: string, now = Date.now()) {
  const m = ws.getMap(CHATS).get(id);
  if (!(m instanceof LoroMap)) return;
  m.set("deleted_at", now);
  ws.commit({ origin: CHAT_ORIGIN });
}

/** Whether the conversation was deleted (here or on another device). */
export function chatDeleted(ws: LoroDoc, id: string): boolean {
  const m = ws.getMap(CHATS).get(id);
  return m instanceof LoroMap && num(m, "deleted_at") !== null;
}

/** Messages taken back by id: an answer asked again, a message edited.
 *  Kept apart from the messages, which are never changed; versions before
 *  it still show them. */
const DROPPED = "dropped";

export function dropMessages(doc: LoroDoc, ids: string[], now = Date.now()) {
  const dropped = doc.getMap(DROPPED);
  for (const id of ids) if (id) dropped.set(id, now);
  doc.commit({ origin: CHAT_ORIGIN });
}

/** The messages in order; one that cannot be read, or taken back, is left out. */
export function readMessages(doc: LoroDoc): ChatMessage[] {
  const list = doc.getList(MESSAGES);
  const dropped = doc.getMap(DROPPED);
  const out: ChatMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list.get(i);
    if (!(m instanceof LoroMap) || dropped.get(str(m, "id")) !== undefined) continue;
    try {
      const message = JSON.parse(str(m, "data")) as AiMessage;
      if (!message || typeof message !== "object" || !("role" in message)) continue;
      const model = str(m, "model");
      out.push({ id: str(m, "id"), at: num(m, "at") ?? 0, message, ...(model ? { model } : {}) });
    } catch {
      // Written by a later version, or damaged: skipped, not fatal.
    }
  }
  return out;
}

export function appendMessage(doc: LoroDoc, message: AiMessage, now = Date.now(), model?: string): string {
  const list = doc.getList(MESSAGES);
  const m = list.insertContainer(list.length, new LoroMap());
  const id = uuidv7(now);
  m.set("id", id);
  m.set("at", now);
  m.set("data", JSON.stringify(message));
  if (model) m.set("model", model);
  doc.commit({ origin: CHAT_ORIGIN });
  return id;
}

/** The assistant's changes undone, by tool call id (ai/writes.ts). Kept
 *  apart from the messages, which are never changed. */
const UNDONE = "undone";

export function markUndone(doc: LoroDoc, toolId: string, now = Date.now()) {
  doc.getMap(UNDONE).set(toolId, now);
  doc.commit({ origin: CHAT_ORIGIN });
}

export const readUndone = (doc: LoroDoc): Set<string> => new Set(doc.getMap(UNDONE).keys());

export const hasMessages = (doc: LoroDoc) => doc.getList(MESSAGES).length > 0;
