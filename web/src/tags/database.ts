// Reading and writing a tag's database from the views: its definition from
// the workspace document, its rows from the index, values through each
// card's replica.

import { useEffect, useState } from "react";
import { docs } from "../app";
import { cardsChanged } from "../card/actions";
import { appendTag, setProp, type PropValue } from "../docs/card";
import { readDatabase, type Database } from "../docs/database";
import { workspaceDoc } from "../docs/topics";
import { backend } from "../platform";

/** A tag's fields and view, kept current (another device may add fields). */
export function useDatabase(tag: string): Database | null {
  const [db, setDb] = useState<Database | null>(null);
  useEffect(() => {
    let gone = false;
    let unsubscribe = () => {};
    void workspaceDoc().then((h) => {
      if (gone) return;
      const read = () => setDb(readDatabase(h.doc, tag));
      read();
      unsubscribe = h.doc.subscribe(read);
    });
    return () => {
      gone = true;
      unsubscribe();
    };
  }, [tag]);
  return db;
}

/** Edits the workspace document (a tag's fields or view). */
export async function editDatabase<T>(f: (doc: import("loro-crdt").LoroDoc) => T): Promise<T> {
  const h = await workspaceDoc();
  return f(h.doc);
}

/** Sets one field of a card, through its replica (open or not). */
export async function setCardValue(cardId: string, field: string, value: PropValue) {
  const hub = docs();
  const h = await hub.open(cardId);
  try {
    setProp(h.doc, field, value);
    await h.persistence.flush();
  } finally {
    await hub.release(cardId);
  }
}

/** A new card in a tag's database, with `#tag` as its first line and the
 *  given values (the board column it was added in). */
export async function newDatabaseCard(tag: string, title: string, values: Record<string, PropValue> = {}): Promise<string> {
  const id = await backend.createCard(title);
  const hub = docs();
  const h = await hub.open(id);
  try {
    appendTag(h.doc, tag);
    h.doc.commit();
    for (const [k, v] of Object.entries(values)) setProp(h.doc, k, v);
    await h.persistence.flush();
  } finally {
    await hub.release(id);
  }
  cardsChanged();
  return id;
}
