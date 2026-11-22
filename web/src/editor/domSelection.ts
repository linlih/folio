import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** ProseMirror's watcher of the page: `flush()` takes in what changed in
 *  the page and the selection there, as it does on `selectionchange`. */
type Observed = EditorView & { domObserver?: { flush(): void } };

/** Takes in a selection made outside the editor's own events before acting
 *  on it. A voice input (Doubao) selects its raw words through the system's
 *  accessibility API and pastes the tidied words at once: the page's
 *  selection has moved but `selectionchange` has not come yet, so the paste
 *  went where the caret was and the words were there twice. */
export function syncSelection(view: EditorView) {
  if (view.composing) return;
  (view as Observed).domObserver?.flush();
}

/** First of all plugins, so every paste handler sees the selection. */
export const DomSelection = Extension.create({
  name: "domSelection",
  priority: 10000,
  addProseMirrorPlugins() {
    const sync = (view: EditorView) => {
      syncSelection(view);
      return false;
    };
    return [
      new Plugin({
        key: new PluginKey("domSelection"),
        props: { handleDOMEvents: { paste: sync, cut: sync, copy: sync } },
      }),
    ];
  },
});
