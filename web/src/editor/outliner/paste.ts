// Pasting into blocks (design/outliner.md "复制、剪切、粘贴"): content with
// several blocks becomes several blocks after the current one, keeping list
// nesting; Markdown text is parsed; one line goes into the current block.

import { Extension } from "@tiptap/core";
import { Fragment, Node as PMNode, Slice, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import i18n from "../../i18n";
import { useShell } from "../../shell/tabs";
import { deleteItems, insertItems, isItem, isList, itemAt, itemAtPos } from "./tree";

const URL_RE = /^https?:\/\/\S+$/;
/** `((block id))`, as copied by Mod+C. */
const BLOCK_REF = /^\(\(([0-9a-f][0-9a-f~-]{8,})\)\)$/i;

/** The block the cursor is in: the list item, or the top-level text block. */
function currentBlockId(state: import("@tiptap/pm/state").EditorState): string | null {
  const item = itemAt(state.selection.$head);
  if (item) return (item.node.attrs.bid as string | null) ?? null;
  const { $head } = state.selection;
  return $head.depth >= 1 ? (($head.node(1).attrs.bid as string | null) ?? null) : null;
}

/** Markdown that describes blocks: list markers, headings, code fences
 *  (Logseq's `markdown-blocks?`), or several paragraphs. */
const MD_BLOCKS = /^\s*(?:[-+*]|\d+[.)]|#{1,6})\s+|^\s*```/m;
const PARAGRAPHS = /\r?\n\s*\r?\n/;

/** Item nodes from Markdown text. Indentation (tabs, or two spaces per
 *  level) nests list items; blank-line-separated paragraphs and headings are
 *  blocks of their own; fenced code stays together. */
export function markdownToItems(schema: Schema, text: string): PMNode[] {
  const { listItem, taskItem, paragraph, heading, codeBlock, bulletList } = schema.nodes;
  type Draft = { depth: number; line: PMNode; task: null | "todo" | "doing" | "done"; extra: PMNode[]; kids: Draft[] };
  const roots: Draft[] = [];
  const stack: Draft[] = [];
  const add = (d: Draft) => {
    while (stack.length && stack[stack.length - 1].depth >= d.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : roots).push(d);
    stack.push(d);
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraphBuffer: string[] = [];
  const flush = () => {
    if (paragraphBuffer.length) add({ depth: 0, line: paragraph.create(null, inline(schema, paragraphBuffer.join(" "))), task: null, extra: [], kids: [] });
    paragraphBuffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = raw.match(/^[\t ]*/)![0].replace(/\t/g, "  ").length;
    const depth = Math.floor(indent / 2);
    const body = raw.trim();
    if (!body) {
      flush();
      continue;
    }
    if (body.startsWith("```")) {
      flush();
      const lang = body.slice(3).trim() || null;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(lines[i]);
      const block = codeBlock.create({ language: lang }, code.length ? schema.text(code.join("\n")) : null);
      const host = stack[stack.length - 1];
      if (host && depth > host.depth) host.extra.push(block);
      else add({ depth, line: paragraph.create(), task: null, extra: [block], kids: [] });
      continue;
    }
    const list = body.match(/^(?:[-+*]|\d+[.)])\s+(.*)$/);
    const head = body.match(/^(#{1,6})\s+(.*)$/);
    if (list) {
      flush();
      let rest = list[1];
      const task = rest.match(/^\[([ xX-])\]\s+(.*)$/);
      let state: Draft["task"] = null;
      if (task) {
        state = task[1] === " " ? "todo" : task[1] === "-" ? "doing" : "done";
        rest = task[2];
      }
      const h = rest.match(/^(#{1,6})\s+(.*)$/);
      const line = h ? heading.create({ level: Math.min(h[1].length, 3) }, inline(schema, h[2])) : paragraph.create(null, inline(schema, rest));
      add({ depth, line, task: state, extra: [], kids: [] });
    } else if (head) {
      flush();
      add({ depth: 0, line: heading.create({ level: Math.min(head[1].length, 3) }, inline(schema, head[2])), task: null, extra: [], kids: [] });
    } else if (stack.length && depth > stack[stack.length - 1].depth && paragraphBuffer.length === 0) {
      // An indented line under a list item continues it.
      const host = stack[stack.length - 1];
      host.extra.push(paragraph.create(null, inline(schema, body)));
    } else {
      paragraphBuffer.push(body);
    }
  }
  flush();
  const build = (d: Draft): PMNode => {
    const content: PMNode[] = [d.line, ...d.extra];
    if (d.kids.length) content.push(bulletList.create(null, d.kids.map(build)));
    if (d.task) return taskItem.create({ checked: d.task === "done", status: d.task === "doing" ? "doing" : null }, content);
    return listItem.create(null, content);
  };
  return roots.map(build);
}

const inline = (schema: Schema, text: string) => (text ? schema.text(text) : null);

/** Item nodes from a pasted slice with block content: lists keep their
 *  items; paragraphs and headings become items; other blocks are kept under
 *  an empty line. Null when the slice is inline content (one line). */
export function sliceToItems(schema: Schema, slice: Slice): PMNode[] | null {
  const blocks: PMNode[] = [];
  slice.content.forEach((n) => void blocks.push(n));
  const isInline = blocks.length === 1 && blocks[0].isTextblock;
  if (blocks.length === 0 || blocks.every((b) => b.isInline) || isInline) return null;
  const out: PMNode[] = [];
  const toItem = (n: PMNode) => {
    if (isItem(n)) return void out.push(n);
    if (isList(n)) return void n.forEach(toItem);
    if (n.type.name === "paragraph" || n.type.name === "heading") return void out.push(schema.nodes.listItem.create(null, n));
    if (n.type.name === "blockquote") return void n.forEach(toItem);
    out.push(schema.nodes.listItem.create(null, [schema.nodes.paragraph.create(), n]));
  };
  blocks.forEach(toItem);
  // Ordered list items become plain items in a bullet outline (insertItems
  // fits them to the target list anyway).
  return out.map((n) => (n.type.name === "listItem" || n.type.name === "taskItem" ? n : schema.nodes.listItem.create(null, n)));
}

/** Inserts pasted blocks after the current block (or in place of it when it
 *  is empty) and puts the cursor at the end of the last one. */
function pasteItems(view: EditorView, nodes: PMNode[]): boolean {
  const { state } = view;
  const item = itemAt(state.selection.$head);
  if (!item || nodes.length === 0) return false;
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const cur = itemAtPos(tr.doc, tr.mapping.map(item.pos))!;
  const empty = cur.node.childCount === 1 && cur.node.firstChild!.content.size === 0;
  let pos = insertItems(tr, Fragment.from(nodes), { kind: "after", item: cur });
  if (empty) {
    const before = tr.steps.length;
    deleteItems(tr, [itemAtPos(tr.doc, cur.pos)!]);
    pos = tr.mapping.slice(before).map(pos);
  }
  // End of the last pasted top-level block's line.
  let last = itemAtPos(tr.doc, pos)!;
  for (let i = 1; i < nodes.length; i++) last = itemAtPos(tr.doc, last.pos + last.node.nodeSize)!;
  tr.setSelection(TextSelection.create(tr.doc, last.pos + 1 + last.node.firstChild!.nodeSize - 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

let plainOnce = false;

export const OutlinePaste = Extension.create({
  name: "outlinePaste",
  addKeyboardShortcuts() {
    return {
      // Mod+Shift+V: the next paste goes into this block as plain text.
      "Mod-Shift-v": () => {
        plainOnce = true;
        setTimeout(() => (plainOnce = false), 1000);
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("outlinePaste"),
        props: {
          handleDOMEvents: {
            // Mod+C with nothing selected copies a reference to the current
            // block (Logseq).
            copy(view, event) {
              const { state } = view;
              if (!state.selection.empty || !event.clipboardData) return false;
              const bid = currentBlockId(state);
              if (!bid) return false;
              event.preventDefault();
              event.clipboardData.setData("text/plain", `((${bid}))`);
              useShell.getState().setNotice(i18n.t("refs.copied"));
              return true;
            },
          },
          handlePaste(view, event, slice) {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const html = event.clipboardData?.getData("text/html") ?? "";
            const { state } = view;
            // A copied block reference becomes a reference again.
            const ref = text.trim().match(BLOCK_REF);
            if (ref && state.schema.nodes.blockRef) {
              view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.blockRef.create({ bid: ref[1] }), false).scrollIntoView());
              return true;
            }
            // A URL over selected text links it.
            if (URL_RE.test(text.trim()) && !state.selection.empty && state.schema.marks.link) {
              const { from, to } = state.selection;
              view.dispatch(state.tr.addMark(from, to, state.schema.marks.link.create({ href: text.trim() })));
              return true;
            }
            if (!itemAt(state.selection.$head)) return false;
            if (plainOnce) {
              plainOnce = false;
              const parts = text.replace(/\r\n/g, "\n").split("\n");
              const nodes: PMNode[] = [];
              parts.forEach((p, i) => {
                if (i > 0) nodes.push(state.schema.nodes.hardBreak.create());
                if (p) nodes.push(state.schema.text(p));
              });
              view.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
              return true;
            }
            const fromHtml = html ? sliceToItems(state.schema, slice) : null;
            if (fromHtml) return pasteItems(view, fromHtml);
            if (!html && (MD_BLOCKS.test(text) || PARAGRAPHS.test(text.trim()))) {
              return pasteItems(view, markdownToItems(state.schema, text));
            }
            return false;
          },
        },
      }),
    ];
  },
});
