// Names in a query's text: `[[标题]]` and `主题:名字` stand for ids in the
// spec. Turning text into a spec needs the ids, looked up before parsing;
// turning a spec into text or a summary needs the current names.

import { useTopics, topicName } from "../docs/topics";
import { titleCache } from "../editor/refs";
import { backend } from "../platform";
import { namesIn, type Names } from "./syntax";

const fold = (s: string) => s.trim().toLowerCase();

/** Current names, from what is already known: a card's title once looked
 *  up (it is fetched on first use, then the caller redraws). */
export function knownNames(): Names {
  const topics = useTopics.getState().topics;
  return {
    cards: () => [],
    cardTitle: (id) => titleCache.get(id)?.text ?? null,
    topics: (name) => topics.filter((t) => fold(t.name) === fold(name)).map((t) => t.id),
    topicName: (id) => topicName(topics, id),
  };
}

/** Names for parsing `src`: the cards titled as its `[[…]]` say. */
export async function namesFor(src: string): Promise<Names> {
  const base = knownNames();
  const titles = [...new Set(namesIn(src).cards.map(fold))];
  const found = new Map<string, string[]>();
  await Promise.all(
    titles.map(async (title) => {
      const hits = await backend.search(title, 30).catch(() => []);
      found.set(title, [...new Set(hits.filter((h) => h.bid === null && fold(h.cardTitle) === title).map((h) => h.cardId))]);
    }),
  );
  return { ...base, cards: (title) => found.get(fold(title)) ?? [] };
}
