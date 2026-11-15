// The inbox's own search box: what waits there, narrowed as you type.

import type { InboxItem } from "../bindings/commands";
import { queryMatch } from "../search/pinyin";

/** The items that have every word of `query`: in the title (by pinyin too),
 *  or in the notes, summary, site, author or address as written. */
export function filterInbox(items: InboxItem[], query: string): InboxItem[] {
  if (!query.trim()) return items;
  return items.filter((i) => {
    if (queryMatch(i.title, query) !== null) return true;
    const all = [i.title, i.preview, i.clip?.excerpt, i.clip?.site, i.clip?.author, i.clip?.url].filter(Boolean).join("\n");
    return queryMatch(all, query) === "text";
  });
}
