import type { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export type EngineName = "loro" | "yjs";

/** One replica of one card document. Mirrors the Rust-side `DocEngine`. */
export interface Peer {
  readonly engine: EngineName;
  /** TipTap extension wiring the CRDT into the editor (sync + undo). */
  binding(): Extension;
  /** True when a transaction was produced by applying a remote update. */
  isRemoteTx(tr: Transaction): boolean;
  undo(editor: Editor): boolean;
  /** Forget local undo history (e.g. after the card's initial content). */
  clearHistory(): void;
  redo(editor: Editor): boolean;
  /** Subscribe to updates produced by local edits. */
  onLocalUpdate(cb: (update: Uint8Array) => void): () => void;
  importUpdate(update: Uint8Array): void;
  /** Encoded version (Loro version vector / Yjs state vector). */
  version(): Uint8Array;
  exportSince(remoteVersion: Uint8Array): Uint8Array;
  /** Full state including history. */
  snapshot(): Uint8Array;
  /** Smallest state that can still accept future updates. */
  compact(): Uint8Array;
  /** ProseMirror JSON rebuilt from CRDT state alone, without the editor. */
  headlessJSON(schema: Schema): unknown;
}

export interface Engine {
  readonly name: EngineName;
  createPeer(): Peer;
  /** Load a peer from a snapshot or compacted state. */
  loadPeer(bytes: Uint8Array): Peer;
}
