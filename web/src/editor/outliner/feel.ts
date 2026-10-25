// Input feel (design/outliner.md "输入手感"): small behaviours from Notion,
// Bear and Craft that make typing feel natural, on top of the outline rules.

import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import i18n from "../../i18n";
import { plainLine } from "./tasks";
import { insertItems, isList, itemAt, visibleItems, type Item } from "./tree";

/** The Markdown shortcut just applied, with the transactions it caused
 *  (block ids for new blocks are added in a follow-up transaction, which
 *  makes TipTap forget the shortcut, so it is tracked here). */
interface AppliedShortcut {
  trs: Transaction[];
  from: number;
  to: number;
  text: string;
}

export const shortcutKey = new PluginKey<AppliedShortcut | null>("appliedShortcut");

function shortcutPlugin() {
  return new Plugin<AppliedShortcut | null>({
    key: shortcutKey,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        // TipTap may run more than one input-rules plugin; the rule that fired
        // tags the transaction with its own.
        let meta: { from: number; to: number; text: string } | undefined;
        for (const p of state.plugins) {
          if ((p.spec as { isInputRules?: boolean }).isInputRules) meta ??= tr.getMeta(p);
        }
        if (meta) return { trs: [tr], from: meta.from, to: meta.to, text: meta.text };
        if (value && tr.getMeta("appendedTransaction") === value.trs[0]) return { ...value, trs: [...value.trs, tr] };
        return tr.docChanged || tr.selectionSet ? null : value;
      },
    },
  });
}

/** Undoes the shortcut: its changes are inverted and the typed text is back. */
function undoShortcut(state: EditorState): Transaction | null {
  const applied = shortcutKey.getState(state);
  if (!applied) return null;
  const tr = state.tr;
  for (let t = applied.trs.length - 1; t >= 0; t--) {
    const steps = applied.trs[t].steps;
    for (let i = steps.length - 1; i >= 0; i--) tr.step(steps[i].invert(applied.trs[t].docs[i]));
  }
  const marks = tr.doc.resolve(applied.from).marks();
  tr.replaceWith(applied.from, applied.to, state.schema.text(applied.text, marks));
  return tr;
}

/** Runs before the outline keys: Backspace first undoes a Markdown shortcut
 *  that was just applied, and turns a heading back into a paragraph. */
export const InputFeel = Extension.create<{ placeholder: string; outline: boolean }>({
  name: "inputFeel",
  priority: 1050,
  addProseMirrorPlugins() {
    return [shortcutPlugin(), linePlaceholder(this.options.placeholder)];
  },
  addOptions: () => ({ placeholder: "", outline: true }),
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor;
        if (!state.selection.empty) return false;
        const undo = undoShortcut(state);
        if (undo) {
          editor.view.dispatch(undo);
          return true;
        }
        const { $from } = state.selection;
        // A task line: drop the status first, keep the text (Notion).
        const item = itemAt($from);
        if (item && $from.parentOffset === 0 && $from.parent === item.node.firstChild && item.node.type.name === "taskItem") {
          const tr = plainLine(state, this.options.outline);
          if (tr) editor.view.dispatch(tr);
          return true;
        }
        if ($from.parentOffset === 0 && $from.parent.type.name === "heading") {
          editor.view.dispatch(state.tr.setNodeMarkup($from.before(), state.schema.nodes.paragraph));
          return true;
        }
        return false;
      },
    };
  },
});

/** Runs after everything else: Tab outside lists must not move focus out of
 *  the editor; in a code block it indents. */
export const KeepFocusKeys = Extension.create({
  name: "keepFocusKeys",
  priority: 50,
  addKeyboardShortcuts() {
    const tab = (shift: boolean) => ({ editor }: { editor: Editor }) => {
      if (!shift && editor.isActive("codeBlock")) return editor.commands.insertContent("  ");
      return true;
    };
    return { Tab: tab(false), "Shift-Tab": tab(true) };
  },
});

/** The first text block of the document (the body's first line). */
export function firstTextblock(doc: PMNode): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock) found = { node, pos };
    return true;
  });
  return found;
}

/** A click below the content continues writing at the end (Notion): the
 *  last line if it is empty, else a new empty line (a new top-level block
 *  in an outline). */
/** True for a mouse-down on an editor's empty area below its text: not on
 *  the text, the margin beside it, or its handles (a drag must start). */
export function belowText(editor: Editor, e: { target: EventTarget | null; clientY: number }): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || target.closest(".ProseMirror, .focus-trail, .drag-handle")) return false;
  return e.clientY > editor.view.dom.getBoundingClientRect().bottom;
}

export function continueAtEnd(editor: Editor, outline: boolean) {
  const { state } = editor;
  const doc = state.doc;
  const last = doc.lastChild;
  const tr = state.tr;
  let caret: number;
  if (last && isList(last) && outline) {
    const root = { node: last, pos: doc.content.size - last.nodeSize };
    const items = visibleItems(root);
    const end = items[items.length - 1];
    if (end && end.node.firstChild!.content.size === 0 && end.node.childCount === 1) {
      caret = end.pos + 2;
    } else {
      const top: Item = { node: last.lastChild!, pos: doc.content.size - 1 - last.lastChild!.nodeSize };
      const fresh = state.schema.nodes.listItem.create(null, state.schema.nodes.paragraph.create());
      caret = insertItems(tr, Fragment.from(fresh), { kind: "after", item: top }) + 2;
    }
  } else if (last && last.type.name === "paragraph" && last.content.size === 0) {
    caret = doc.content.size - 1;
  } else {
    tr.insert(doc.content.size, state.schema.nodes.paragraph.create());
    caret = tr.doc.content.size - 1;
  }
  tr.setSelection(TextSelection.create(tr.doc, caret));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** The empty line the cursor is in shows a hint about `/`; an empty card
 *  shows its own placeholder on its first line instead. */
function linePlaceholder(whole: string) {
  return new Plugin({
    key: new PluginKey("linePlaceholder"),
    props: {
      decorations(state) {
        const { $head, empty } = state.selection;
        const doc = state.doc;
        const docEmpty = doc.childCount === 1 && doc.textContent === "" && !!doc.firstChild && (doc.firstChild.isTextblock || doc.firstChild.textContent === "");
        const line = $head.parent;
        if (docEmpty && whole) {
          const first = firstTextblock(doc);
          if (first) return DecorationSet.create(doc, [Decoration.node(first.pos, first.pos + first.node.nodeSize, { class: "is-empty", "data-placeholder": whole })]);
        }
        if (!empty || !line.isTextblock || line.content.size > 0 || line.type.spec.code) return DecorationSet.empty;
        const pos = $head.before();
        return DecorationSet.create(doc, [Decoration.node(pos, pos + line.nodeSize, { class: "is-empty line-hint", "data-placeholder": i18n.t("editor.lineHint") })]);
      },
    },
  });
}
