import { LoroDoc } from "loro-crdt";
import type { AssetEvent, BackupInfo, Backlink, CardRow, ChildBlock, JournalDay, SearchHit } from "../bindings/commands";
import { appendBlocks, bodyLines, initCard, preview, readCardTopics, readMeta, readProps, setClip, setDeleted, setInbox, setPinned } from "../docs/card";
import { isJournalId, journalDate, uuidv7 } from "../docs/ids";
import { extractIndex } from "../docs/index";
import { isBoardId } from "../docs/board";
import { WORKSPACE_ID } from "../docs/workspace";
import type { Backend } from "./backend";

/** The peer ids this fake host uses: its own replica and the one it hands to
 *  the frontend, like the Rust store does (§4.5 rule 3). */
const HOST_PEER = 2n;
export const MEMORY_FRONTEND_PEER = "1";
export const MEMORY_API_PEER = "3";

/** Web mode and tests: a host that keeps real Loro documents in memory, with
 *  the same behaviour as folio-store (single write path, trash, journal days).
 *  Everything is gone on reload. */
export function memoryBackend(now: () => number = Date.now): Backend {
  const docs = new Map<string, { doc: LoroDoc; updatedAt: number }>();
  /** Deleted for good: later updates are dropped, as the host does. */
  const purged = new Set<string>();
  const settings = new Map<string, unknown>();
  const backups: { info: BackupInfo; docs: Map<string, Uint8Array> }[] = [];
  /** Added files: hash → object URL. */
  const assets = new Map<string, string>();
  const assetListeners = new Set<(e: AssetEvent) => void>();

  const hostDoc = () => {
    const doc = new LoroDoc();
    doc.setPeerId(HOST_PEER);
    return doc;
  };

  const row = (id: string, e: { doc: LoroDoc; updatedAt: number }): CardRow => {
    const m = readMeta(e.doc);
    return { id, kind: m.kind, title: m.title, preview: cardPreview(e.doc), createdAt: m.createdAt, updatedAt: e.updatedAt };
  };

  /** The body's start; a clipped link with no notes shows its summary. */
  const cardPreview = (doc: LoroDoc) => preview(bodyLines(doc)) || preview([readMeta(doc).clip?.excerpt ?? ""]);

  /** Card documents: not the workspace document or whiteboards. */
  const cards = () => [...docs].filter(([id]) => id !== WORKSPACE_ID && !isBoardId(id));

  const rows = (keep: (meta: ReturnType<typeof readMeta>) => boolean) =>
    cards().filter(([, e]) => keep(readMeta(e.doc))).map(([id, e]) => row(id, e));

  /** Cards not in the trash. */
  const live = () => cards().filter(([, e]) => readMeta(e.doc).deletedAt === null);

  const edit = (id: string, f: (doc: LoroDoc) => void) => {
    const e = docs.get(id);
    if (!e) throw new Error(`unknown document ${id}`);
    f(e.doc);
    e.updatedAt = now();
  };

  return {
    kind: "memory",
    appInfo: async () => ({ version: "web", dataDir: "(memory)", frontendPeer: MEMORY_FRONTEND_PEER, apiPeer: MEMORY_API_PEER, platform: "web" }),
    listCards: async (limit = 200) =>
      rows((m) => m.deletedAt === null && m.kind !== "journal")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit),
    createCard: async (title) => {
      const id = uuidv7(now());
      const doc = hostDoc();
      initCard(doc, "note", title, now());
      docs.set(id, { doc, updatedAt: now() });
      return id;
    },
    docSnapshot: async (id) => docs.get(id)?.doc.export({ mode: "snapshot" }) ?? null,
    applyUpdate: async (id, _kind, bytes) => {
      if (purged.has(id)) return;
      const e = docs.get(id) ?? { doc: hostDoc(), updatedAt: 0 };
      e.doc.import(bytes);
      e.updatedAt = now();
      docs.set(id, e);
    },
    trashCard: async (id) => edit(id, (d) => setDeleted(d, now())),
    restoreCard: async (id) => edit(id, (d) => setDeleted(d, null)),
    pinCard: async (id, pinned) => edit(id, (d) => setPinned(d, pinned ? now() : null)),
    openLink: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    // A page cannot read other sites (CORS): web mode keeps the bare link.
    clipPreview: async (url) => {
      const u = url.trim();
      if (!/^https?:\/\/[^/?#\s]+/i.test(u)) throw new Error("[not-a-link] not a web address");
      const host = new URL(u).hostname.replace(/^www\./, "");
      return { url: u, title: host, site: host, excerpt: "", author: "", fetched: false };
    },
    clipCreate: async (title, clip, note) => {
      const id = uuidv7(now());
      const doc = hostDoc();
      initCard(doc, "note", title, now());
      setClip(doc, clip, now());
      if (note.trim()) {
        appendBlocks(doc, [note.trim()], false, null);
        doc.commit();
      }
      docs.set(id, { doc, updatedAt: now() });
      return id;
    },
    inbox: async () =>
      live()
        .filter(([, e]) => readMeta(e.doc).inboxAt !== null)
        .map(([id, e]) => {
          const m = readMeta(e.doc);
          return { id, title: m.title, preview: cardPreview(e.doc), clip: m.clip, inboxAt: m.inboxAt!, updatedAt: e.updatedAt };
        })
        .sort((a, b) => b.inboxAt - a.inboxAt),
    setInbox: async (id, inbox) => edit(id, (d) => setInbox(d, inbox ? now() : null)),
    takeShared: async () => null,
    toBackground: async () => {},
    tagCards: async (tag) => {
      const key = tag.trim().toLowerCase();
      return live()
        .filter(([id, e]) => !isJournalId(id) && extractIndex(e.doc).tags.some(([, name]) => name.trim().toLowerCase() === key))
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .map(([id, e]) => {
          const m = readMeta(e.doc);
          return { id, title: m.title, preview: cardPreview(e.doc), createdAt: m.createdAt, updatedAt: e.updatedAt, props: JSON.stringify(readProps(e.doc)), url: m.clip?.url ?? null };
        });
    },
    pinnedCards: async () =>
      cards()
        .filter(([, e]) => readMeta(e.doc).pinnedAt !== null && readMeta(e.doc).deletedAt === null)
        .sort(([, a], [, b]) => (readMeta(a.doc).pinnedAt ?? 0) - (readMeta(b.doc).pinnedAt ?? 0))
        .map(([id, e]) => row(id, e)),
    emptyTrash: async () => {
      const gone = cards()
        .filter(([id, e]) => readMeta(e.doc).deletedAt !== null && !isJournalId(id))
        .map(([id]) => id);
      for (const id of gone) {
        docs.delete(id);
        purged.add(id);
      }
      return gone;
    },
    listTrash: async (limit = 200) =>
      cards()
        .filter(([, e]) => readMeta(e.doc).deletedAt !== null)
        .sort(([, a], [, b]) => (readMeta(b.doc).deletedAt ?? 0) - (readMeta(a.doc).deletedAt ?? 0))
        .slice(0, limit)
        .map(([id, e]) => row(id, e)),
    journalDays: async (from, to) => {
      const days: JournalDay[] = [];
      for (const [id, e] of docs) {
        if (!isJournalId(id) || readMeta(e.doc).deletedAt !== null) continue;
        const date = journalDate(id);
        if (date < from || date > to) continue;
        days.push({ id, date, text: bodyLines(e.doc).join("\n"), updatedAt: e.updatedAt });
      }
      return days.sort((a, b) => (a.date < b.date ? 1 : -1));
    },
    backlinks: async (id) => {
      const own = new Set(docs.has(id) ? extractIndex(docs.get(id)!.doc).blocks.map((b) => b.bid) : []);
      const out: Backlink[] = [];
      for (const [cid, e] of live()) {
        if (cid === id) continue;
        const m = readMeta(e.doc);
        const x = extractIndex(e.doc);
        const text = (bid: string) => x.blocks.find((b) => b.bid === bid)?.text ?? "";
        const seen = new Set<string>();
        for (const [bid, to] of x.links) if (to === id && !seen.has(bid)) seen.add(bid), out.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid, text: text(bid), via: "link" });
        for (const [bid, to] of x.refs) if (own.has(to)) out.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid, text: text(bid), via: "ref" });
      }
      return out;
    },
    unlinkedReferences: async (id, limit = 50) => {
      const title = docs.has(id) ? readMeta(docs.get(id)!.doc).title.trim() : "";
      if ([...title].length < 2) return [];
      const out: Backlink[] = [];
      for (const [cid, e] of live()) {
        if (cid === id) continue;
        const m = readMeta(e.doc);
        const x = extractIndex(e.doc);
        const linked = new Set(x.links.filter(([, to]) => to === id).map(([b]) => b));
        for (const b of x.blocks) if (b.text.toLowerCase().includes(title.toLowerCase()) && !linked.has(b.bid)) out.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid: b.bid, text: b.text, via: "mention" });
      }
      return out.slice(0, limit);
    },
    search: async (query, limit = 30) => {
      // Every word must appear (as folio-store's search).
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const all = (text: string) => terms.every((t) => text.toLowerCase().includes(t));
      const titles: SearchHit[] = [];
      const blocks: SearchHit[] = [];
      for (const [cid, e] of live()) {
        const m = readMeta(e.doc);
        const clip = m.clip ? `\n${m.clip.site}\n${m.clip.author}\n${m.clip.excerpt}` : "";
        if (all(m.title + clip)) titles.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid: null, text: m.title });
        for (const b of extractIndex(e.doc).blocks) if (all(b.text)) blocks.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid: b.bid, text: b.text });
      }
      return [...titles, ...blocks].slice(0, limit);
    },
    blockTexts: async (bids) => {
      const want = new Set(bids);
      const out: { bid: string; cardId: string; text: string }[] = [];
      for (const [cid, e] of docs) for (const b of extractIndex(e.doc).blocks) if (want.has(b.bid)) out.push({ bid: b.bid, cardId: cid, text: b.text });
      return out;
    },
    titles: async (ids) => ids.filter((id) => docs.has(id)).map((id) => [id, readMeta(docs.get(id)!.doc).title] as [string, string]),
    getLocalSetting: async <T,>(key: string) => (settings.has(key) ? (structuredClone(settings.get(key)) as T) : null),
    setLocalSetting: async (key, value) => {
      settings.set(key, structuredClone(value));
    },
    exportDiagnostics: async () => null,
    exportMarkdown: async () => null,
    cardMarkdown: async () => null,
    exportCard: async () => null,
    saveTextFile: async () => null,
    tags: async (limit = 200) => {
      const by = new Map<string, { name: string; blocks: number; cards: Set<string>; lastUsed: number }>();
      for (const [cid, e] of [...live()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
        for (const [, name] of extractIndex(e.doc).tags) {
          const key = name.trim().toLowerCase();
          const t = by.get(key) ?? { name, blocks: 0, cards: new Set<string>(), lastUsed: 0 };
          // Oldest first, so the newest card's spelling wins.
          t.name = name;
          t.blocks += 1;
          t.cards.add(cid);
          t.lastUsed = e.updatedAt;
          by.set(key, t);
        }
      }
      return [...by]
        .map(([key, t]) => ({ key, name: t.name, blocks: t.blocks, cards: t.cards.size, lastUsed: t.lastUsed }))
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, limit);
    },
    topicCards: async (topic) =>
      [...live()]
        .filter(([, e]) => readCardTopics(e.doc).includes(topic))
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .map(([id, e]) => row(id, e)),
    cardTexts: async (ids) =>
      ids.flatMap((id) => {
        const e = docs.get(id);
        if (!e || isBoardId(id) || id === WORKSPACE_ID) return [];
        const m = readMeta(e.doc);
        return [{ id, title: m.title, text: bodyLines(e.doc).join("\n"), deleted: m.deletedAt !== null }];
      }),
    cardTopicPairs: async () => live().flatMap(([id, e]) => readCardTopics(e.doc).map((t): [string, string] => [id, t])),
    topicCounts: async () => {
      const counts = new Map<string, number>();
      for (const [, e] of live()) for (const t of readCardTopics(e.doc)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts].map(([id, cards]) => ({ id, cards }));
    },
    tagged: async (tag, limit = 500) => {
      const key = tag.trim().toLowerCase();
      const out: Backlink[] = [];
      for (const [cid, e] of [...live()].sort((a, b) => b[1].updatedAt - a[1].updatedAt)) {
        const x = extractIndex(e.doc);
        const bids = new Set(x.tags.filter(([, name]) => name.trim().toLowerCase() === key).map(([bid]) => bid));
        const m = readMeta(e.doc);
        for (const b of x.blocks) {
          if (!bids.has(b.bid)) continue;
          // Blocks come in document order, so the ones under it follow it.
          const children: ChildBlock[] = [];
          const depth = new Map([[b.bid, 0]]);
          for (const c of x.blocks.slice(x.blocks.indexOf(b) + 1)) {
            const d = c.parent === null ? undefined : depth.get(c.parent);
            if (d === undefined) break;
            depth.set(c.bid, d + 1);
            children.push({ bid: c.bid, depth: d + 1, text: c.text });
          }
          out.push({ cardId: cid, cardTitle: m.title, cardKind: m.kind, bid: b.bid, text: b.text, via: "tag", ...(children.length > 0 && { children }) });
        }
      }
      return out.slice(0, limit);
    },
    // Backups in memory, so restoring a card can be tried in web mode.
    listBackups: async () => backups.map((b) => b.info),
    backupNow: async () => {
      const at = now();
      const info = { name: `store-${at}.db`, createdAt: at, size: 0, safety: false, reason: null };
      backups.unshift({ info, docs: new Map([...docs].map(([id, e]) => [id, e.doc.export({ mode: "snapshot" })])) });
      return info;
    },
    restoreLibrary: async () => {
      throw new Error("not available in the browser");
    },
    revealBackups: async () => {},
    // The browser keeps the library in memory: nothing to move.
    libraryLocation: async () => ({ path: "(memory)", isDefault: true, fixed: true, cloudSynced: false, missing: null, defaultPath: null }),
    pickLibraryFolder: async () => null,
    moveLibrary: async () => {
      throw new Error("not available in the browser");
    },
    openLibrary: async () => {
      throw new Error("not available in the browser");
    },
    revealLibrary: async () => {},
    latestRelease: async () => {
      throw new Error("not available in the browser");
    },
    downloadUpdate: async () => {
      throw new Error("not available in the browser");
    },
    installUpdate: async () => {
      throw new Error("not available in the browser");
    },
    openReleaseDownload: async () => {},
    setAppearance: async () => {},
    // No server in the browser.
    mcpStatus: async () => null,
    setMcpEnabled: async () => {
      throw new Error("not available in the browser");
    },
    regenerateMcpToken: async () => {
      throw new Error("not available in the browser");
    },
    revokeMcpClient: async () => {
      throw new Error("not available in the browser");
    },
    answerMcpApproval: async () => {},
    syncStatus: async () => null,
    syncCreate: async () => {
      throw new Error("not available in the browser");
    },
    syncJoin: async () => {
      throw new Error("not available in the browser");
    },
    syncJoinRecovery: async () => {
      throw new Error("not available in the browser");
    },
    syncRecoveryCreate: async () => {
      throw new Error("not available in the browser");
    },
    syncRecoveryExists: async () => false,
    syncChangePassphrase: async () => {
      throw new Error("not available in the browser");
    },
    syncNow: async () => {},
    syncDisable: async () => {
      throw new Error("not available in the browser");
    },
    syncDevices: async () => [],
    syncRenameDevice: async () => {
      throw new Error("not available in the browser");
    },
    syncRemoveDevice: async () => {
      throw new Error("not available in the browser");
    },
    addAsset: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      const mime = file.type || "application/octet-stream";
      if (!assets.has(sha256)) assets.set(sha256, URL.createObjectURL(new Blob([bytes], { type: mime })));
      return { sha256, name: file.name, mime, size: bytes.byteLength };
    },
    assetUrl: (sha256) => assets.get(sha256) ?? "",
    openAsset: async (sha256) => {
      const url = assets.get(sha256);
      if (!url) throw new Error("[not-here] this file is not on this device");
      window.open(url, "_blank");
    },
    assetsHere: async (sha256s) => sha256s.filter((s) => assets.has(s)),
    // Nothing syncs here: a file not added in this session never comes.
    fetchAssets: async (sha256s) => {
      for (const sha256 of sha256s) {
        for (const l of assetListeners) l(assets.has(sha256) ? { sha256, ready: true } : { sha256, ready: false, reason: "no-sync" });
      }
    },
    onAssetEvent: (listener) => {
      assetListeners.add(listener);
      return () => assetListeners.delete(listener);
    },
  };
}
