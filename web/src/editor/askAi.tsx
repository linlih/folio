// "Ask AI" on text selected in a card: with a mouse, in the menu a right
// click on the selection opens (with copy and cut, which that menu stands
// in for); on a touch screen, a button under the selection, beside the
// system's own selection bar.

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { askAi } from "../ai/ask";
import { cardName } from "../card/reveal";
import { readMeta } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import i18n from "../i18n";
import { isTouch } from "../shell/phone";
import { chooseFrom } from "./outliner/popover";

const selectedText = (view: EditorView) => {
  const { from, to, empty } = view.state.selection;
  return empty ? "" : view.state.doc.textBetween(from, to, "\n", " ").trim();
};

const ask = (handle: DocHandle, text: string) => askAi({ cardId: handle.id, title: cardName(handle.id, readMeta(handle.doc).title), text });

/** The right-click menu on a selection, with a mouse. */
export const AskAiMenu = Extension.create<{ handle: DocHandle | null }>({
  name: "askAiMenu",
  addOptions: () => ({ handle: null }),
  addProseMirrorPlugins() {
    const handle = this.options.handle;
    return [
      new Plugin({
        key: new PluginKey("askAiMenu"),
        props: {
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const text = selectedText(view);
              // Without a selection, or by a finger, the system's own menu.
              if (!handle || !text || isTouch()) return false;
              event.preventDefault();
              const at = new DOMRect(event.clientX, event.clientY, 1, 1);
              void chooseFrom({ getBoundingClientRect: () => at }, [
                { value: "ask", label: i18n.t("ai.askAi"), className: "ask-ai-item" },
                { value: "copy", label: i18n.t("ai.copy") },
                { value: "cut", label: i18n.t("ai.cut") },
              ]).then((choice) => {
                if (choice === "ask") ask(handle, text);
                else if (choice) {
                  view.focus();
                  document.execCommand(choice);
                }
              });
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** The button under a selection on a touch screen. */
export function AskAiBubble({ editor, handle }: { editor: Editor; handle: DocHandle }) {
  const { t } = useTranslation();
  const [at, setAt] = useState<{ left: number; top: number; text: string } | null>(null);
  useEffect(() => {
    if (!isTouch()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      setAt(null);
      // Once the selection has settled (the handles dragged), not on every step.
      timer = setTimeout(() => {
        if (editor.isDestroyed || !editor.isFocused) return;
        const text = selectedText(editor.view);
        if (!text) return;
        const end = editor.view.coordsAtPos(editor.state.selection.to);
        setAt({ left: Math.min(end.left, window.innerWidth - 110), top: end.bottom + 28, text });
      }, 400);
    };
    const hide = () => (clearTimeout(timer), setAt(null));
    editor.on("selectionUpdate", update);
    editor.on("blur", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(timer);
      editor.off("selectionUpdate", update);
      editor.off("blur", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [editor]);
  if (!at) return null;
  return (
    <button
      className="ask-ai-bubble"
      style={{ left: at.left, top: at.top }}
      // Keeps the selection (and the editor's focus) while tapping it.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (setAt(null), ask(handle, at.text))}
    >
      <Sparkles size={13} /> {t("ai.askAi")}
    </button>
  );
}
