// The semantic API (first version): what commands, plugins, the MCP server
// and AI features use to read and write notes without an editor
// (design/ARCHITECTURE.md §0.3, §8 M1a). Every write records its provenance.

import { LoroDoc } from "loro-crdt";
import type { CardRow } from "../bindings/commands";
import { appendBlocks, bodyLines, initCard, readMeta, type CardMeta } from "../docs/card";
import type { DocHub } from "../docs/hub";
import { journalId, uuidv7 } from "../docs/ids";
import type { Backend } from "../platform/backend";

/** "human", "ai:<model>" or "import:<source>". */
export type Source = string;

export interface CardContent extends CardMeta {
  id: string;
  /** One line per block; tabs mark outline depth. */
  lines: string[];
}

export interface NotesApi {
  listCards(limit?: number): Promise<CardRow[]>;
  readCard(id: string): Promise<CardContent>;
  /** Creates a card; returns its id. */
  createCard(input: { title: string; lines?: string[]; source: Source }): Promise<string>;
  /** Adds lines to a journal day (`YYYY-MM-DD`) as outline items. */
  appendToJournal(date: string, lines: string[], source: Source): Promise<void>;
}

/** `peer` is the API replica's own peer id (`appInfo().apiPeer`): it edits
 *  next to the editors' replica, so it must not share theirs (§4.5 rule 3).
 *  Calls are serialised so one API replica is alive at a time. */
export function createNotesApi(hub: DocHub, backend: Backend, peer: string, now: () => number = Date.now): NotesApi {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => {});
    return run;
  };

  /** Applies `edit` to a copy of the open document, then brings the change
   *  into the shared replica (open editors show it as an incoming change)
   *  and onto the host. */
  const write = (id: string, edit: (doc: LoroDoc) => void) =>
    serial(async () => {
      const handle = await hub.open(id);
      try {
        const copy = new LoroDoc();
        copy.setPeerId(BigInt(peer));
        copy.import(handle.doc.export({ mode: "snapshot" }));
        edit(copy);
        copy.commit({ origin: "api" });
        handle.doc.import(copy.export({ mode: "update", from: handle.doc.oplogVersion() }));
        // Everything the host has not confirmed yet, so a new journal day
        // arrives complete with its metadata.
        await backend.applyUpdate(id, "card", handle.doc.export({ mode: "update", from: handle.persistence.savedVersion }));
      } finally {
        await hub.release(id);
      }
    });

  return {
    listCards: (limit) => backend.listCards(limit),

    readCard: async (id) => {
      const handle = await hub.open(id);
      try {
        return { id, ...readMeta(handle.doc), lines: bodyLines(handle.doc) };
      } finally {
        await hub.release(id);
      }
    },

    createCard: ({ title, lines = [], source }) =>
      serial(async () => {
        const id = uuidv7(now());
        const doc = new LoroDoc();
        doc.setPeerId(BigInt(peer));
        initCard(doc, "note", title, now(), source);
        appendBlocks(doc, lines, false, source === "human" ? null : source);
        doc.commit({ origin: "api" });
        await backend.applyUpdate(id, "card", doc.export({ mode: "snapshot" }));
        return id;
      }),

    appendToJournal: (date, lines, source) =>
      write(journalId(date), (doc) => appendBlocks(doc, lines, true, source === "human" ? null : source)),
  };
}
