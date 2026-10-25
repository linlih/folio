import { Extension, type Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { LoroDoc, UndoManager, VersionVector } from "loro-crdt";
import {
  createNodeFromLoroObj,
  LoroSyncPlugin,
  loroSyncPluginKey,
  LoroUndoPlugin,
  redo,
  ROOT_DOC_KEY,
  undo,
  type LoroDocType,
  type LoroNode,
} from "loro-prosemirror";
import { watchConsoleForLoroDrops } from "./drops";
import type { Engine, Peer } from "./types";

watchConsoleForLoroDrops();

class LoroPeer implements Peer {
  readonly engine = "loro" as const;
  readonly doc: LoroDoc;
  readonly undoManager: UndoManager;

  constructor(doc: LoroDoc) {
    this.doc = doc;
    // mergeInterval 0: every transaction is its own undo step, which keeps the
    // scripted tests deterministic. The real app would use ~500ms.
    this.undoManager = new UndoManager(doc, { mergeInterval: 0 });
  }

  binding() {
    const doc = this.doc as unknown as LoroDocType;
    const undoManager = this.undoManager;
    return Extension.create({
      name: "loroBinding",
      addProseMirrorPlugins() {
        return [LoroSyncPlugin({ doc }), LoroUndoPlugin({ doc, undoManager })];
      },
    });
  }

  isRemoteTx(tr: Transaction) {
    const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined;
    return meta?.type === "non-local-updates" || meta?.type === "update-state";
  }

  undo(editor: Editor) {
    return undo(editor.state, editor.view.dispatch, editor.view);
  }

  clearHistory() {
    this.undoManager.clear();
  }

  redo(editor: Editor) {
    return redo(editor.state, editor.view.dispatch, editor.view);
  }

  onLocalUpdate(cb: (u: Uint8Array) => void) {
    return this.doc.subscribeLocalUpdates(cb);
  }

  importUpdate(update: Uint8Array) {
    this.doc.import(update);
  }

  version() {
    return this.doc.oplogVersion().encode();
  }

  exportSince(remote: Uint8Array) {
    return this.doc.export({ mode: "update", from: VersionVector.decode(remote) });
  }

  snapshot() {
    return this.doc.export({ mode: "snapshot" });
  }

  compact() {
    return this.doc.export({ mode: "shallow-snapshot", frontiers: this.doc.oplogFrontiers() });
  }

  headlessJSON(schema: Schema) {
    const root = this.doc.getMap(ROOT_DOC_KEY) as unknown as LoroNode;
    if (root.size === 0) return null;
    return createNodeFromLoroObj(schema, root, new Map()).toJSON();
  }
}

export const loroEngine: Engine = {
  name: "loro",
  createPeer: () => new LoroPeer(new LoroDoc()),
  loadPeer: (bytes) => new LoroPeer(LoroDoc.fromSnapshot(bytes)),
};
