// The card document layout, mirroring crates/folio-core/src/card.rs (§4.2).
// Both sides must agree on these names; the Rust tests and test/card.test.ts
// pin the shared behaviour.

import { LoroMap, LoroText, type LoroDoc, type LoroTreeNode, type TreeID } from "loro-crdt";
import { bodyTree } from "../vendor/loro-prosemirror/tree";
import { newBid } from "./ids";

export const META = "meta";

type Json = { nodeName?: string; attributes?: Record<string, unknown>; children?: unknown[] } | string;
type TreeJson = { meta: Record<string, unknown>; children: TreeJson[] };

/** The body as one JSON tree `{nodeName, attributes, children}` (layout 3
 *  read into the shape layout 2 stored, §4.5 rule 4): a text block's
 *  children are its inline content, a container's its child blocks. */
export function bodyJson(doc: LoroDoc): Json {
  const convert = (n: TreeJson): Json => {
    const { nodeName, attributes, children } = n.meta as { nodeName?: string; attributes?: Record<string, unknown>; children?: unknown[] };
    return { nodeName, attributes: attributes ?? {}, children: Array.isArray(children) ? children : n.children.map(convert) };
  };
  return { nodeName: "doc", attributes: {}, children: (bodyTree(doc).toJSON() as TreeJson[]).map(convert) };
}

export type CardKind = "note" | "journal";
export type EditorMode = "document" | "outline";

/** Origins of edits that are not the user's editing and must not be undone. */
export const META_ORIGIN = "meta:";

export interface CardMeta {
  kind: CardKind;
  title: string;
  editorMode: EditorMode;
  createdAt: number | null;
  deletedAt: number | null;
  /** Pinned to the sidebar since. */
  pinnedAt: number | null;
  /** "human", "ai:<model>" or "import:<source>" (§0.3 provenance). */
  source: string;
}

/** Writes the card's metadata. Safe on two devices at once for the same
 *  document: blocks live in one tree that both devices add to (§4.5). */
export function initCard(doc: LoroDoc, kind: CardKind, title: string, now: number, source = "human") {
  const meta = doc.getMap(META);
  meta.set("kind", kind);
  meta.set("title", title);
  meta.set("editor_mode", kind === "journal" ? "outline" : "document");
  meta.set("created_at", now);
  meta.set("source", source);
  doc.commit({ origin: `${META_ORIGIN}init` });
}

