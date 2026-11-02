import { LoroDoc, UndoManager } from "loro-crdt";
import { recordTimes } from "./history";
import type { Backend } from "../platform/backend";
import { initCard, META_ORIGIN, TAG_RENAME_ORIGIN } from "./card";
import { afterComposition, trackComposition } from "./composition";
import { isJournalId } from "./ids";
import { Persistence } from "./persistence";
import { WORKSPACE_ID } from "./workspace";
import { isBoardId } from "./board";
import { hasMessages } from "./chat";

/** Typing within this window is undone as one step. */
export const UNDO_MERGE_MS = 500;

/** One open document: the frontend replica, its write path and undo history. */
export interface DocHandle {
  readonly id: string;
  readonly doc: LoroDoc;
  readonly persistence: Persistence;
  /** Local undo for this document (§5.1); metadata edits are excluded. */
  readonly undo: UndoManager;
}

interface Entry {
  handle: Promise<DocHandle>;
  refs: number;
  /** Released by everyone, closing after the grace period. */
  closing?: ReturnType<typeof setTimeout>;
}

/** Opens each document once and shares the replica between its users.
 *  Several editors may bind to one replica (the same card in both panes of
 *  a split view); they share its undo history. */
export class DocHub {
  private readonly entries = new Map<string, Entry>();
  /** Replicas closed but still writing their last changes (or trying to). */
  private readonly closing = new Map<string, Promise<DocHandle>>();

  constructor(
    private readonly backend: Backend,
    /** This device's frontend peer id (§4.5 rule 3), from `appInfo`. */
    private readonly peer: string,
    private readonly onError: (e: unknown) => void = console.error,
    private readonly now: () => number = Date.now,
    /** A released document stays open this long: editors are destroyed a
     *  moment after their view unmounts and must not find the undo history
     *  freed, and a tab moved to the other pane keeps its history. */
    private readonly closeDelayMs = 0,
  ) {
    trackComposition();
  }

  /** `as`: what a bare id holds when it may not exist yet (a new chat). */
  open(id: string, as?: "chat"): Promise<DocHandle> {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { handle: this.load(id, as), refs: 0 };
      this.entries.set(id, entry);
      // A failed load must not stay cached.
      entry.handle.catch(() => this.entries.delete(id));
    }
    entry.refs++;
    clearTimeout(entry.closing);
    entry.closing = undefined;
    return entry.handle;
  }

  /** Releases one `open`; the last release saves and closes the replica
   *  (after the grace period, when there is one). */
  async release(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || --entry.refs > 0) return;
    if (this.closeDelayMs > 0) {
      entry.closing = setTimeout(() => void this.close(id, entry).catch(this.onError), this.closeDelayMs);
      return;
    }
    await this.close(id, entry);
  }

  private async close(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry || entry.refs > 0) return;
    this.entries.delete(id);
    const done = entry.handle.then(async (handle) => {
      handle.undo.free();
      await handle.persistence.dispose();
      return handle;
    });
    // Opened again meanwhile, the new replica waits for this one (load),
    // or takes over its changes when they could not be written: until
    // then it stays here, trying again.
    this.closing.set(id, done);
    const forget = () => this.closing.get(id) === done && this.closing.delete(id);
    done.then((h) => !h.persistence.dirty && forget(), forget);
    await done;
  }

  /** Saves every open document now (window hidden or closing). */
  async flushAll(): Promise<void> {
    const handles = await Promise.all([...this.entries.values()].map((e) => e.handle.catch(() => null)));
    await Promise.all(handles.map((h) => h?.persistence.flush()));
  }

  /** Another device changed these documents (sync): open replicas take
   *  the host's copy; editors bound to them update as for any import, once
   *  no input method is composing. */
  async refresh(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const entry = this.entries.get(id);
        if (!entry) return;
        const handle = await entry.handle.catch(() => null);
        await afterComposition();
        const snapshot = handle && (await this.backend.docSnapshot(id));
        if (handle && snapshot && this.entries.get(id) === entry) handle.persistence.mergeHost(snapshot);
      }),
    );
  }

  isOpen(id: string) {
    return this.entries.has(id);
  }

  private async load(id: string, as?: "chat"): Promise<DocHandle> {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(this.peer));
    // Dated edits, for the card's history (docs/history.ts).
    recordTimes(doc);
    // A replica of this document still writing its last changes is waited
    // for: started from the host's older copy, this one would reuse the
    // ids of the edits not yet there (same peer), and the host would reject
    // both. What it could not write, this one takes over.
    const closing = this.closing.get(id);
    const prior = await closing?.catch(() => null);
    if (closing && this.closing.get(id) === closing) this.closing.delete(id);
    const handoff = prior?.persistence.dirty ? prior : null;
    if (handoff) {
      handoff.persistence.stop();
      doc.import(handoff.doc.export({ mode: "snapshot" }));
    }
    const snapshot = await this.backend.docSnapshot(id);
    const workspace = id === WORKSPACE_ID;
    const board = isBoardId(id);
    const chat = as === "chat";
    let born = true;
    if (snapshot) {
      doc.import(snapshot);
    } else if (workspace || board || chat) {
      // Made on first use; written once it holds something.
      born = false;
    } else if (isJournalId(id)) {
      // Started here; written to disk only once it has content (§5.2a).
      if (!handoff) initCard(doc, "journal", "", this.now());
      born = false;
    } else if (handoff) {
      born = false;
    } else {
      throw new Error(`unknown document ${id}`);
    }
    // On a whiteboard every action (a move, a colour, a delete) is its own
    // step; typing merges within the window.
    const undo = new UndoManager(doc, { mergeInterval: board ? 0 : UNDO_MERGE_MS, maxUndoSteps: 500 });
    undo.addExcludeOriginPrefix(META_ORIGIN);
    undo.addExcludeOriginPrefix(TAG_RENAME_ORIGIN);
    const persistence = new Persistence(id, doc, this.backend, {
      born: born || !!handoff?.persistence.isBorn,
      ...(handoff ? { saved: handoff.persistence.savedVersion } : {}),
      onError: this.onError,
      // Written once it lists anything: a topic, a whiteboard, a template, a chat.
      ...(workspace ? { kind: "workspace" as const, hasContent: (d: LoroDoc) => ["topics", "boards", "templates", "chats", "ai"].some((k) => d.getMap(k).size > 0) } : {}),
      ...(board ? { kind: "board" as const, hasContent: (d: LoroDoc) => d.getMap("items").size > 0 } : {}),
      // A chat is stored as a whiteboard (docs/chat.ts).
      ...(chat ? { kind: "board" as const, hasContent: hasMessages } : {}),
    });
    return { id, doc, persistence, undo };
  }
}
