import { Editor } from "@tiptap/core";
import { LoroDoc, UndoManager } from "loro-crdt";
import { isRemoteTx, LoroBinding } from "../src/editor/binding";
import { baseExtensions } from "../src/editor/extensions";

/** Lets the binding load (setTimeout 0) and microtask repairs settle. */
export const settle = () => new Promise((r) => setTimeout(r, 5));

export function device(peer: bigint) {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  return doc;
}

/** A headless editor bound to `doc`, like CardEditor without React. */
export async function bind(doc: LoroDoc, undo = new UndoManager(doc, { mergeInterval: 0 })) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...baseExtensions(isRemoteTx), LoroBinding(doc, undo)],
  });
  await settle();
  return { editor, undo };
}

/** Exchanges everything both replicas are missing. */
export function sync(a: LoroDoc, b: LoroDoc) {
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
}

export const bids = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.descendants((n) => {
    if (n.attrs.bid) out.push(n.attrs.bid as string);
  });
  return out;
};

/** Types like a keyboard: one character at a time, so input rules run. */
export function typeText(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

/** Puts the cursor right after `text`. */
export function cursorAfter(editor: Editor, text: string) {
  let at = -1;
  editor.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(text)) at = pos + n.text.indexOf(text) + text.length;
  });
  if (at < 0) throw new Error(`no "${text}"`);
  editor.commands.setTextSelection(at);
}

/** The outline as lines: indent, kind marker, text. */
export function outline(editor: Editor): string[] {
  const out: string[] = [];
  const walk = (node: import("@tiptap/pm/model").Node, depth: number) => {
    node.forEach((child) => {
      if (child.type.name === "listItem" || child.type.name === "taskItem") {
        const status = child.attrs.status as string | null;
        const mark =
          child.type.name !== "taskItem" ? ""
          : child.attrs.checked ? "[x] "
          : status === "doing" ? "[-] "
          : status ? `[${status}] `
          : "[ ] ";
        const fold = child.attrs.collapsed ? " (collapsed)" : "";
        out.push(`${"  ".repeat(depth)}${mark}${child.firstChild?.textContent ?? ""}${fold}`);
        child.forEach((c) => void (c.type.name.endsWith("List") && walk(c, depth + 1)));
      } else if (child.type.name.endsWith("List")) walk(child, depth);
      else if (child.isTextblock) out.push(`${"  ".repeat(depth)}${child.textContent}`);
    });
  };
  walk(editor.state.doc, 0);
  return out;
}

/** Presses a key combination ("Mod-.", "Enter", "Mod-Shift-ArrowUp") as a real
 *  keydown. TipTap's keyboardShortcut command keeps only document steps, not
 *  the selection or plugin state a handler sets. */
export function press(editor: Editor, combo: string) {
  const parts = combo.split("-");
  const key = parts.pop() || "-";
  const mac = /Mac/.test(navigator.platform);
  const mods = new Set(parts);
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: mods.has("Meta") || (mac && mods.has("Mod")),
    ctrlKey: mods.has("Ctrl") || (!mac && mods.has("Mod")),
    shiftKey: mods.has("Shift"),
    altKey: mods.has("Alt"),
    bubbles: true,
    cancelable: true,
  });
  return editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) ?? false;
}

/** Puts the cursor right before `text`. */
export function cursorBefore(editor: Editor, text: string) {
  let at = -1;
  editor.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(text)) at = pos + n.text.indexOf(text);
  });
  if (at < 0) throw new Error(`no "${text}"`);
  editor.commands.setTextSelection(at);
}

/** The text of the line the cursor is in, with a | at the cursor. */
export function caret(editor: Editor): string {
  const { $head } = editor.state.selection;
  const t = $head.parent.textContent;
  return `${t.slice(0, $head.parentOffset)}|${t.slice($head.parentOffset)}`;
}
