// Renaming a tag, or merging it into another (design/inbox-and-tags.md §3).
// Every `#from` in every document (journal days and the trash too) is
// renamed in place; then the tag's fields go to the new name: fields both
// tags have become one, the rest move across. Each step only adds or
// renames, so an interrupted rename finishes when run again.

import { docs } from "../app";
import { cardsChanged } from "../card/actions";
import { readProps, renameTagIn, setProp, TAG_RENAME_ORIGIN } from "../docs/card";
import { moveFields, pairedValues, pairFields } from "../docs/database";
import { workspaceDoc } from "../docs/topics";
import { TAG_STOP } from "../editor/tag";
import { backend } from "../platform";

/** A name as typed, without a leading `#`. */
export const cleanTagName = (name: string) => name.trim().replace(/^#+/, "").trim();

/** Whether `name` can be a tag: what typing `#name ` would make one of. */
export const validTagName = (name: string) => name.length > 0 && !new RegExp(`[${TAG_STOP}]`).test(name);

/** Renames `from` to `to` everywhere; `to` may be a tag in use (a merge).
 *  Answers how many places now say `#to`. */
export async function renameTag(from: string, to: string): Promise<number> {
  const ws = await workspaceDoc();
  const merges = pairFields(ws.doc, from, to);
  const hub = docs();
  let changed = 0;
  for (const id of await backend.tagDocs(from)) {
    const h = await hub.open(id);
    try {
      const n = renameTagIn(h.doc, from, to);
      if (n > 0) h.doc.commit({ origin: TAG_RENAME_ORIGIN });
      for (const [field, value] of Object.entries(pairedValues(readProps(h.doc), merges))) setProp(h.doc, field, value);
      await h.persistence.flush();
      changed += n;
    } finally {
      await hub.release(id);
    }
  }
  moveFields(ws.doc, from, to, merges);
  cardsChanged();
  return changed;
}
