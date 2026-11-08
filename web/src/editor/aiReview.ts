// The assistant's proposed changes drawn in the card (ai/review.ts): a
// changed block shows what goes and what comes, like a diff, with a row to
// accept or reject it; added content shows at the end. Only decorations:
// the document is unchanged until the change is accepted and made, so
// nothing half-decided is saved or synced. A block edited since the change
// was proposed is marked, and the change can only be rejected.

import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { useChatLive } from "../ai/chat";
import { diffText, inlineText, mostlyRewritten } from "../ai/diff";
import { parseInline, parseMarkdown, toHtml } from "../ai/markdown";
import { changesFor, decideChange, useReview, type CardChange, type ReviewView } from "../ai/review";
import i18n from "../i18n";

const key = new PluginKey<DecorationSet>("aiReview");

/** The textblock holding a block's text: the block, or a list item's first line. */
export function textblockOf(doc: PmNode, bid: string): { pos: number; node: PmNode } | null {
  let found: { pos: number; node: PmNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.bid !== bid) return true;
    if (node.isTextblock) found = { pos, node };
    else if (node.firstChild?.isTextblock) found = { pos: pos + 1, node: node.firstChild };
    return false;
  });
  return found;
}

/** The document position of a character offset into a textblock's text
 *  (as `textContent` counts it: inline nodes without text count nothing). */
export function posAt(block: { pos: number; node: PmNode }, offset: number): number {
  let pos = block.pos + 1;
  let left = offset;
  let done = false;
  block.node.forEach((child) => {
    if (done) return;
    const len = child.isText ? child.text!.length : 0;
    if (child.isText && left <= len) {
      pos += left;
      done = true;
      return;
    }
    left -= len;
    pos += child.nodeSize;
  });
  return pos;
}

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The row above a change: who, its state, accept and reject. */
function head(change: CardChange, all: CardChange[], label: string, stale: boolean): HTMLElement {
  const t = i18n.t.bind(i18n);
  const row = el("span", "ai-head");
  row.contentEditable = "false";
  row.append(el("span", "ai-who", `✦ ${label}`));
  if (stale) row.append(el("span", "ai-stale", t("ai.review.stale")));
  const button = (cls: string, text: string, allowed: boolean | undefined) => {
    const b = el("button", `ai-act ${cls}`, text) as HTMLButtonElement;
    b.type = "button";
    // Keep the editor's selection: the row is not text.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      decideChange(change, allowed, all);
    });
    return b;
  };
  if (change.allowed) {
    row.append(el("span", "ai-state", t("ai.review.accepted")));
    if (all.some((c) => c.allowed === undefined)) row.append(button("ai-undo", t("ai.review.takeBack"), undefined));
  } else {
    const yes = button("ai-yes", t("ai.review.accept"), true);
    if (stale) yes.disabled = true;
    row.append(yes, button("ai-no", t("ai.review.reject"), false));
  }
  return row;
}

/** The old text above the new, for the split view. */
function linesBox(before: string, after: string): HTMLElement {
  const box = el("span", "ai-lines");
  const line = (cls: string, sign: string, text: string) => {
    const l = el("span", `ai-line ${cls}`);
    l.append(el("span", "ai-sign", sign), el("span", "ai-line-text", text));
    return l;
  };
  box.append(line("old", "−", before), line("new", "+", after));
  return box;
}

