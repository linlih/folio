import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { readMeta, readProps, setClip, setInbox, setProp } from "../src/docs/card";
import { firstUrl, noteFrom, saveClip } from "../src/inbox/clip";
import { backend } from "../src/platform";
import { memoryBackend } from "../src/platform/memory";

describe("finding the link in shared text", () => {
  it("takes the first link and keeps the words around it", () => {
    expect(firstUrl("https://github.com/loro-dev/loro")).toEqual({ url: "https://github.com/loro-dev/loro", rest: "" });
    expect(firstUrl("Loro 文档\nhttps://loro.dev/docs?x=1#y")).toEqual({ url: "https://loro.dev/docs?x=1#y", rest: "Loro 文档" });
    // Chinese share text runs straight into the link and ends in punctuation.
    expect(firstUrl("看看这个：https://mp.weixin.qq.com/s/AbC_d-9，很有意思")?.url).toBe("https://mp.weixin.qq.com/s/AbC_d-9");
    expect(firstUrl("(see https://x.com/a/status/1).")?.url).toBe("https://x.com/a/status/1");
    expect(firstUrl("no link here")).toBeNull();
    expect(firstUrl("ftp://example.com")).toBeNull();
  });

  it("drops a note that only repeats the title", () => {
    expect(noteFrom("Loro – CRDTs", "Loro – CRDTs")).toBe("");
    expect(noteFrom("loro-dev/loro", "loro-dev/loro: Make your JSON data collaborative")).toBe("");
    expect(noteFrom("周末读一下", "loro-dev/loro: Make your JSON data collaborative")).toBe("周末读一下");
    expect(noteFrom("", "x")).toBe("");
  });
});

describe("the inbox", () => {
  it("keeps a link as a card until it is dealt with", async () => {
    let t = 1000;
    const b = memoryBackend(() => t++);
    const p = await b.clipPreview(" https://www.example.org/a ");
    expect(p).toMatchObject({ url: "https://www.example.org/a", title: "example.org", site: "example.org", fetched: false });
    await expect(b.clipPreview("not a link")).rejects.toThrow("[not-a-link]");
    const a = await b.clipCreate("A page", { url: "https://a.com", site: "a.com", excerpt: "What it says", author: "" }, "");
    const c = await b.clipCreate("Another", { url: "https://c.com", site: "c.com", excerpt: "", author: "" }, "my note");
    expect((await b.inbox()).map((i) => [i.id, i.preview])).toEqual([
      [c, "my note"],
      [a, "What it says"],
    ]);
    // Found by its summary; listed in the library with it as the preview.
    expect((await b.search("what it")).map((h) => h.cardId)).toEqual([a]);
    expect((await b.listCards()).find((r) => r.id === a)?.preview).toBe("What it says");
    await b.setInbox(a, false);
    expect((await b.inbox()).map((i) => i.id)).toEqual([c]);
    await b.trashCard(c);
    expect(await b.inbox()).toEqual([]);
  });

  it("saves pasted or shared text: a link, or a plain note", async () => {
    const before = (await backend.inbox()).length;
    const { id, fetched } = await saveClip("值得一读\nhttps://example.com/post");
    expect(fetched).toBe(false);
    const item = (await backend.inbox()).find((i) => i.id === id)!;
    // The page could not be read here (web mode): the words become the title.
    expect(item.title).toBe("值得一读");
    expect(item.clip?.url).toBe("https://example.com/post");
    const note = await saveClip("一个想法\n第二行");
    const noteItem = (await backend.inbox()).find((i) => i.id === note.id)!;
    expect([noteItem.title, noteItem.clip]).toEqual(["一个想法", null]);
    expect(noteItem.preview).toContain("第二行");
    expect((await backend.inbox()).length).toBe(before + 2);
    await expect(saveClip("   ")).rejects.toThrow();
  });
});

describe("card fields", () => {
  it("reads and writes the clip, the inbox mark and database fields", () => {
    const doc = new LoroDoc();
    expect(readMeta(doc)).toMatchObject({ clip: null, inboxAt: null });
    setClip(doc, { url: "https://a.com", site: "a.com", excerpt: "", author: "" }, 5);
    expect(readMeta(doc)).toMatchObject({ clip: { url: "https://a.com", site: "a.com", excerpt: "", author: "" }, inboxAt: 5 });
    setInbox(doc, null);
    expect(readMeta(doc).inboxAt).toBeNull();
    setProp(doc, "status", "在读");
    setProp(doc, "rating", 4);
    setProp(doc, "tags", ["a", "b"]);
    expect(readProps(doc)).toEqual({ status: "在读", rating: 4, tags: ["a", "b"] });
    setProp(doc, "status", "");
    setProp(doc, "tags", []);
    expect(readProps(doc)).toEqual({ rating: 4 });
  });

  it("merges fields filled on two devices", () => {
    const a = new LoroDoc();
    a.setPeerId(1n);
    const b = new LoroDoc();
    b.setPeerId(2n);
    setProp(a, "status", "在读");
    setProp(b, "rating", 5);
    a.import(b.export({ mode: "update" }));
    b.import(a.export({ mode: "update" }));
    expect(readProps(a)).toEqual({ status: "在读", rating: 5 });
    expect(readProps(b)).toEqual(readProps(a));
  });
});
