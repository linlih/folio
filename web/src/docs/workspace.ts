// The workspace document (`ws`, design/ARCHITECTURE.md §4.1): what belongs
// to the whole library rather than one card: the topics (§4.7) and the list
// of whiteboards (§4.3).
//
// `topics` is a root map, so every device's copy is the same container; each
// topic is a map under its own new id, made by one device only, so its
// fields merge per field (a rename on one device, a move on another).

import { LoroMap, type LoroDoc } from "loro-crdt";
import { uuidv7 } from "./ids";

export const WORKSPACE_ID = "ws";
const TOPICS = "topics";
/** Origin of topic edits: not part of a card's undo history. */
export const TOPIC_ORIGIN = "meta:topic";

export interface Topic {
  id: string;
  name: string;
  /** The topic above it (two levels, §4.7); null at the top. */
  parent: string | null;
  createdAt: number;
}

const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");
const num = (m: LoroMap, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : null);

/** Topics not deleted, in the order they were made. */
export function readTopics(doc: LoroDoc): Topic[] {
  const all = doc.getMap(TOPICS);
  const out: Topic[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap) || num(m, "deleted_at") !== null) continue;
    out.push({ id, name: str(m, "name"), parent: str(m, "parent") || null, createdAt: num(m, "created_at") ?? 0 });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export function createTopic(doc: LoroDoc, name: string, now = Date.now()): string {
  const id = uuidv7(now);
  const m = doc.getMap(TOPICS).setContainer(id, new LoroMap());
  m.set("name", name.trim());
  m.set("created_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
  return id;
}

export function renameTopic(doc: LoroDoc, id: string, name: string) {
  const m = doc.getMap(TOPICS).get(id);
  if (!(m instanceof LoroMap) || !name.trim()) return;
  m.set("name", name.trim());
  doc.commit({ origin: TOPIC_ORIGIN });
}

// ---- whiteboards (§4.3): the list; each board's content is its own
// document `board:<id>` ----

const BOARDS = "boards";

export interface BoardInfo {
  id: string;
  name: string;
  createdAt: number;
}

/** Whiteboards not deleted, newest first. */
export function readBoards(doc: LoroDoc): BoardInfo[] {
  const all = doc.getMap(BOARDS);
  const out: BoardInfo[] = [];
  for (const id of all.keys()) {
    const m = all.get(id);
    if (!(m instanceof LoroMap) || num(m, "deleted_at") !== null) continue;
    out.push({ id, name: str(m, "name"), createdAt: num(m, "created_at") ?? 0 });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** Adds a whiteboard to the list; `id` keeps an existing board document
 *  (one made under a topic before boards stood alone). */
export function createBoard(doc: LoroDoc, name: string, now = Date.now(), id = uuidv7(now)): string {
  const m = doc.getMap(BOARDS).setContainer(id, new LoroMap());
  m.set("name", name.trim());
  m.set("created_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
  return id;
}

export function renameBoard(doc: LoroDoc, id: string, name: string) {
  const m = doc.getMap(BOARDS).get(id);
  if (!(m instanceof LoroMap) || !name.trim()) return;
  m.set("name", name.trim());
  doc.commit({ origin: TOPIC_ORIGIN });
}

/** Deletes a whiteboard (the cards on it stay in the library). */
export function deleteBoard(doc: LoroDoc, id: string, now = Date.now()) {
  const m = doc.getMap(BOARDS).get(id);
  if (!(m instanceof LoroMap)) return;
  m.set("deleted_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
}

export const hasBoard = (doc: LoroDoc, id: string) => doc.getMap(BOARDS).get(id) instanceof LoroMap;

/** Deletes a topic (its cards stay; they just are not in it any more). A
 *  marker, so a device that is offline sees it go too. */
export function deleteTopic(doc: LoroDoc, id: string, now = Date.now()) {
  const m = doc.getMap(TOPICS).get(id);
  if (!(m instanceof LoroMap)) return;
  m.set("deleted_at", now);
  doc.commit({ origin: TOPIC_ORIGIN });
}