export function readMeta(doc: LoroDoc): CardMeta {
  const m = doc.getMap(META);
  const str = (k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");
  const num = (k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : null);
  return {
    kind: str("kind") === "journal" ? "journal" : "note",
    title: str("title"),
    editorMode: str("editor_mode") === "outline" ? "outline" : "document",
    createdAt: num("created_at"),
    deletedAt: num("deleted_at"),
    pinnedAt: num("pinned_at"),
    source: str("source") || "human",
  };
}

export function setTitle(doc: LoroDoc, title: string) {
  doc.getMap(META).set("title", title);
  doc.commit({ origin: `${META_ORIGIN}title` });
}

export function setDeleted(doc: LoroDoc, at: number | null) {
  const meta = doc.getMap(META);
  if (at === null) meta.delete("deleted_at");
  else meta.set("deleted_at", at);
  doc.commit({ origin: `${META_ORIGIN}trash` });
}

export function setPinned(doc: LoroDoc, at: number | null) {
  const meta = doc.getMap(META);
  if (at === null) meta.delete("pinned_at");
  else meta.set("pinned_at", at);
  doc.commit({ origin: `${META_ORIGIN}pin` });
}

/** The card's topics (§4.7): `meta.topics`, a mergeable map from a topic's
 *  id to when the card was added. Same as `folio_core::card::*_card_topic`. */
const CARD_TOPICS = "topics";

export function readCardTopics(doc: LoroDoc): string[] {
  const m = doc.getMap(META).get(CARD_TOPICS);
  return m instanceof LoroMap ? m.keys().sort() : [];
}

export function addCardTopic(doc: LoroDoc, topic: string, now = Date.now()) {
  doc.getMap(META).ensureMergeableMap(CARD_TOPICS).set(topic, now);
  doc.commit({ origin: `${META_ORIGIN}topic` });
}

export function removeCardTopic(doc: LoroDoc, topic: string) {
  doc.getMap(META).ensureMergeableMap(CARD_TOPICS).delete(topic);
  doc.commit({ origin: `${META_ORIGIN}topic` });
}

/** The text an inline node adds to its line; null for block nodes. */
function inlineText(n: Exclude<Json, string>): string | null {
  const a = (k: string) => String(n.attributes?.[k] ?? "");
  switch (n.nodeName) {
    case "cardLink":
      return a("title");
    case "blockRef":
      return "";
    case "tag":
      return `#${a("name")}`;
    case "hardBreak":
      return " ";
    case "inlineMath":
      return a("latex");
    default:
      return null;
  }
}
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
/** Leaf blocks that count as content even without text. */
const CONTENT_LEAVES = new Set(["image", "horizontalRule", "cardLink"]);

/** One line per text block; tabs mark depth below the outermost list. Same
 *  output as `folio_core::card::summarize(..).text`. */
export function bodyLines(doc: LoroDoc): string[] {
  const out: string[] = [];
  const walk = (node: Json, lists: number) => {
    if (typeof node === "string" || !Array.isArray(node.children)) return;
    const indent = "\t".repeat(Math.max(0, lists - 1));
    let own = "";
    for (const child of node.children as Json[]) {
      if (typeof child === "string") own += child;
      else if (child && typeof child === "object") {
        // Inline nodes stay in their line: a card link reads as its title.
        const inline = inlineText(child);
        if (inline !== null) {
          own += inline;
          continue;
        }
        if (own) out.push(indent + own), (own = "");
        walk(child, lists + (LISTS.has(child.nodeName ?? "") ? 1 : 0));
      }
    }
    if (own) out.push(indent + own);
  };
  walk(bodyJson(doc), 0);
  return out;
}

/** What the details panel shows about a card body: its headings (the
 *  outline), #tags, and how much is written. */
export interface BodyFacts {
  headings: { bid: string; level: number; text: string }[];
  tags: string[];
  /** Characters without whitespace (a fair measure for Chinese and English alike). */
  chars: number;
  blocks: number;
}

export function bodyFacts(doc: LoroDoc): BodyFacts {
  const facts: BodyFacts = { headings: [], tags: [], chars: 0, blocks: 0 };
  const tags = new Map<string, string>();
  const textOf = (n: Exclude<Json, string>) => {
    let s = "";
    for (const c of (n.children ?? []) as Json[]) {
      if (typeof c === "string") s += c;
      else if (c && typeof c === "object") {
        if (c.nodeName === "tag") {
          const name = String(c.attributes?.name ?? "");
          if (name && !tags.has(name.toLowerCase())) tags.set(name.toLowerCase(), name);
        }
        s += inlineText(c) ?? "";
      }
    }
    return s;
  };
  const walk = (node: Json) => {
    if (typeof node === "string" || !Array.isArray(node.children)) return;
    for (const child of node.children as Json[]) {
      if (typeof child !== "object" || !child || inlineText(child) !== null) continue;
      if (child.nodeName === "paragraph" || child.nodeName === "heading" || child.nodeName === "codeBlock") {
        const text = textOf(child);
        facts.blocks++;
        facts.chars += [...text.replace(/\s/g, "")].length;
        const bid = String(child.attributes?.bid ?? "");
        if (child.nodeName === "heading" && bid && text.trim()) facts.headings.push({ bid, level: Number(child.attributes?.level ?? 1), text: text.trim() });
      } else walk(child);
    }
  };
  walk(bodyJson(doc));
  facts.tags = [...tags.values()];
  return facts;
}

/** True once the body holds anything a person wrote. An opened but untouched
 *  journal day is not written to disk (§5.2a). */
export function hasContent(doc: LoroDoc): boolean {
  let found = false;
  const walk = (node: Json) => {
    if (found || typeof node === "string" || !Array.isArray(node.children)) return;
    if (CONTENT_LEAVES.has(node.nodeName ?? "")) found = true;
    for (const child of node.children as Json[]) {
      if (typeof child === "string") {
        if (child.trim()) found = true;
      } else if (child && typeof child === "object") walk(child);
    }
  };
  walk(bodyJson(doc));
  return found;
}

export const PREVIEW_CHARS = 160;

export function preview(lines: string[]): string {
  return Array.from(lines.map((l) => l.trimStart()).join(" ")).slice(0, PREVIEW_CHARS).join("");
}

/** Appends a block to the tree (under `parent`, or at the top level), in
 *  the layout the editor binding reads (vendor/loro-prosemirror/tree.ts). */
function addNode(doc: LoroDoc, parent: TreeID | undefined, name: string, attrs: Record<string, string | boolean | null>): LoroTreeNode {
  const node = bodyTree(doc).createNode(parent);
  node.data.set("nodeName", name);
  const a = node.data.ensureMergeableMap("attributes");
  for (const [k, v] of Object.entries(attrs)) if (v !== null) a.set(k, v);
  return node;
}

function addParagraph(doc: LoroDoc, parent: TreeID | undefined, text: string, source: string | null) {
  const kids = addNode(doc, parent, "paragraph", { bid: newBid(), source }).data.ensureMergeableMovableList("children");
  if (text) kids.insertContainer(0, new LoroText()).insert(0, text);
}

/** Appends one block per line: paragraphs in a document card, items of the
 *  last top-level list in an outline (journal). `source` marks blocks not
 *  written by a person (§0.3). Returns nothing; the caller commits. */
export function appendBlocks(doc: LoroDoc, lines: string[], outline: boolean, source: string | null) {
  if (!outline) {
    for (const line of lines) addParagraph(doc, undefined, line, source);
    return;
  }
  const roots = bodyTree(doc).roots();
  const last = roots[roots.length - 1];
  const list = last && last.data.get("nodeName") === "bulletList" ? last : addNode(doc, undefined, "bulletList", {});
  for (const raw of lines) {
    // "- " is just a bullet; "[ ] " / "[x] " make a task (as typed).
    const line = raw.replace(/^\s*[-*+]\s+/, "");
    const task = line.match(/^\[([ xX])\]\s+(.*)$/);
    const item = addNode(doc, list.id, task ? "taskItem" : "listItem", { bid: newBid(), source, ...(task ? { checked: task[1] !== " " } : {}) });
    addParagraph(doc, item.id, task ? task[2] : line, source);
  }
}
