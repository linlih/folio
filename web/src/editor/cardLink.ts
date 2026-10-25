import { mergeAttributes, Node } from "@tiptap/core";
import { linkTitle, titleCache } from "./refs";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cardLink: { insertCardLink: (cardId: string, title: string) => ReturnType };
  }
}

/** A link to a card (§4.2): stores the card id; `title` is the title when the
 *  link was made, shown only until the current one is known. */
export const CardLink = Node.create({
  name: "cardLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      // Rendered by renderHTML below, not as raw attributes.
      cardId: { default: null, parseHTML: (el) => el.getAttribute("data-card-id"), renderHTML: () => ({}) },
      title: { default: "", parseHTML: (el) => el.textContent ?? "", renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-card-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "card-link", "data-card-id": node.attrs.cardId }),
      (node.attrs.title as string) || "…",
    ];
  },
  // Shows the card's current title, so a rename shows up in every link
  // (titles are looked up in the index; the stored title is the fallback).
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "card-link";
      dom.contentEditable = "false";
      dom.dataset.cardId = node.attrs.cardId as string;
      const draw = () => (dom.textContent = linkTitle(node.attrs.cardId as string, node.attrs.title as string) || "…");
      draw();
      const off = titleCache.subscribe(draw);
      return { dom, destroy: off, ignoreMutation: () => true };
    };
  },
  renderText({ node }) {
    return `[[${node.attrs.title as string}]]`;
  },
  addCommands() {
    return {
      insertCardLink:
        (cardId, title) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { cardId, title } }),
    };
  },
});
