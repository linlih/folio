import { Extension } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { LoroDoc, UndoManager } from "loro-crdt";
import { onTaggedStep, takeStepTag, type StepTag } from "./stepTags";
import { LoroSyncPlugin, LoroUndoPlugin, loroSyncPluginKey, type LoroDocType } from "../vendor/loro-prosemirror";

/** True for transactions that apply remote or initial Loro state. */
export function isRemoteTx(tr: Transaction): boolean {
  const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined;
  return meta?.type === "non-local-updates" || meta?.type === "update-state";
}

/** True for the transaction that loads the document into the editor; edits
 *  before it would conflict with the content (§5.1 point 1). */
export function isBindTx(tr: Transaction): boolean {
  return (tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined)?.type === "update-state";
}

export function LoroBinding(doc: LoroDoc, undoManager: UndoManager) {
  const d = doc as unknown as LoroDocType;
  return Extension.create({
    name: "loroBinding",
    addProseMirrorPlugins() {
      return [
        LoroSyncPlugin({ doc: d }),
        LoroUndoPlugin({
          doc: d,
          undoManager,
          takeStepTag: () => takeStepTag(undoManager),
          onTaggedStep: (tag, undone) => onTaggedStep(tag as StepTag, undone),
        }),
      ];
    },
  });
}
