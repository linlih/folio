// Restoring a card to a backup's version (design/ARCHITECTURE.md §5.4): the
// live document is reverted to the version the backup holds, as one new
// edit. It syncs like any edit and Mod+Z undoes it. Nothing is replaced.

import { LoroDoc } from "loro-crdt";
import { APP_EDIT_ORIGIN } from "../vendor/loro-prosemirror";
import type { DocHandle } from "./hub";

export const RESTORE_ORIGIN = `${APP_EDIT_ORIGIN}restore`;

/** Reverts `handle`'s document to the version in `snapshot` (the same
 *  document as a backup has it). Edits the backup lacks are undone; content
 *  it has and this replica somehow lacks is brought back first. */
export function restoreVersion(handle: DocHandle, snapshot: Uint8Array) {
  const old = new LoroDoc();
  old.import(snapshot);
  const version = old.oplogFrontiers();
  const { doc } = handle;
  doc.import(snapshot);
  doc.setNextCommitOrigin(RESTORE_ORIGIN);
  doc.revertTo(version);
  doc.commit({ origin: RESTORE_ORIGIN });
}
