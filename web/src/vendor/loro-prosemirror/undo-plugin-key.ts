import type { LoroDoc, UndoManager, Value } from "loro-crdt";
import { PluginKey } from "@tiptap/pm/state";

export const loroUndoPluginKey = new PluginKey<LoroUndoPluginState>(
  "loro-undo",
);

export interface LoroUndoPluginProps {
  doc: LoroDoc;
  undoManager?: UndoManager;
  /** folio patch: called when a new undo step is recorded; a non-null result
   *  is stored with the step and follows it between the undo and redo stacks. */
  takeStepTag?: () => Value | null;
  /** folio patch: a tagged step was undone (`undone` true) or redone. */
  onTaggedStep?: (tag: Value, undone: boolean) => void;
}

export interface LoroUndoPluginState {
  undoManager: UndoManager;
  canUndo: boolean;
  canRedo: boolean;
  isUndoing: { current: boolean };
}
