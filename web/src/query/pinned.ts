// A query kept in the sidebar (design/query.md §13): a plain card holding
// a query block, pinned. Made in one step from the task list.

import { docs } from "../app";
import { cardsChanged } from "../card/actions";
import { setPin } from "../card/pins";
import { appendQuery } from "../docs/card";
import { backend } from "../platform";
import { writeSpec } from "./spec";
import { parse } from "./syntax";

/** The task list's tabs as queries (tasks/TasksView.tsx). */
export const TASKS_QUERY = {
  open: "task:open group:day sort:due",
  closed: "task:done,canceled sort:-updated",
} as const;

/** A new card titled `title` holding the query `text`, pinned to the
 *  sidebar. Answers its id. */
export async function newPinnedQueryCard(title: string, text: string): Promise<string> {
  const r = parse(text);
  if (!r.ok) throw new Error(`bad query: ${text}`);
  const id = await backend.createCard(title);
  const hub = docs();
  const h = await hub.open(id);
  try {
    appendQuery(h.doc, writeSpec(r.spec));
    h.doc.commit();
    await h.persistence.flush();
  } finally {
    await hub.release(id);
  }
  await setPin(id, true);
  cardsChanged();
  return id;
}
