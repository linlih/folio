// The topics and whiteboards, kept current from the workspace document
// (§4.7, §4.3), and the number of cards in each topic from the index.

import { useEffect } from "react";
import { create } from "zustand";
import { docs } from "../app";
import type { TopicCount } from "../bindings/commands";
import { CARDS_CHANGED, cardsChanged } from "../card/actions";
import { backend } from "../platform";
import type { DocHandle } from "./hub";
import { DOC_SAVED } from "./persistence";
import { addCardTopic, removeCardTopic } from "./card";
import { boardId } from "./board";
import { createBoard, createTopic, hasBoard, readBoards, readTopics, WORKSPACE_ID, type BoardInfo, type Topic } from "./workspace";

interface Topics {
  topics: Topic[];
  counts: Record<string, number>;
}

export const useTopics = create<Topics>(() => ({ topics: [], counts: {} }));

/** The whiteboards (§4.3), newest first. */
export const useBoards = create<{ boards: BoardInfo[] }>(() => ({ boards: [] }));

let workspace: Promise<DocHandle> | null = null;

/** The workspace document, opened once and kept open for the app's life. */
export function workspaceDoc(): Promise<DocHandle> {
  if (!workspace) {
    workspace = docs().open(WORKSPACE_ID);
    void workspace.then((h) => {
      const read = () => {
        useTopics.setState({ topics: readTopics(h.doc) });
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

export async function newTopic(name: string): Promise<string> {
  const h = await workspaceDoc();
  return createTopic(h.doc, name);
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

export const topicName = (topics: Topic[], id: string) => topics.find((t) => t.id === id)?.name ?? null;

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
      void backend.topicCounts().then((rows: TopicCount[]) => useTopics.setState({ counts: Object.fromEntries(rows.map((r) => [r.id, r.cards])) }), () => {});
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
