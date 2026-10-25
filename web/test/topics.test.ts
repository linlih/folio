import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { addCardTopic, initCard, readCardTopics, removeCardTopic } from "../src/docs/card";
import { createTopic, deleteTopic, readTopics, renameTopic } from "../src/docs/workspace";
import { DocHub } from "../src/docs/hub";
import { memoryBackend, MEMORY_FRONTEND_PEER } from "../src/platform/memory";

const device = (peer: bigint, from?: LoroDoc) => {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  if (from) doc.import(from.export({ mode: "snapshot" }));
  return doc;
};
const sync = (a: LoroDoc, b: LoroDoc) => {
  a.import(b.export({ mode: "update" }));
  b.import(a.export({ mode: "update" }));
};

describe("topics (§4.7): their own objects, not tags", () => {
  it("are made, renamed and deleted in the workspace document", () => {
    const ws = device(1n);
    const a = createTopic(ws, " 投资 ", 1);
    const b = createTopic(ws, "书单", 2);
    renameTopic(ws, a, "投资学习");
    expect(readTopics(ws).map((t) => [t.id, t.name])).toEqual([
      [a, "投资学习"],
      [b, "书单"],
    ]);
    deleteTopic(ws, b, 3);
    expect(readTopics(ws).map((t) => t.id)).toEqual([a]);
  });

  it("merge topics made on two devices, and a rename with a delete", () => {
    const one = device(1n);
    const two = device(2n);
    const a = createTopic(one, "投资", 1);
    const b = createTopic(two, "读书", 2);
    sync(one, two);
    expect(readTopics(one).map((t) => t.name)).toEqual(["投资", "读书"]);
    renameTopic(one, a, "投资学习");
    deleteTopic(two, b, 3);
    sync(one, two);
    expect(readTopics(two).map((t) => t.name)).toEqual(["投资学习"]);
  });

  it("keep both when two devices put a card in different topics at once", () => {
    const a = device(1n);
    initCard(a, "note", "书", 1);
    const b = device(2n, a);
    addCardTopic(a, "topic-a", 1);
    addCardTopic(b, "topic-b", 2);
    sync(a, b);
    expect(readCardTopics(a)).toEqual(["topic-a", "topic-b"]);
    removeCardTopic(a, "topic-a");
    expect(readCardTopics(a)).toEqual(["topic-b"]);
  });

  it("list a topic's cards and counts; the workspace document is not a card", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const ws = await hub.open("ws");
    const topic = createTopic(ws.doc, "投资");
    await ws.persistence.flush();
    const id = await backend.createCard("漫步华尔街");
    const card = await hub.open(id);
    addCardTopic(card.doc, topic);
    await card.persistence.flush();
    expect((await backend.topicCards(topic)).map((c) => c.id)).toEqual([id]);
    expect(await backend.topicCounts()).toEqual([{ id: topic, cards: 1 }]);
    expect((await backend.listCards()).map((c) => c.id)).toEqual([id]);
    expect(await backend.tags()).toEqual([]);
  });
});
