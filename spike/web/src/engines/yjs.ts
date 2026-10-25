import { Extension, type Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  redo,
  undo,
  yUndoPlugin,
  ySyncPlugin,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import { recordDrop } from "./drops";
import type { Engine, Peer } from "./types";

const REMOTE = "remote";
const FRAGMENT = "prosemirror";

class YjsPeer implements Peer {
  readonly engine = "yjs" as const;
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly undoManager: Y.UndoManager;

  private applyingRemote = false;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.fragment = doc.getXmlFragment(FRAGMENT);
    // While a remote update is rendered, y-prosemirror only writes back to
    // Yjs to delete items it could not render (see drops.ts).
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (this.applyingRemote && tr.origin === ySyncPluginKey && tr.deleteSet.clients.size > 0) {
        let chars = 0;
        const names: string[] = [];
        Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
          if (!(struct instanceof Y.Item)) return;
          const c = struct.content as { str?: string; type?: Y.AbstractType<unknown> };
          if (typeof c.str === "string") chars += c.str.length;
          else if (c.type instanceof Y.XmlElement || c.type instanceof Y.XmlText) {
            const t = c.type.toString().replace(/<[^>]*>/g, "");
            chars += t.length;
            names.push(c.type instanceof Y.XmlElement ? c.type.nodeName : "text");
          }
        });
        recordDrop(`yjs deleted unrenderable ${names.join(",") || "item"}`, chars);
      }
    });
    // captureTimeout 0 mirrors Loro's mergeInterval 0 (see loro.ts).
    this.undoManager = new Y.UndoManager(this.fragment, {
      trackedOrigins: new Set([ySyncPluginKey]),
      captureTimeout: 0,
    });
  }

  binding() {
    const fragment = this.fragment;
    const undoManager = this.undoManager;
    return Extension.create({
      name: "yjsBinding",
      addProseMirrorPlugins() {
        return [ySyncPlugin(fragment), yUndoPlugin({ undoManager })];
      },
    });
  }

  isRemoteTx(tr: Transaction) {
    const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
    return !!meta?.isChangeOrigin;
  }

  undo(editor: Editor) {
    return undo(editor.state);
  }

  clearHistory() {
    this.undoManager.clear();
  }

  redo(editor: Editor) {
    return redo(editor.state);
  }

  onLocalUpdate(cb: (u: Uint8Array) => void) {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) cb(update);
    };
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  importUpdate(update: Uint8Array) {
    this.applyingRemote = true;
    try {
      Y.applyUpdate(this.doc, update, REMOTE);
    } finally {
      this.applyingRemote = false;
    }
  }

  version() {
    return Y.encodeStateVector(this.doc);
  }

  exportSince(remote: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, remote);
  }

  snapshot() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Yjs already GCs deleted content in memory (gc: true), so the encoded
   * state is the compacted form; the persisted update log is what shrinks. */
  compact() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  headlessJSON(schema: Schema) {
    if (this.fragment.length === 0) return null;
    return yXmlFragmentToProseMirrorRootNode(this.fragment, schema).toJSON();
  }
}

export const yjsEngine: Engine = {
  name: "yjs",
  createPeer: () => new YjsPeer(new Y.Doc()),
  loadPeer: (bytes) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes, REMOTE);
    return new YjsPeer(doc);
  },
};
