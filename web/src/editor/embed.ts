// Embeds (design/outliner.md "嵌入"): another block, with everything under
// it, or a whole card, shown in place and kept current as the original
// changes. Like a block reference it stores ids only; unlike one it shows
// the formatted content, not one line. It is read-only here: a click opens
// the original to edit it, so a block lives in one place and every embed
// and the original stay the same text.

import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { LoroDoc } from "loro-crdt";
import { docs } from "../app";
import { openAt } from "../card/reveal";
import { toSide } from "../shell/tabs";
import i18n from "../i18n";
import { buildDocContent } from "../vendor/loro-prosemirror/tree";
import { blockCache, linkTitle, titleCache } from "./refs";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockEmbed: { insertEmbed: (embed: { bid?: string | null; cardId?: string | null }) => ReturnType };
  }
}

/** The block `bid` in `doc` and everything under it, or the whole card for
 *  null; null when the block is not (or no longer) there. */
export function embedContent(schema: Schema, doc: LoroDoc, bid: string | null): Fragment | null {
  const content = Fragment.from(buildDocContent(schema, doc, new Map()));
  if (!bid) return content;
  let found: PMNode | null = null;
  content.descendants((node) => {
    if (found) return false;
    if (node.attrs.bid === bid) found = node;
    return !found;
  });
  if (!found) return null;
  const node: PMNode = found;
  // An outline item keeps its bullet (or checkbox).
  if (node.type.name === "listItem" || node.type.name === "taskItem") return Fragment.from(schema.nodes.bulletList.create(null, node));
  return Fragment.from(node);
}

/** Fills what static HTML cannot know: block references' current text, and
 *  embeds inside the embedded content, shown as one line rather than again
 *  (an embed of a block that embeds it would never end). */
function fillLive(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("span[data-ref]").forEach((el) => {
    const e = blockCache.get(el.dataset.ref ?? "");
    el.textContent = e ? (e.missing ? i18n.t("refs.missing") : e.text || i18n.t("backlinks.emptyBlock")) : "…";
  });
  root.querySelectorAll<HTMLElement>("[data-embed]").forEach((el) => {
    const bid = el.dataset.embed ?? "";
    const card = el.dataset.embedCard ?? "";
    const text = bid ? blockCache.get(bid)?.text : card ? linkTitle(card, "") : "";
    el.textContent = `↪ ${text || "…"}`;
  });
  root.querySelectorAll<HTMLInputElement>("input").forEach((el) => (el.disabled = true));
}

/** The embed in an editor: a title line naming where it comes from, then
 *  the content, redrawn whenever the original changes. */
function embedView(editor: Editor, node: PMNode) {
  const bid = (node.attrs.bid as string | null) || null;
  const hint = (node.attrs.cardId as string | null) || null;
  const dom = document.createElement("span");
  dom.className = "block-embed";
  dom.contentEditable = "false";
  const head = document.createElement("span");
  head.className = "block-embed-source";
  head.setAttribute("role", "link");
  const body = document.createElement("span");
  body.className = "block-embed-body card-body";
  dom.append(head, body);

  let cardId: string | null = null;
  // The card opened from the hub, to release exactly once.
  let held: string | null = null;
  let doc: LoroDoc | null = null;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;

  const draw = () => {
    if (!cardId) {
      head.textContent = "";
      body.textContent = bid && blockCache.get(bid)?.missing ? i18n.t("refs.missing") : "…";
      dom.classList.toggle("missing", !!bid && !!blockCache.get(bid)?.missing);
      return;
    }
    head.textContent = linkTitle(cardId, "");
    if (!doc) return;
    const content = embedContent(editor.schema, doc, bid);
    dom.classList.toggle("missing", !content);
    if (!content) {
      body.textContent = i18n.t("refs.missing");
      return;
    }
    const html = document.createElement("div");
    html.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(content));
    fillLive(html);
    if (!html.textContent?.trim() && !html.querySelector("img, table")) html.textContent = i18n.t("refs.emptyEmbed");
    body.replaceChildren(...html.childNodes);
  };

  /** Opens the card holding the block (again, if the block moved). */
  const follow = () => {
    const next = bid ? (blockCache.get(bid)?.cardId ?? hint) : hint;
    if (next === cardId) return draw();
    unsubscribe();
    unsubscribe = () => {};
    if (held) void docs().release(held);
    held = null;
    cardId = next;
    doc = null;
    draw();
    if (!next) return;
    let hub: ReturnType<typeof docs>;
    try {
      hub = docs();
    } catch {
      return; // No documents to show (tests, before the app starts).
    }
    void hub
      .open(next)
      .then(
        (h) => {
          if (gone || cardId !== next) return void hub.release(next);
          held = next;
          doc = h.doc;
          draw();
          unsubscribe = h.doc.subscribe(() => {
            clearTimeout(timer);
            timer = setTimeout(draw, 120);
          });
        },
        () => {},
      );
  };

  follow();
  const offBlocks = blockCache.subscribe(follow);
  const offTitles = titleCache.subscribe(draw);
  // To edit, go to the original.
  dom.addEventListener("click", (ev) => {
    if (!cardId) return;
    ev.preventDefault();
    openAt(cardId, null, bid, toSide(ev));
  });

  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: (ev: Event) => ev.type === "click",
    destroy() {
      gone = true;
      clearTimeout(timer);
      unsubscribe();
      offBlocks();
      offTitles();
      if (held) void docs().release(held);
    },
  };
}

/** {{embed}} — a block and what is under it (bid), or a whole card (bid
 *  empty, cardId set). Inline like a block reference, so it can be all of
 *  an outline item's line; it shows as a box of its own. */
export const BlockEmbed = Node.create({
  name: "blockEmbed",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      bid: { default: null, parseHTML: (el) => el.getAttribute("data-embed") || null, renderHTML: () => ({}) },
      // The card: where the block was last seen (a hint), or the embedded card.
      cardId: { default: null, parseHTML: (el) => el.getAttribute("data-embed-card") || null, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-embed]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const bid = (node.attrs.bid as string | null) ?? "";
    return ["span", mergeAttributes(HTMLAttributes, { class: "block-embed-line", "data-embed": bid, "data-embed-card": node.attrs.cardId ?? "" }), bid ? `{{embed ((${bid}))}}` : "{{embed}}"];
  },
  renderText({ node }) {
    return node.attrs.bid ? `{{embed ((${node.attrs.bid as string}))}}` : "";
  },
  addNodeView() {
    return ({ editor, node }) => embedView(editor, node);
  },
  addCommands() {
    return {
      insertEmbed:
        ({ bid = null, cardId = null }) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { bid, cardId } }),
    };
  },
});
