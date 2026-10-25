import { describe, expect, it } from "vitest";
import { initCard } from "../src/docs/card";
import { DocHub } from "../src/docs/hub";
import { linkInBlock, linkMention, unlinkInBlock } from "../src/editor/linkMention";
import { memoryBackend, MEMORY_FRONTEND_PEER } from "../src/platform/memory";
import { bind, device, settle } from "./helpers";

const target = { cardId: "card-target", title: "Zettelkasten" };

async function editor(html: string) {
  const doc = device(1n);
  initCard(doc, "note", "", 1);
  const { editor } = await bind(doc);
  editor.commands.setContent(html);
  await settle();
  return editor;
}

const bidOf = (e: Awaited<ReturnType<typeof editor>>, text: string) => {
  let bid = "";
  e.state.doc.descendants((n) => {
    if (!bid && n.isBlock && n.attrs.bid && n.textContent.startsWith(text)) bid = n.attrs.bid as string;
  });
  return bid;
};

const links = (e: Awaited<ReturnType<typeof editor>>) => {
  const out: string[] = [];
  e.state.doc.descendants((n) => void (n.type.name === "cardLink" && out.push(n.attrs.title as string)));
  return out;
};

describe("linking an unlinked mention", () => {
  it("turns the first mention in the block into a link, ignoring case", async () => {
    const e = await editor("<p>I use the zettelkasten method; Zettelkasten again.</p>");
    const tr = linkInBlock(e.state, bidOf(e, "I use"), target)!;
    e.view.dispatch(tr);
    expect(links(e)).toEqual(["Zettelkasten"]);
    expect(e.state.doc.textContent).toBe("I use the  method; Zettelkasten again.");
  });

  it("matches across marks, and only in the item's own line, not its children", async () => {
    const e = await editor("<ul><li><p>parent</p><ul><li><p>child Zettelkasten</p></li></ul></li><li><p>about <strong>Zettel</strong>kasten</p></li></ul>");
    expect(linkInBlock(e.state, bidOf(e, "parent"), target)).toBeNull();
    e.view.dispatch(linkInBlock(e.state, bidOf(e, "about"), target)!);
    expect(links(e)).toEqual(["Zettelkasten"]);
  });

  it("unlinking puts the title back as text", async () => {
    const e = await editor("<p>See zettelKasten here</p>");
    const bid = bidOf(e, "See");
    const tr = linkInBlock(e.state, bid, target)!;
    expect(tr.getMeta("linkedText")).toBe("zettelKasten");
    e.view.dispatch(tr);
    e.view.dispatch(unlinkInBlock(e.state, bid, target.cardId, "zettelKasten")!);
    expect(links(e)).toEqual([]);
    expect(e.state.doc.textContent).toBe("See zettelKasten here");
    expect(unlinkInBlock(e.state, bid, target.cardId)).toBeNull();
  });

  it("finds nothing once the block no longer mentions it", async () => {
    const e = await editor("<p>nothing here</p>");
    expect(linkInBlock(e.state, bidOf(e, "nothing"), target)).toBeNull();
    expect(linkInBlock(e.state, "no-such-block", target)).toBeNull();
  });

  it("links a card that is not open, and the mention becomes a backlink", async () => {
    const backend = memoryBackend();
    const hub = new DocHub(backend, MEMORY_FRONTEND_PEER);
    const targetId = await backend.createCard("Zettelkasten");
    const sourceId = await backend.createCard("Reading notes");
    const handle = await hub.open(sourceId);
    const { editor: e } = await bind(handle.doc, handle.undo);
    e.commands.setContent("<p>Trying the Zettelkasten method</p>");
    await settle();
    e.destroy();
    await handle.persistence.flush();
    await hub.release(sourceId);

    const [mention] = await backend.unlinkedReferences(targetId);
    expect(mention.cardId).toBe(sourceId);
    expect(await linkMention(hub, sourceId, mention.bid, { cardId: targetId, title: "Zettelkasten" })).toBe("Zettelkasten");
    // Saved through the document's own write path.
    await (await hub.open(sourceId)).persistence.flush();
    await hub.release(sourceId);
    expect(await backend.unlinkedReferences(targetId)).toEqual([]);
    expect((await backend.backlinks(targetId)).map((b) => b.cardId)).toEqual([sourceId]);
  });
});
