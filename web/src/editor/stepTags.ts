import type { UndoManager } from "loro-crdt";
import { CARDS_CHANGED } from "../card/actions";
import { UNDO_MERGE_MS } from "../docs/hub";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";

/** Side effects in other documents that belong to one undo step of an
 *  editor's document (§5.1 cross-document undo). */
export type StepTag = { kind: "extract"; cardId: string; title: string };

const pending = new WeakMap<UndoManager, StepTag>();

/** The next undo step recorded by `undo` carries `tag`. The step must not be
 *  merged into earlier typing, so merging is off until it is recorded. */
export function tagNextStep(undo: UndoManager, tag: StepTag) {
  undo.setMergeInterval(0);
  pending.set(undo, tag);
}

export function takeStepTag(undo: UndoManager): StepTag | null {
  const tag = pending.get(undo);
  if (!tag) return null;
  pending.delete(undo);
  undo.setMergeInterval(UNDO_MERGE_MS);
  return tag;
}

export function onTaggedStep(tag: StepTag, undone: boolean) {
  if (tag.kind !== "extract") return;
  // Undoing an extraction puts the block back and the new card in the trash
  // (recoverable, never deleted); redoing it brings the card back.
  const run = undone ? backend.trashCard(tag.cardId) : backend.restoreCard(tag.cardId);
  run.then(
    () => {
      if (undone) useShell.getState().forgetCard(tag.cardId);
      window.dispatchEvent(new Event(CARDS_CHANGED));
    },
    (e) => useShell.getState().setNotice(i18n.t("error.generic", { message: String(e) })),
  );
}
