// What the indexer extracts from a card body: blocks, card links, block
// references and tags. Mirrors crates/folio-core/src/index.rs (web mode and tests use
// this one); test/index.test.ts and the Rust tests pin the same behaviour.

import type { LoroDoc } from "loro-crdt";
import { bodyJson } from "./card";

export interface IndexBlock {
  bid: string;
  parent: string | null;
  kind: string;
  text: string;
  /** Set on task items (folio-core's `task_of`). */
  task?: IndexTask;
}

export interface IndexTask {
  /** "done" when checked, else the status attribute or "todo". */
  status: string;
  priority: string | null;
  deadline: string | null;
  scheduled: string | null;
}

export interface IndexExtract {
  blocks: IndexBlock[];
  /** [block holding the link, linked card] */
  links: [string, string][];
  /** [block holding the reference, referenced block] */
  refs: [string, string][];
  /** [block holding the tag, tag name as written] */
  tags: [string, string][];
}

type Json = { nodeName?: string; attributes?: Record<string, unknown>; children?: unknown[] } | string;
const ITEMS = new Set(["listItem", "taskItem"]);
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const TEXTBLOCKS = new Set(["paragraph", "heading", "codeBlock"]);

const kids = (n: Json): Json[] => (typeof n === "string" || !Array.isArray(n.children) ? [] : (n.children as Json[]));
const attr = (n: Json, k: string) => (typeof n === "string" ? "" : String(n.attributes?.[k] ?? ""));

function inline(node: Json, block: string, out: IndexExtract): string {
  let s = "";
  for (const c of kids(node)) {
    if (typeof c === "string") s += c;
    else if (c.nodeName === "cardLink") {
      if (attr(c, "cardId")) out.links.push([block, attr(c, "cardId")]);
      s += attr(c, "title");
    } else if (c.nodeName === "blockRef") {
      if (attr(c, "bid")) out.refs.push([block, attr(c, "bid")]);
    } else if (c.nodeName === "tag") {
      if (attr(c, "name")) {
        out.tags.push([block, attr(c, "name")]);
        s += `#${attr(c, "name")}`;
      }
    } else if (c.nodeName === "hardBreak") s += " ";
    else if (c.nodeName === "inlineMath") s += attr(c, "latex");
    else s += inline(c, block, out);
  }
  return s;
}

function taskOf(n: Json): IndexTask {
  const str = (name: string) => {
    const v = typeof n === "string" ? null : n.attributes?.[name];
    return typeof v === "string" && v ? v : null;
  };
  const checked = typeof n !== "string" && n.attributes?.checked === true;
  return { status: checked ? "done" : (str("status") ?? "todo"), priority: str("priority"), deadline: str("deadline"), scheduled: str("scheduled") };
}

function walk(nodes: Json[], parent: string | null, out: IndexExtract) {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    const kind = n.nodeName ?? "";
    if (LISTS.has(kind) || kind === "blockquote") walk(kids(n), parent, out);
    else if (ITEMS.has(kind)) {
      const bid = attr(n, "bid");
      const texts: string[] = [];
      const nested: Json[] = [];
      for (const c of kids(n)) {
        if (typeof c === "string") continue;
        if (LISTS.has(c.nodeName ?? "") || c.nodeName === "table") nested.push(c);
        else if (TEXTBLOCKS.has(c.nodeName ?? "") || c.nodeName === "blockquote") {
          const t = inline(c, bid, out);
          if (t) texts.push(t);
        }
      }
      if (bid) out.blocks.push({ bid, parent, kind, text: texts.join(" "), ...(kind === "taskItem" ? { task: taskOf(n) } : {}) });
      walk(nested, bid || parent, out);
    } else if (TEXTBLOCKS.has(kind)) {
      const bid = attr(n, "bid");
      const text = inline(n, bid, out);
      if (bid) out.blocks.push({ bid, parent, kind, text });
    } else if (kind === "table") {
      // One block (folio-core's `table_text`): rows on lines, cells joined
      // by " | "; links and tags in a cell belong to the table.
      const bid = attr(n, "bid");
      const text = kids(n)
        .map((row) =>
          kids(row as Json)
            .map((cell) =>
              kids(cell as Json)
                .filter((p) => typeof p !== "string" && TEXTBLOCKS.has(p.nodeName ?? ""))
                .map((p) => inline(p as Json, bid, out))
                .filter(Boolean)
                .join(" "),
            )
            .join(" | "),
        )
        .join("\n");
      if (bid) out.blocks.push({ bid, parent, kind, text });
    }
  }
}

export function extractIndex(doc: LoroDoc): IndexExtract {
  const out: IndexExtract = { blocks: [], links: [], refs: [], tags: [] };
  walk(kids(bodyJson(doc) as Json), null, out);
  return out;
}
