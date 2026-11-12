// The query block (design/query.md): a leaf block whose `spec` attribute
// holds the conditions as JSON; it shows what they find, live. Like a code
// block it can sit under an outline item's line. Its results are drawn by
// React (query/QueryBlock.tsx); the editor only sees one atom.

import { Extension, mergeAttributes, Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";
import { QueryBlock } from "../query/QueryBlock";
import { knownNames } from "../query/names";
import { readSpec, writeSpec, type QuerySpec } from "../query/spec";
import { summary } from "../query/summary";
import { format, type Lang } from "../query/syntax";

/** Which card an editor shows, for what depends on it ("this card"). */
export const CardContext = Extension.create<{ cardId: string | null }>({
  name: "cardContext",
  addOptions: () => ({ cardId: null }),
});

export const editorCardId = (editor: Editor): string | null =>
  (editor.extensionManager.extensions.find((e) => e.name === "cardContext")?.options as { cardId: string | null } | undefined)?.cardId ?? null;

export const uiLang = (): Lang => (i18n.language?.startsWith("zh") ? "zh" : "en");

/** The query as text, or null for one this version cannot read. */
export function queryText(raw: unknown): string | null {
  const { spec } = readSpec(raw);
  return spec ? format(spec, uiLang(), knownNames()) : null;
}

/** The next query block drawn opens its panel: one just inserted. */
let opening = false;
export const openNextQuery = () => void (opening = true);

function queryView(editor: Editor, initial: PMNode, getPos: () => number | undefined) {
  const dom = document.createElement("div");
  dom.className = "query-block";
  dom.contentEditable = "false";
  dom.dataset.type = "query";
  let node = initial;
  let root: Root | null = createRoot(dom);
  const openPanel = opening;
  opening = false;

  const save = (spec: QuerySpec | null) => {
    const pos = getPos();
    if (pos === undefined || !editor.isEditable) return;
    const tr = editor.state.tr;
    if (spec === null) tr.delete(pos, pos + node.nodeSize);
    else tr.setNodeAttribute(pos, "spec", writeSpec(spec));
    editor.view.dispatch(tr);
  };
  const render = () =>
    root?.render(
      createElement(QueryBlock, {
        raw: node.attrs.spec as string,
        cardId: editorCardId(editor),
        editable: editor.isEditable,
        openPanel,
        onChange: save,
      }),
    );
  render();

  return {
    dom,
    update(next: PMNode) {
      if (next.type !== node.type) return false;
      node = next;
      render();
      return true;
    },
    // The block is the user's, not the editor's: clicks, typing in its
    // panel. Dragging it is the editor's.
    stopEvent: (ev: Event) => !(ev.type.startsWith("drag") || ev.type === "drop"),
    ignoreMutation: () => true,
    destroy() {
      const r = root;
      root = null;
      // Not while React may be rendering (an update dispatched from it).
      queueMicrotask(() => r?.unmount());
    },
  };
}

export const QueryNode = Node.create({
  name: "query",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      spec: { default: "", parseHTML: (el) => el.getAttribute("data-spec") ?? "", renderHTML: (a) => ({ "data-spec": a.spec as string }) },
    };
  },
  parseHTML: () => [{ tag: 'div[data-type="query"]' }],
  renderHTML({ node, HTMLAttributes }) {
    const { spec } = readSpec(node.attrs.spec);
    const title = spec ? summary(spec, uiLang(), knownNames()) : i18n.t("query.newer");
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "query", class: "query-block query-static" }), ["div", { class: "query-head" }, title]];
  },
  // Copied as text: its conditions, as written (§8).
  renderText: ({ node }) => queryText(node.attrs.spec) ?? "",
  addNodeView() {
    return ({ editor, node, getPos }) => queryView(editor, node, getPos as () => number | undefined);
  },
});
