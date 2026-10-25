// An editor without a view on screen, bound to an open document: for
// changes made outside any visible editor (linking a mention). Its edits go
// through the binding like typed ones, so open editors show them (§5.1).

import { Editor } from "@tiptap/core";
import type { DocHandle } from "../docs/hub";
import { isBindTx, isRemoteTx, LoroBinding } from "./binding";
import { baseExtensions } from "./extensions";

/** Runs `f` on a temporary editor bound to `handle`'s document. */
export async function withHeadlessEditor<T>(handle: DocHandle, f: (editor: Editor) => T): Promise<T> {
  let bound!: () => void;
  const ready = new Promise<void>((r) => (bound = r));
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...baseExtensions(isRemoteTx), LoroBinding(handle.doc, handle.undo)],
    onTransaction: ({ transaction }) => isBindTx(transaction) && bound(),
  });
  try {
    await ready;
    return f(editor);
  } finally {
    editor.destroy();
  }
}
