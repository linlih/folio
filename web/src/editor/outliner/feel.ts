// Input feel (design/outliner.md "输入手感"): small behaviours from Notion,
// Bear and Craft that make typing feel natural, on top of the outline rules.

import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import i18n from "../../i18n";
import { plainLine } from "./tasks";
import { insertItems, isItem, isList, itemAt, visibleItems, type Item } from "./tree";

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
    return [shortcutPlugin(), linePlaceholder(this.options.placeholder), compositionRepair()];
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

/** True when the document has just this one line. */
function onlyLine(doc: PMNode): boolean {
  let lines = 0;
  doc.descendants((node) => {
    if (node.isTextblock) lines++;
    return lines < 2 && !node.isTextblock;
  });
  return lines === 1;
}

/** The hint on an empty line: the editor's placeholder while the document
 *  has one line, else the `/` hint on the cursor's line. Which line carries
 *  it never depends on whether that line has text (the CSS shows it only on
 *  an empty one): changing the line's attributes as its first character
 *  arrives breaks an input method's composition in WebKit, leaving the
 *  pinyin as text and the chosen characters on a new line. */
function linePlaceholder(whole: string) {
  return new Plugin({
    key: new PluginKey("linePlaceholder"),
    props: {
      decorations(state) {
        const doc = state.doc;
        const first = firstTextblock(doc);
        if (whole && first && onlyLine(doc)) {
          return DecorationSet.create(doc, [Decoration.node(first.pos, first.pos + first.node.nodeSize, { class: "line-placeholder", "data-placeholder": whole })]);
        }
        const { $head } = state.selection;
        const line = $head.parent;
        if (!line.isTextblock || line.type.spec.code || $head.depth === 0) return DecorationSet.empty;
        const pos = $head.before();
        return DecorationSet.create(doc, [Decoration.node(pos, pos + line.nodeSize, { class: "line-placeholder line-hint", "data-placeholder": i18n.t("editor.lineHint") })]);
      },
      // While composing, the first characters are already in the line but
      // the browser still shows the empty line's break: hide the hint.
      handleDOMEvents: {
        compositionstart: (view) => void view.dom.classList.add("composing"),
        compositionend: (view) => void view.dom.classList.remove("composing"),
      },
    },
  });
}

/** iOS's WebView, committing a composition that is all of a list item's
 *  text, deletes the composed text first; the item's line is then empty
 *  and WebKit moves it out of the item, into a new item after it or after
 *  the list. The chosen characters land on a line of their own and the item
 *  stays empty, or, when ProseMirror misses the deletion, keeps them too.
 *  Put them back once the composition is over. (Safari keeps the line in
 *  place.) */
function compositionRepair() {
  let item: string | null = null;
  let pending: { bid: string; timer: ReturnType<typeof setTimeout> } | null = null;
  // The page scrolls to follow the stray line; it goes back once that is undone.
  let scrolled: [Element, number][] = [];
  // Tries the repair; an early try that finds nothing leaves the later ones.
  const run = (view: EditorView, last = true) => {
    if (!pending || view.composing || view.isDestroyed) return;
    const repaired = repairComposition(view, pending.bid);
    if (!repaired && !last) return;
    clearTimeout(pending.timer);
    pending = null;
    if (repaired) for (const [el, top] of scrolled) el.scrollTop = top;
    scrolled = [];
  };
  return new Plugin({
    key: new PluginKey("compositionRepair"),
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          scrolled = [];
          item = (itemAt(view.state.selection.$from)?.node.attrs.bid as string | undefined) ?? null;
          return false;
        },
        compositionend(view) {
          const bid = item;
          item = null;
          if (!bid) return false;
          pending = { bid, timer: setTimeout(() => run(view), 50) };
          // After ProseMirror has read the committed text from the page (a
          // microtask its own handler, which runs after this one, queues),
          // before the page is drawn; the timer is there if it is late.
          queueMicrotask(() => queueMicrotask(() => run(view, false)));
          return false;
        },
        // A key pressed right away (Enter, say) goes to the repaired line.
        keydown(view) {
          run(view);
          return false;
        },
        beforeinput(view, event) {
          // The commit starts by deleting the composed text.
          if (item && (event as InputEvent).inputType === "deleteCompositionText" && !scrolled.length) {
            for (let el = view.dom.parentElement; el; el = el.parentElement) if (el.scrollTop) scrolled.push([el, el.scrollTop]);
          }
          run(view);
          return false;
        },
      },
    },
  });
}

/** Moves the cursor's line back into the item `bid` when it sits right
 *  after it, as the only content of the next item or after the list the
 *  item ends, and the item was left empty or holding the same text. Keeps
 *  the cursor where it was in the text. */
export function repairComposition(view: { state: EditorState; dispatch(tr: Transaction): void }, bid: string): boolean {
  const { state } = view;
  const { $head } = state.selection;
  const line = $head.parent;
  if (!line.isTextblock || line.content.size === 0) return false;
  const left = (n: PMNode | null | undefined): n is PMNode =>
    isItem(n) &&
    n!.attrs.bid === bid &&
    n!.childCount === 1 &&
    n!.firstChild!.isTextblock &&
    (n!.firstChild!.content.size === 0 || n!.firstChild!.textContent === line.textContent);
  // Replaces the text of the item at `at` with the line, which spans from..to.
  const move = (from: number, to: number, at: number, target: PMNode) => {
    const start = at + 2;
    const tr = state.tr.delete(from, to).replaceWith(start, start + target.firstChild!.content.size, line.content);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + $head.parentOffset)));
    return true;
  };
  const own = itemAt($head);
  if (own && own.node.childCount === 1 && own.depth === $head.depth - 1) {
    const before = state.doc.resolve(own.pos).nodeBefore;
    if (left(before)) return move(own.pos, own.pos + own.node.nodeSize, own.pos - before.nodeSize, before);
  }
  const lineStart = $head.before();
  const list = state.doc.resolve(lineStart).nodeBefore;
  if (!list || !isList(list) || !left(list.lastChild)) return false;
  return move(lineStart, lineStart + line.nodeSize, lineStart - 1 - list.lastChild.nodeSize, list.lastChild);
}