/** A changed block: its row, and what goes and what comes. */
function blockDecorations(doc: PmNode, change: CardChange, every: CardChange[], view: ReviewView, current: boolean): Decoration[] {
  const block = change.bid ? textblockOf(doc, change.bid) : null;
  if (!block) return [];
  const before = change.proposal.before ?? "";
  const after = inlineText(parseInline(change.proposal.after ?? ""));
  const stale = block.node.textContent !== before;
  const ops = diffText(before, after);
  // An accepted change shows its result; a block mostly rewritten reads
  // better whole, old above new, than as a scatter of pieces.
  const shown: ReviewView = change.allowed ? "after" : view === "inline" && mostlyRewritten(ops) ? "lines" : view;
  const split = shown === "lines" && !stale;
  const cls = ["ai-hunk", current && "current", change.allowed && "accepted", stale && "stale", split && "lines"].filter(Boolean).join(" ");
  const stamp = `${change.id}:${change.allowed ?? "?"}:${stale}:${shown}:${every.map((c) => c.allowed ?? "?").join("")}`;
  const decos = [
    Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: cls, "data-ai-change": change.id }),
    Decoration.widget(
      block.pos + 1,
      () => {
        const row = head(change, every, i18n.t("ai.review.edit"), stale);
        if (!split) return row;
        const wrap = el("span", "ai-head-wrap");
        wrap.contentEditable = "false";
        wrap.append(row, linesBox(before, after));
        return wrap;
      },
      { side: -1, key: `ai-head:${stamp}`, ignoreSelection: true, stopEvent: () => true },
    ),
  ];
  // A block edited since cannot be drawn against the old text.
  if (stale) return decos;
  if (split) {
    if (block.node.content.size) decos.push(Decoration.inline(block.pos + 1, block.pos + 1 + block.node.content.size, { class: "ai-hidden" }));
    return decos;
  }
  let offset = 0;
  for (const op of ops) {
    const len = op.s.length;
    if (op.t === "=") offset += len;
    else if (op.t === "-") {
      decos.push(Decoration.inline(posAt(block, offset), posAt(block, offset + len), { class: shown === "after" ? "ai-hidden" : "ai-del" }));
      offset += len;
    } else {
      const at = posAt(block, offset);
      const text = op.s;
      decos.push(Decoration.widget(at, () => el("ins", shown === "after" ? "ai-ins quiet" : "ai-ins", text), { side: -1, key: `ai-ins:${change.id}:${at}:${shown}:${text}`, ignoreSelection: true, marks: [] }));
    }
  }
  return decos;
}

/** Content to be added, shown at the end of the card. */
function addedWidget(doc: PmNode, change: CardChange, every: CardChange[], current: boolean): Decoration {
  const stamp = `${change.id}:${change.allowed ?? "?"}:${current}:${every.map((c) => c.allowed ?? "?").join("")}`;
  return Decoration.widget(
    doc.content.size,
    () => {
      const box = el("div", ["ai-added", current && "current", change.allowed && "accepted"].filter(Boolean).join(" "));
      box.dataset.aiChange = change.id;
      box.contentEditable = "false";
      box.append(head(change, every, i18n.t("ai.review.add"), false));
      const body = el("div", "ai-added-body");
      // The assistant's Markdown, rendered as the card would show it
      // (toHtml escapes every text).
      body.innerHTML = toHtml(parseMarkdown(change.proposal.content ?? ""));
      box.append(body);
      return box;
    },
    { side: 1, key: `ai-add:${stamp}`, ignoreSelection: true, stopEvent: () => true },
  );
}

function decorations(state: EditorState, cardId: string): DecorationSet {
  // Every proposed change (for the rows' "take back"); a rejected one leaves
  // the card as it is.
  const every = changesFor(useChatLive.getState().live, cardId);
  const shown = every.filter((c) => c.allowed !== false);
  if (!shown.length) return DecorationSet.empty;
  const { view, current } = useReview.getState();
  const decos: Decoration[] = [];
  for (const change of shown) {
    if (change.name === "update_block") decos.push(...blockDecorations(state.doc, change, every, view, change.id === current));
    else if (change.name === "append_to_card") decos.push(addedWidget(state.doc, change, every, change.id === current));
  }
  return DecorationSet.create(state.doc, decos);
}

/** Draws the card's proposed changes; `cardId` is the editor's document. */
export const AiReview = Extension.create<{ cardId: string }>({
  name: "aiReview",
  addOptions: () => ({ cardId: "" }),
  addProseMirrorPlugins() {
    const cardId = this.options.cardId;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorations(state, cardId),
          apply: (tr, old, _prev, state) => (tr.getMeta(key) || tr.docChanged ? decorations(state, cardId) : old.map(tr.mapping, tr.doc)),
        },
        props: { decorations: (state) => key.getState(state) },
        view: (view: EditorView) => {
          let last = "";
          const redraw = () => {
            // Only when something this card shows changed.
            const r = useReview.getState();
            const sig = JSON.stringify([changesFor(useChatLive.getState().live, cardId).map((c) => [c.id, c.allowed, c.proposal.after, c.proposal.content]), r.view, r.current]);
            if (sig === last || view.isDestroyed) return;
            last = sig;
            view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
          };
          const offLive = useChatLive.subscribe(redraw);
          const offReview = useReview.subscribe(redraw);
          return {
            destroy: () => {
              offLive();
              offReview();
            },
          };
        },
      }),
    ];
  },
});
