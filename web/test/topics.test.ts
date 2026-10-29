import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { addCardTopic, initCard, readCardTopics, removeCardTopic } from "../src/docs/card";
import { createTopic, deleteTopic, moveTopic, readTopics, renameTopic, topicTargets } from "../src/docs/workspace";
import { deepCounts } from "../src/docs/topics";
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

describe("sub-topics (§4.7): two levels", () => {
  const parents = (ws: LoroDoc) => Object.fromEntries(readTopics(ws).map((t) => [t.name, t.parent && readTopics(ws).find((x) => x.id === t.parent)?.name]));

  it("are made under a topic, moved, and go to the top when it is deleted", () => {
    const ws = device(1n);
    const ai = createTopic(ws, "AI学习", 1);
    const a = createTopic(ws, "课程A", 2, ai);
    const b = createTopic(ws, "课程B", 3);
    moveTopic(ws, b, ai);
    expect(parents(ws)).toEqual({ AI学习: null, 课程A: "AI学习", 课程B: "AI学习" });
    moveTopic(ws, a, null);
    expect(parents(ws)["课程A"]).toBeNull();
    deleteTopic(ws, ai, 4);
    expect(parents(ws)).toEqual({ 课程A: null, 课程B: null });
  });

  it("offer only moves that keep two levels", () => {
    const ws = device(1n);
    const ai = createTopic(ws, "AI学习", 1);
    const a = createTopic(ws, "课程A", 2, ai);
    const book = createTopic(ws, "书单", 3);
    const name = (x: { name: string } | null) => x?.name ?? "top";
    // A topic with sub-topics stays at the top.
    expect(topicTargets(readTopics(ws), ai).map(name)).toEqual([]);
    // A sub-topic: to the top or under another top-level topic.
    expect(topicTargets(readTopics(ws), a).map(name)).toEqual(["top", "书单"]);
    expect(topicTargets(readTopics(ws), book).map(name)).toEqual(["AI学习"]);
  });

  it("show a third level or a cycle from two devices at the top, keeping everything", () => {
    const one = device(1n);
    const a = createTopic(one, "A", 1);
    const b = createTopic(one, "B", 2);
    const c = createTopic(one, "C", 3);
    const two = device(2n, one);
    // Each device puts one under the other: a cycle.
    moveTopic(one, a, b);
    moveTopic(two, b, a);
    // And C under B on one device: would be a third level under A.
    moveTopic(two, c, b);
    sync(one, two);
    expect(parents(one)).toEqual({ A: null, B: null, C: null });
    expect(parents(two)).toEqual(parents(one));
    // Breaking the cycle on either device brings the levels back.
    moveTopic(one, b, null);
    sync(one, two);
    expect(parents(two)).toEqual({ A: "B", B: null, C: "B" });
  });

  it("show a sub-topic at the top when its parent is deleted on another device", () => {
    const one = device(1n);
    const ai = createTopic(one, "AI学习", 1);
    const two = device(2n, one);
    deleteTopic(one, ai, 2);
    createTopic(two, "课程A", 3, ai);
    sync(one, two);
    expect(parents(one)).toEqual({ 课程A: null });
  });

  it("count a topic's cards with its sub-topics', each card once", () => {
    const ws = device(1n);
    const ai = createTopic(ws, "AI学习", 1);
    const a = createTopic(ws, "课程A", 2, ai);
    const b = createTopic(ws, "课程B", 3, ai);
    const counts = deepCounts(readTopics(ws), { [ai]: ["x"], [a]: ["x", "y"], [b]: ["y", "z"] });
    expect(counts).toEqual({ [ai]: 3, [a]: 2, [b]: 2 });
  });
});
