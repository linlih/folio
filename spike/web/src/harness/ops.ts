import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { BLOCK_TYPES } from "../editor/extensions";
import type { Peer } from "../engines/types";

export type Rng = () => number;

/** mulberry32: small seeded PRNG so failures can be replayed by seed. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const WORDS = ["卡片", "白板", "note", "link", "块引用", "hello", "同步", "CRDT", " ", "，"];

/** All positions where a text cursor may sit. */
function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i);
      return false;
    }
    return true;
  });
  return out;
}

function cursorAt(editor: Editor, rng: Rng): number | null {
  const ps = textPositions(editor.state.doc);
  if (ps.length === 0) return null;
  const p = pick(rng, ps);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, p)));
  return p;
}

function topLevelRanges(doc: PMNode): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.forEach((node, offset) => out.push({ from: offset, to: offset + node.nodeSize }));
  return out;
}

export type OpName =
  | "type"
  | "splitBlock"
  | "bulletList"
  | "taskList"
  | "sink"
  | "lift"
  | "heading"
  | "codeBlock"
  | "deleteRange"
  | "pasteSlice"
  | "moveBlock"
  | "joinBackward"
  | "image"
  | "undo"
  | "redo";

const WEIGHTED: [OpName, number][] = [
  ["type", 30],
  ["splitBlock", 10],
  ["bulletList", 5],
  ["taskList", 3],
  ["sink", 6],
  ["lift", 5],
  ["heading", 3],
  ["codeBlock", 2],
  ["deleteRange", 7],
  ["pasteSlice", 5],
  ["moveBlock", 6],
  ["joinBackward", 6],
  ["image", 1],
  ["undo", 6],
  ["redo", 3],
];
const TOTAL = WEIGHTED.reduce((s, [, w]) => s + w, 0);

export function pickOp(rng: Rng): OpName {
  let r = rng() * TOTAL;
  for (const [op, w] of WEIGHTED) {
    if ((r -= w) < 0) return op;
  }
  return "type";
}

/** Apply one random user-level operation. Returns the op name for logging. */
export function applyOp(editor: Editor, peer: Peer, op: OpName, rng: Rng): void {
  const c = editor.chain();
  switch (op) {
    case "type": {
      if (cursorAt(editor, rng) == null) return;
      editor.commands.insertContent(pick(rng, WORDS));
      return;
    }
    case "splitBlock": {
      if (cursorAt(editor, rng) == null) return;
      // Enter behaves differently inside lists; mirror the keymap.
      if (!editor.commands.splitListItem("listItem") && !editor.commands.splitListItem("taskItem")) {
        editor.commands.splitBlock();
      }
      return;
    }
    case "bulletList":
      if (cursorAt(editor, rng) == null) return;
      c.toggleBulletList().run();
      return;
    case "taskList":
      if (cursorAt(editor, rng) == null) return;
      c.toggleTaskList().run();
      return;
    case "sink":
      if (cursorAt(editor, rng) == null) return;
      if (!editor.commands.sinkListItem("listItem")) editor.commands.sinkListItem("taskItem");
      return;
    case "lift":
      if (cursorAt(editor, rng) == null) return;
      if (!editor.commands.liftListItem("listItem")) editor.commands.liftListItem("taskItem");
      return;
    case "heading":
      if (cursorAt(editor, rng) == null) return;
      c.toggleHeading({ level: pick(rng, [1, 2, 3] as const) }).run();
      return;
    case "codeBlock":
      if (cursorAt(editor, rng) == null) return;
      c.toggleCodeBlock().run();
      return;
    case "deleteRange": {
      const ps = textPositions(editor.state.doc);
      if (ps.length < 2) return;
      const a = pick(rng, ps);
      const b = pick(rng, ps);
      if (a === b) return;
      // Cross-block deletes go through deleteSelection like a real keyboard delete.
      const sel = TextSelection.create(editor.state.doc, Math.min(a, b), Math.max(a, b));
      editor.view.dispatch(editor.state.tr.setSelection(sel));
      editor.commands.deleteSelection();
      return;
    }
    case "pasteSlice": {
      if (cursorAt(editor, rng) == null) return;
      editor.commands.insertContent(
        pick(rng, [
          "<p>粘贴一段</p><p>第二段</p>",
          "<ul><li><p>粘贴列表</p><ul><li><p>子项</p></li></ul></li></ul>",
          "<h2>粘贴标题</h2><p>正文</p>",
          "<p>inline paste</p>",
        ]),
      );
      return;
    }
    case "moveBlock": {
      // Drag-and-drop of a top-level block: delete + insert the same node,
      // so its bid must survive the move.
      const ranges = topLevelRanges(editor.state.doc);
      if (ranges.length < 2) return;
      const src = pick(rng, ranges);
      const node = editor.state.doc.slice(src.from, src.to).content;
      let tr = editor.state.tr.delete(src.from, src.to);
      const after = topLevelRanges(tr.doc);
      const dest = rng() < 0.5 || after.length === 0 ? 0 : pick(rng, after).to;
      tr = tr.insert(dest, node);
      editor.view.dispatch(tr);
      return;
    }
    case "joinBackward": {
      const ps = textPositions(editor.state.doc);
      // Positions at the start of a textblock: Backspace there joins blocks.
      const starts = ps.filter((p) => editor.state.doc.resolve(p).parentOffset === 0);
      if (starts.length === 0) return;
      const p = pick(rng, starts);
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, p)));
      editor.commands.joinBackward();
      return;
    }
    case "image":
      if (cursorAt(editor, rng) == null) return;
      editor.commands.setImage({ src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" });
      return;
    case "undo":
      peer.undo(editor);
      return;
    case "redo":
      peer.redo(editor);
      return;
  }
}

export interface InvariantFailure {
  kind: "schema" | "missing-bid" | "duplicate-bid";
  detail: string;
}

const BLOCKS = new Set<string>(BLOCK_TYPES);

/** Checks every block has a unique bid and the document fits the schema. */
export function checkInvariants(doc: PMNode): InvariantFailure[] {
  const fails: InvariantFailure[] = [];
  try {
    doc.check();
  } catch (e) {
    fails.push({ kind: "schema", detail: String(e) });
  }
  const seen = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!BLOCKS.has(node.type.name)) return;
    const bid = node.attrs.bid as string | null;
    if (!bid) fails.push({ kind: "missing-bid", detail: `${node.type.name}@${pos}` });
    else if (seen.has(bid)) fails.push({ kind: "duplicate-bid", detail: `${bid} @${seen.get(bid)} & @${pos}` });
    else seen.set(bid, pos);
  });
  return fails;
}

export function bidsOf(doc: PMNode): Map<string, string> {
  const out = new Map<string, string>();
  doc.descendants((node) => {
    if (BLOCKS.has(node.type.name) && node.attrs.bid) out.set(node.attrs.bid, node.textContent);
  });
  return out;
}
