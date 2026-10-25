// #tags (design/ARCHITECTURE.md §4.2, M2 part): an inline node holding the
// tag's name. Tags match case-insensitively; a click opens the tag's page.
// (Tags as databases with properties, Heptabase's, are M6.)

import { InputRule, mergeAttributes, Node } from "@tiptap/core";
import { toSide, useShell } from "../shell/tabs";

/** Characters that end a tag name as it is typed: spaces and punctuation
 *  (ASCII and CJK). */
export const TAG_STOP = `\\s#,.;:!?()\\[\\]{}<>"'\`，。；：！？（）【】《》、“”‘’`;
const TYPED_TAG = new RegExp(`(?:^|\\s)#([^${TAG_STOP}]+)\\s$`);

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
          const { $from } = state.selection;
          if ($from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code)) return null;
          const lead = match[0].startsWith("#") ? 0 : 1;
          const from = range.from + lead;
          state.tr.replaceWith(from, range.to, [this.type.create({ name: match[1] }), state.schema.text(" ")]);
        },
      }),
    ];
  },
});
