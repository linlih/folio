import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, expect, it } from "vitest";
import { docs, startDocs } from "../src/app";
import { countQuery, movePin, pinBetween, pinQueryCard, usePins } from "../src/card/pins";
import { appendBlocks, appendQuery, firstQuerySpec, readMeta } from "../src/docs/card";
import { addDays, localDate } from "../src/docs/ids";
import { backend } from "../src/platform";
import { newPinnedQueryCard, TASKS_QUERY } from "../src/query/pinned";
import { readSpec } from "../src/query/spec";
import { parse } from "../src/query/syntax";

const pinnedTitles = async () => (await backend.pinnedCards()).map((c) => c.title);

describe("a pin's place", () => {
  it("goes between its neighbours, or asks for all to be placed anew", () => {
    expect(pinBetween(100, 300, 999)).toBe(200);
    expect(pinBetween(100, 101, 999)).toBeNull();
    expect(pinBetween(null, 100, 999)).toBe(-900);
    // Last: now, or just after the one before when that is later.
    expect(pinBetween(100, null, 999)).toBe(999);
    expect(pinBetween(5000, null, 999)).toBe(5001);
    expect(pinBetween(null, null, 999)).toBe(999);
  });
});

describe("a card's query", () => {
  it("is found under other blocks, and is null without one", () => {
    const doc = new LoroDoc();
    expect(firstQuerySpec(doc)).toBeNull();
    appendBlocks(doc, ["intro"], false, null);
    appendQuery(doc, '{"v":1,"match":"all","where":[]}');
    appendQuery(doc, "second");
    doc.commit();
    expect(firstQuerySpec(doc)).toBe('{"v":1,"match":"all","where":[]}');
  });
});

describe("pinned query cards", () => {
  beforeAll(async () => {
    await startDocs();
  });

  it("are made from the task list in one step, and counted", async () => {
    const id = await newPinnedQueryCard("未完成任务", TASKS_QUERY.open);
    const h = await docs().open(id);
    expect(readMeta(h.doc).pinnedAt).not.toBeNull();
    expect(readSpec(firstQuerySpec(h.doc)).spec).toMatchObject({ where: [{ k: "task", v: ["open"] }], group: "day" });
    await docs().release(id);
    expect(await pinnedTitles()).toContain("未完成任务");

    // Two open tasks somewhere, one past its date.
    const other = await backend.createCard("项目");
    const o = await docs().open(other);
    appendBlocks(o.doc, ["[ ] 写周报", "[ ] 交材料", "[x] 做完了"], true, null);
    o.doc.commit();
    await o.persistence.flush();
    const late = addDays(localDate(new Date()), -2);
    const spec = (parse(TASKS_QUERY.open) as { ok: true; spec: Parameters<typeof countQuery>[0] }).spec;
    expect(await countQuery(spec, id)).toEqual({ count: 2, overdue: false });
    // One gets a deadline before today: the count says so.
    const { setTaskAttrs } = await import("../src/docs/card");
    const bid = (await backend.tasks(false, 10)).find((t) => t.text === "交材料")!.bid;
    setTaskAttrs(o.doc, bid, { deadline: late });
    o.doc.commit();
    await o.persistence.flush();
    await docs().release(other);
    expect(await countQuery(spec, id)).toEqual({ count: 2, overdue: true });

    // The sidebar's list knows it is a query, and how many.
    await usePins.getState().load();
    expect(usePins.getState().queries[id]).toEqual({ count: 2, overdue: true });
  });

  it("take the query's words as a title when pinned from a card with none", async () => {
    const id = await backend.createCard("");
    await pinQueryCard(id, "7 天内到期的任务");
    expect((await backend.pinnedCards()).find((c) => c.id === id)?.title).toBe("7 天内到期的任务");
    // A card with a title keeps it.
    const named = await backend.createCard("我的看板");
    await pinQueryCard(named, "别的名字");
    expect((await backend.pinnedCards()).find((c) => c.id === named)?.title).toBe("我的看板");
  });

  it("are dragged into another order, which stays", async () => {
    await usePins.getState().load();
    const before = await pinnedTitles();
    const last = usePins.getState().cards.at(-1)!;
    const first = usePins.getState().cards[0];
    await movePin(last.id, first.id);
    const after = await pinnedTitles();
    expect(after).toEqual([last.title, ...before.filter((t) => t !== last.title)]);
    // To the end again.
    await movePin(last.id, null);
    expect(await pinnedTitles()).toEqual(before);
  });

  it("are all placed anew when two have no room between them", async () => {
    const { setPinned } = await import("../src/docs/card");
    const ids = usePins.getState().cards.map((c) => c.id);
    // Pinned a millisecond apart (two devices, say).
    for (const [i, id] of ids.entries()) {
      const h = await docs().open(id);
      setPinned(h.doc, 10 + i);
      await h.persistence.flush();
      await docs().release(id);
    }
    const { cardsChanged } = await import("../src/card/actions");
    cardsChanged();
    await usePins.getState().load();
    const titles = await pinnedTitles();
    await movePin(ids.at(-1)!, ids[1]);
    expect(await pinnedTitles()).toEqual([titles[0], titles.at(-1), ...titles.slice(1, -1)]);
  });

  it("take a card out of the trash when it is pinned there (open in a tab)", async () => {
    const { setPin } = await import("../src/card/pins");
    const id = await backend.createCard("普通人如何做小红书");
    await backend.trashCard(id);
    await docs().refresh([id]);
    await setPin(id, true);
    expect((await backend.listTrash(50)).some((c) => c.id === id)).toBe(false);
    expect((await backend.pinnedCards()).some((c) => c.id === id)).toBe(true);
  });
});
