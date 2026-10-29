// The topics and whiteboards, kept current from the workspace document
// (§4.7, §4.3), and the number of cards in each topic from the index (a
// topic counts the cards of its sub-topics too, each card once).

import { useEffect } from "react";
import { create } from "zustand";
import { docs } from "../app";
import { CARDS_CHANGED, cardsChanged } from "../card/actions";
import { backend } from "../platform";
import type { DocHandle } from "./hub";
import { DOC_SAVED } from "./persistence";
import { addCardTopic, readCardTopics, removeCardTopic } from "./card";
import { boardId } from "./board";
import { createBoard, createTopic, deleteTopic, hasBoard, moveTopic, readBoards, readTopics, subTopics, WORKSPACE_ID, type BoardInfo, type Topic } from "./workspace";

interface Topics {
  topics: Topic[];
  /** The cards in each topic itself (not in the trash). */
  members: Record<string, string[]>;
  /** How many cards each topic has, its sub-topics' included. */
  counts: Record<string, number>;
}

export const useTopics = create<Topics>(() => ({ topics: [], members: {}, counts: {} }));

/** Each topic's cards with its sub-topics', counting a card in several of
 *  them once. */
export function deepCounts(topics: Topic[], members: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of topics) {
    const cards = new Set(members[t.id] ?? []);
    for (const sub of subTopics(topics, t.id)) for (const c of members[sub.id] ?? []) cards.add(c);
    out[t.id] = cards.size;
  }
  return out;
}

function setTopics(patch: Partial<Pick<Topics, "topics" | "members">>) {
  const { topics, members } = { ...useTopics.getState(), ...patch };
  useTopics.setState({ topics, members, counts: deepCounts(topics, members) });
}

/** The whiteboards (§4.3), newest first. */
export const useBoards = create<{ boards: BoardInfo[] }>(() => ({ boards: [] }));

let workspace: Promise<DocHandle> | null = null;

/** The workspace document, opened once and kept open for the app's life. */
export function workspaceDoc(): Promise<DocHandle> {
  if (!workspace) {
    workspace = docs().open(WORKSPACE_ID);
    void workspace.then((h) => {
      const read = () => {
        setTopics({ topics: readTopics(h.doc) });
        useBoards.setState({ boards: readBoards(h.doc) });
      };
      read();
      h.doc.subscribe(read);
    });
  }
  return workspace;
}

export async function newBoard(name: string): Promise<string> {
  const h = await workspaceDoc();
  return createBoard(h.doc, name);
}

/** A new topic; with `parent`, a sub-topic of it. */
export async function newTopic(name: string, parent: string | null = null): Promise<string> {
  const h = await workspaceDoc();
  return createTopic(h.doc, name, Date.now(), parent);
}

/** Puts cards in a topic or takes them out, through their replicas. */
export async function setCardsTopic(cardIds: string[], topic: string, on: boolean) {
  const hub = docs();
  for (const id of cardIds) {
    const h = await hub.open(id);
    if (on) addCardTopic(h.doc, topic);
    else removeCardTopic(h.doc, topic);
    await h.persistence.flush();
    await hub.release(id);
  }
  cardsChanged();
}

/** Moves cards out of the topics `from` into `to`. */
export async function moveCards(cardIds: string[], from: string[], to: string) {
  const hub = docs();
  for (const id of cardIds) {
    const h = await hub.open(id);
    addCardTopic(h.doc, to);
    for (const f of from) if (f !== to && readCardTopics(h.doc).includes(f)) removeCardTopic(h.doc, f);
    await h.persistence.flush();
    await hub.release(id);
  }
  cardsChanged();
}

/** Merges `from` into `into`: its cards move there, its sub-topics go
 *  under `into` (or to the top, when `into` is itself a sub-topic), and
 *  `from` is deleted. For a topic made by mistake or split too finely. */
export async function mergeTopic(from: string, into: string) {
  const h = await workspaceDoc();
  const pairs = await backend.cardTopicPairs();
  await moveCards(pairs.filter(([, t]) => t === from).map(([c]) => c), [from], into);
  const topics = readTopics(h.doc);
  const intoTop = !topics.find((t) => t.id === into)?.parent;
  for (const sub of subTopics(topics, from)) moveTopic(h.doc, sub.id, sub.id !== into && intoTop ? into : null);
  deleteTopic(h.doc, from);
  cardsChanged();
}

export const topicName = (topics: Topic[], id: string) => topics.find((t) => t.id === id)?.name ?? null;

/** "Parent › name" for a sub-topic, the name for one at the top. */
export function topicPath(topics: Topic[], id: string): string | null {
  const t = topics.find((x) => x.id === id);
  if (!t) return null;
  const parent = t.parent && topicName(topics, t.parent);
  return parent ? `${parent} › ${t.name}` : t.name;
}

/** Whiteboards first lived under topics, as `board:<topic id>` (one
 *  version, 2026-10-25). Any such board with something on it joins the list
 *  under the topic's name, keeping its document. */
async function adoptTopicBoards() {
  const h = await workspaceDoc();
  for (const topic of readTopics(h.doc)) {
    if (hasBoard(h.doc, topic.id)) continue;
    const snapshot = await backend.docSnapshot(boardId(topic.id)).catch(() => null);
    if (snapshot) createBoard(h.doc, topic.name, Date.now(), topic.id);
  }
}

/** Starts the topics and boards and keeps the card counts current. */
export function useTopicsLoader() {
  useEffect(() => {
    void workspaceDoc().then(() => adoptTopicBoards());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void backend.cardTopicPairs().then((pairs) => {
        const members: Record<string, string[]> = {};
        for (const [card, topic] of pairs) (members[topic] ??= []).push(card);
        setTopics({ members });
      }, () => {});
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    };
    load();
    window.addEventListener(CARDS_CHANGED, load);
    window.addEventListener(DOC_SAVED, soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARDS_CHANGED, load);
      window.removeEventListener(DOC_SAVED, soon);
    };
  }, []);
}
