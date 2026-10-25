// Bracket pairing as in Logseq (design/outliner.md "自动配对"), for a rich
// text editor: `[` and `{` pair, `(` wraps a selection; a typed closer steps
// over an existing one; Backspace between an empty pair removes both; the
// full-width `【【` of Chinese input methods becomes `[[]]`.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const PAIRS: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
const CLOSERS = new Set(Object.values(PAIRS));
/** Pair even without a selection (`(` only wraps, as `((` is block refs, M2). */
const ALWAYS = new Set(["[", "{"]);

const charBefore = (view: EditorView, pos: number) => {
  const $p = view.state.doc.resolve(pos);
  return $p.parent.textBetween(Math.max(0, $p.parentOffset - 1), $p.parentOffset, "", "￼");
};
const charAfter = (view: EditorView, pos: number) => {
  const $p = view.state.doc.resolve(pos);
  return $p.parent.textBetween($p.parentOffset, Math.min($p.parent.content.size, $p.parentOffset + 1), "", "￼");
};

/** Handles typed text; true when it did something instead of the default. */
export function autopairInput(view: EditorView, from: number, to: number, text: string): boolean {
  const { state } = view;
  if (view.composing || state.selection.$from.parent.type.spec.code) return false;
  // Full-width brackets: 【【 → [[]]; a second 【 right after the first.
  if (text === "【" && from === to && charBefore(view, from) === "【") {
    let end = to;
    while (charAfter(view, end) === "】") end++;
    const tr = state.tr.insertText("[[]]", from - 1, end);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
    return true;
  }
  if (CLOSERS.has(text) && from === to && charAfter(view, from) === text) {
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from + 1)));
    return true;
  }
  const close = PAIRS[text];
  if (!close) return false;
  if (from !== to) {
    // Wrap the selected text.
    const tr = state.tr.insertText(close, to).insertText(text, from);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)));
    return true;
  }
  if (!ALWAYS.has(text)) return false;
  const tr = state.tr.insertText(text + close, from);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
  return true;
}

/** Backspace between an empty pair deletes both halves. */
export function autopairBackspace(view: EditorView): boolean {
  const { state } = view;
  const { empty, from } = state.selection;
  if (!empty) return false;
  const before = charBefore(view, from);
  if (!PAIRS[before] || charAfter(view, from) !== PAIRS[before]) return false;
  view.dispatch(state.tr.delete(from - 1, from + 1));
  return true;
}

export const Autopair = Extension.create({
  name: "autopair",
  // Before the outline keys: Backspace inside "[]" is about the brackets.
  priority: 300,
  addKeyboardShortcuts() {
    return { Backspace: () => autopairBackspace(this.editor.view) };
  },
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("autopair"), props: { handleTextInput: autopairInput } })];
  },
});
