import { Extension, type Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { EditorMode } from "../docs/card";
import { readMeta } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { redo as loroRedo, undo as loroUndo } from "../vendor/loro-prosemirror";
import { isBindTx, isRemoteTx, LoroBinding } from "./binding";
import { focusTrail } from "./outliner/focus";
import { baseExtensions } from "./extensions";
import { toSide } from "../shell/tabs";
import "katex/dist/katex.min.css";
import "./editor.css";

export interface CardEditorProps {
  docId: string;
  /** Overrides the card's own editor mode (journal days are always outlines). */
  mode?: EditorMode;
  placeholder?: string;
  autoFocus?: boolean;
  /** `side`: Shift+click, open in the other pane. */
  onOpenCard?: (cardId: string, title: string, side: boolean) => void;
  /** Extra extensions (commands that need app context). */
  extensions?: (handle: DocHandle) => Extension[];
  onReady?: (editor: Editor, handle: DocHandle) => void;
}

/** Undo and redo of this document's own Loro history (StarterKit's
 *  ProseMirror history is off). */
const UndoKeys = Extension.create({
  name: "loroUndoKeys",
  addKeyboardShortcuts() {
    const run = (redo: boolean) => () => {
      const view = this.editor.view;
      return (redo ? loroRedo : loroUndo)(view.state, view.dispatch, view);
    };
    return { "Mod-z": run(false), "Mod-Shift-z": run(true), "Mod-y": run(true) };
  },
});

/** Puts the cursor at the start or end and focuses now. TipTap's `focus`
 *  command waits for an animation frame, which never comes while the page is
 *  hidden. */
export function focusEditor(editor: Editor, where: "start" | "end") {
  const pos = where === "start" ? 1 : editor.state.doc.content.size - 1;
  editor.commands.setTextSelection(Math.max(1, pos));
  editor.view.focus();
}

const EMPTY_OUTLINE = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }] };

/** Gives a freshly loaded empty document the starting block for its mode. */
function ensureStartBlock(editor: Editor, mode: EditorMode) {
  const doc = editor.state.doc;
  const first = doc.firstChild;
  const blank = doc.childCount === 0 || (doc.childCount === 1 && first?.type.name === "paragraph" && first.content.size === 0);
  if (!blank) return;
  if (mode === "outline") editor.commands.setContent(EMPTY_OUTLINE);
  else if (doc.childCount === 0) editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
}

function BoundEditor({ handle, mode, placeholder, autoFocus, onOpenCard, extensions, onReady }: CardEditorProps & { handle: DocHandle }) {
  const editorMode = mode ?? readMeta(handle.doc).editorMode;
  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions(isRemoteTx, placeholder, editorMode),
        LoroBinding(handle.doc, handle.undo),
        UndoKeys,
        ...(extensions?.(handle) ?? []),
      ],
      // Read-only until the binding has loaded the document (§5.1 point 1).
      editable: false,
      immediatelyRender: false,
      editorProps: {
        attributes: { class: `prose card-body mode-${editorMode}` },
        // Keep the cursor about 100 px away from the window edges while
        // typing, instead of touching them (design/outliner.md "输入手感").
        scrollMargin: { top: 96, bottom: 120, left: 0, right: 0 },
        scrollThreshold: { top: 96, bottom: 120, left: 0, right: 0 },
        handleClickOn: (_view, _pos, node, _nodePos, event) => {
          if (node.type.name !== "cardLink") return false;
          onOpenCard?.(node.attrs.cardId as string, node.attrs.title as string, toSide(event));
          return true;
        },
      },
      onTransaction: ({ editor, transaction }) => {
        if (!isBindTx(transaction)) return;
        // Let the binding finish its own follow-up transaction first.
        queueMicrotask(() => {
          if (editor.isDestroyed) return;
          ensureStartBlock(editor, editorMode);
          editor.setEditable(true);
          if (autoFocus) focusEditor(editor, "end");
        });
      },
    },
    [handle],
  );
  useEffect(() => {
    if (editor) onReady?.(editor, handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per editor instance
  }, [editor]);
  return (
    <div className="editor-host">
      {editor && <FocusTrail editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/** Where the editor is focused (outline focus), as a clickable path. */
function FocusTrail({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const key = useSyncExternalStore(
    (onChange) => {
      editor.on("transaction", onChange);
      return () => void editor.off("transaction", onChange);
    },
    () => JSON.stringify(focusTrail(editor.state)),
  );
  const trail = JSON.parse(key) as { bid: string; text: string }[];
  if (trail.length === 0) return null;
  return (
    <nav className="focus-trail">
      <button onClick={() => editor.commands.focusItem(null)}>{t("outline.showAll")}</button>
      {trail.slice(0, -1).map((step) => (
        <span key={step.bid}>
          <span className="sep">›</span>
          <button onClick={() => editor.commands.focusItem(step.bid)}>{step.text || t("outline.untitledItem")}</button>
        </span>
      ))}
    </nav>
  );
}

/** An editor bound to one document through the DocHub. */
export function CardEditor(props: CardEditorProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ handle: DocHandle | null; error: string | null }>({ handle: null, error: null });

  useEffect(() => {
    const hub = docs();
    let cancelled = false;
    hub.open(props.docId).then(
      (handle) => !cancelled && setState({ handle, error: null }),
      (e) => !cancelled && setState({ handle: null, error: String(e) }),
    );
    return () => {
      cancelled = true;
      void hub.release(props.docId);
    };
  }, [props.docId]);

  if (state.error) return <p className="editor-note">{t("error.generic", { message: state.error })}</p>;
  if (!state.handle) return null;
  return <BoundEditor key={props.docId} {...props} handle={state.handle} />;
}
