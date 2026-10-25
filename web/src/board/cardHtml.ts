// A card's body as formatted HTML for the whiteboard (Heptabase shows the
// whole card, not a summary): headings, lists, to-dos, code, links, tags.
// Built from the Loro document with the editor's own schema and node HTML,
// without mounting an editor per card.

import { getSchema } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import type { LoroDoc } from "loro-crdt";
import { baseExtensions } from "../editor/extensions";
import { buildDocContent } from "../vendor/loro-prosemirror/tree";

let schema: ReturnType<typeof getSchema> | null = null;

export function cardFragment(doc: LoroDoc): DocumentFragment {
  schema ??= getSchema(baseExtensions(() => false));
  const content = buildDocContent(schema, doc, new Map());
  const node = schema.topNodeType.create(null, content);
  return DOMSerializer.fromSchema(schema).serializeFragment(node.content) as DocumentFragment;
}
