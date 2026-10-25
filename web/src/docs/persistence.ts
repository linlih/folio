import { LoroDoc, type VersionVector } from "loro-crdt";
import type { DocKind } from "../bindings/commands";
import type { Backend } from "../platform/backend";
import { hasContent } from "./card";

export interface PersistenceOptions {
  /** Batching window; unsaved edits are lost at most this long (§5.1). */
  delay?: number;
  /** False for a journal day that does not exist on disk yet: nothing is
   *  written until the body has content (§5.2a). */
  born?: boolean;
  /** What the host stores it as; a card unless said otherwise. */
  kind?: DocKind;
  /** When an unborn document has enough to write (a card: body content). */
  hasContent?: (doc: LoroDoc) => boolean;
  onError?: (e: unknown) => void;
}

const RETRY_MS = 2000;

/** Fired on window after a document's changes reached the host. */
export const DOC_SAVED = "folio:doc-saved";

/** The only path from a frontend replica to the host (§5.1). Each write sends
 *  everything since the last confirmed write, so a failed write loses nothing:
 *  the next one carries it again. */
export class Persistence {
  private saved: VersionVector;
  private born: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly delay: number;

  constructor(
    private readonly id: string,
    private readonly doc: LoroDoc,
    private readonly backend: Backend,
    private readonly opts: PersistenceOptions = {},
  ) {
    this.delay = opts.delay ?? 300;
    this.born = opts.born ?? true;
    // A document the host has never seen is written from the beginning.
    this.saved = this.born ? doc.oplogVersion() : new LoroDoc().oplogVersion();
    this.unsubscribe = doc.subscribeLocalUpdates(() => this.schedule(this.delay));
  }

  /** Everything the host has confirmed. */
  get savedVersion(): VersionVector {
    return this.saved;
  }

  /** True while there are local changes the host has not confirmed. */
  get dirty(): boolean {
    return this.doc.oplogVersion().compare(this.saved) !== 0;
  }

  /** Writes now; resolves when everything so far is on the host. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  /** Brings in the host's copy after another device changed it (sync).
   *  The host has everything saved here, so when nothing is unsaved its
   *  version becomes the saved one; otherwise the next write carries some
   *  of the host's own changes back, which it ignores. */
  mergeHost(snapshot: Uint8Array) {
    const clean = this.born && !this.dirty;
    this.doc.import(snapshot);
    if (clean) this.saved = this.doc.oplogVersion();
    // A journal day started here and written elsewhere now exists.
    this.born = true;
  }

  /** Stops listening after a last write. */
  dispose(): Promise<void> {
    this.unsubscribe();
    return this.flush();
  }

  private schedule(ms: number) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private async write() {
    if (!this.born) {
      if (!(this.opts.hasContent ?? hasContent)(this.doc)) return;
      this.born = true;
    }
    const to = this.doc.oplogVersion();
    if (to.compare(this.saved) === 0) return;
    const bytes = this.doc.export({ mode: "update", from: this.saved });
    try {
      await this.backend.applyUpdate(this.id, this.opts.kind ?? "card", bytes);
      this.saved = to;
      // The host re-indexed the card: titles, block texts and backlinks
      // shown elsewhere may have changed.
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DOC_SAVED, { detail: { id: this.id } }));
    } catch (e) {
      this.opts.onError?.(e);
      this.schedule(RETRY_MS);
    }
  }
}
