// #tags (design/ARCHITECTURE.md §4.2, M2 part): an inline node holding the
// tag's name. Tags match case-insensitively; a click opens the tag's page.
// (Tags as databases with properties, Heptabase's, are M6.)

import { InputRule, mergeAttributes, Node, PasteRule } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { toSide, useShell } from "../shell/tabs";

/** Characters that end a tag name as it is typed: spaces and punctuation
 *  (ASCII and CJK). */
export const TAG_STOP = `\\s#,.;:!?()\\[\\]{}<>"'\`，。；：！？（）【】《》「」『』〈〉、“”‘’`;
/** CJK punctuation a tag may follow directly: Chinese and Japanese leave
 *  no space after "。" or "，", so "…了。#读书" is a tag as "… #reading" is. */
export const TAG_AFTER = "，。；：！？（）【】《》「」『』〈〉、“”‘’";
const LEAD = `(?:^|[\\s${TAG_AFTER}])`;
const TYPED_TAG = new RegExp(`${LEAD}#([^${TAG_STOP}]+)\\s$`);
/** In pasted text: every `#name` that starts a word. */
const PASTED_TAG = new RegExp(`(?<=^|[\\s${TAG_AFTER}])#([^${TAG_STOP}]+)`, "g");

const inCode = (state: EditorState, pos: number) => {
  const $pos = state.doc.resolve(pos);
  return !!$pos.parent.type.spec.code || $pos.marks().some((m) => m.type.spec.code);
};

export function openTag(name: string, side = false) {
  useShell.getState().open({ kind: "tag", name }, null, side);
}

export const Tag = Node.create({
  name: "tag",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: { default: "", parseHTML: (el) => el.getAttribute("data-tag") ?? "", renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-tag]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "tag-pill", "data-tag": node.attrs.name }), `#${node.attrs.name as string}`];
  },
  renderText({ node }) {
    return `#${node.attrs.name as string}`;
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "tag-pill";
      dom.contentEditable = "false";
      dom.dataset.tag = node.attrs.name as string;
      dom.textContent = `#${node.attrs.name as string}`;
      dom.addEventListener("click", (e) => openTag(node.attrs.name as string, toSide(e)));
      return { dom, ignoreMutation: () => true };
    };
  },
  // `#name` followed by a space becomes a tag (not in code; `# ` at the
  // start of a line stays a heading, as it has no name).
  addInputRules() {
    return [
      new InputRule({
        find: TYPED_TAG,
        handler: ({ state, range, match }) => {
          if (inCode(state, state.selection.from)) return null;
          const lead = match[0].startsWith("#") ? 0 : 1;
          const from = range.from + lead;
          state.tr.replaceWith(from, range.to, [this.type.create({ name: match[1] }), state.schema.text(" ")]);
        },
      }),
    ];
  },
  // Pasted `#name`s become tags too, as if typed (not in code).
  addPasteRules() {
    return [
      new PasteRule({
        find: PASTED_TAG,
        handler: ({ state, range, match }) => {
          if (inCode(state, range.from)) return null;
          state.tr.replaceWith(range.from, range.to, this.type.create({ name: match[1] }));
        },
      }),
    ];
  },
});
