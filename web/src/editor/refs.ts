// Live text for card links and block references (design/ARCHITECTURE.md
// §4.2): a link stores the card id, a reference the block id; what they show
// is looked up in the index, so renames and edits follow everywhere.

import { mergeAttributes, Node } from "@tiptap/core";
import { cardName, openAt } from "../card/reveal";
import { toSide } from "../shell/tabs";
import { DOC_SAVED } from "../docs/persistence";
import i18n from "../i18n";
import { backend } from "../platform";

type Entry = { text: string; cardId: string | null; missing: boolean };

/** One cache per kind; a lookup batches with others made in the same tick. */
function cache(fetch: (keys: string[]) => Promise<Map<string, Entry>>) {
  const values = new Map<string, Entry>();
  const waiting = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const keys = [...waiting];
    waiting.clear();
    if (keys.length === 0) return;
    try {
      const got = await fetch(keys);
      for (const k of keys) values.set(k, got.get(k) ?? { text: "", cardId: null, missing: true });
      listeners.forEach((l) => l());
    } catch {
      // Shown again on the next refresh.
    }
  };
  return {
    get(key: string): Entry | undefined {
      if (!values.has(key) && !waiting.has(key)) {
        waiting.add(key);
        if (!scheduled) (scheduled = true), queueMicrotask(() => void flush());
      }
      return values.get(key);
    },
    /** Looks everything up again (after a save, the index changed). */
    refresh() {
      for (const k of values.keys()) waiting.add(k);
      if (!scheduled) (scheduled = true), queueMicrotask(() => void flush());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const blockCache = cache(async (bids) => {
  const rows = await backend.blockTexts(bids);
  return new Map(rows.map((r) => [r.bid, { text: r.text, cardId: r.cardId, missing: false }]));
});

export const titleCache = cache(async (ids) => {
  const rows = await backend.titles(ids);
  return new Map(rows.map(([id, title]) => [id, { text: title, cardId: id, missing: false }]));
});

if (typeof window !== "undefined") {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (blockCache.refresh(), titleCache.refresh()), 150);
  };
  window.addEventListener(DOC_SAVED, refresh);
  window.addEventListener("folio:cards-changed", refresh);
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockRef: { insertBlockRef: (bid: string, cardId?: string | null) => ReturnType };
  }
}

/** ((block)) — an inline reference to another block, showing its current
 *  text; a click opens its card at the block. */
export const BlockRef = Node.create({
  name: "blockRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      // The referenced block (not this node's own id: inline nodes have none).
      bid: { default: null, parseHTML: (el) => el.getAttribute("data-ref"), renderHTML: () => ({}) },
      // Where it was last seen: a hint, references resolve by block id.
      cardId: { default: null, parseHTML: (el) => el.getAttribute("data-card-hint"), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ref]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "block-ref", "data-ref": node.attrs.bid, "data-card-hint": node.attrs.cardId }), `((${node.attrs.bid as string}))`];
  },
  renderText({ node }) {
    return `((${node.attrs.bid as string}))`;
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "block-ref";
      dom.contentEditable = "false";
      const bid = node.attrs.bid as string;
      const draw = () => {
        const e = blockCache.get(bid);
        dom.textContent = e ? (e.missing ? i18n.t("refs.missing") : e.text || i18n.t("backlinks.emptyBlock")) : "…";
        dom.classList.toggle("missing", !!e?.missing);
      };
      draw();
      const off = blockCache.subscribe(draw);
      dom.addEventListener("click", (ev) => {
        const e = blockCache.get(bid);
        const cardId = e?.cardId ?? (node.attrs.cardId as string | null);
        if (cardId) openAt(cardId, null, bid, toSide(ev));
      });
      return { dom, destroy: off, ignoreMutation: () => true };
    };
  },
  addCommands() {
    return {
      insertBlockRef:
        (bid, cardId = null) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { bid, cardId } }),
    };
  },
});

/** The card name a card link shows: the card's current title. */
export function linkTitle(cardId: string, stored: string): string {
  const e = titleCache.get(cardId);
  return cardName(cardId, e && !e.missing ? e.text : stored);
}
