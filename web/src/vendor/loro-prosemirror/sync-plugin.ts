import type { Cursor, LoroEventBatch } from "loro-crdt";
import { Fragment, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, type StateField } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "./cursor/common";
import { type LoroNodeMapping, LORO_SYNC_ORIGIN, safeSetSelection } from "./lib";
import { bodyTree, buildDocContent, clearChangedTreeNodes, syncTreeFromPm } from "./tree";
import {
  loroSyncPluginKey,
  type LoroSyncPluginProps,
  type LoroSyncPluginState,
} from "./sync-plugin-key";
import { configLoroTextStyle } from "./text-style";
import { loroUndoPluginKey } from "./undo-plugin-key";

type PluginTransactionType =
  | {
      type: "doc-changed";
    }
  | {
      type: "non-local-updates";
    }
  | {
      type: "update-state";
      state: Partial<LoroSyncPluginState>;
    };

// folio patch: several views may edit one LoroDoc (the same card in both
// panes of a split view). Each commits under its own origin and applies the
// others' local commits as it applies imports.
let views = 0;

/** folio patch: local edits to the body made outside editors (restoring a
 *  backup version) commit under this prefix; every view applies them. */
export const APP_EDIT_ORIGIN = "app:";

/** Local commits another view on the same doc must apply: edits made in an
 *  editor (not this one), undo / redo, and the app's own body edits. */
function fromOtherView(event: LoroEventBatch, own: string): boolean {
  const origin = event.origin ?? "";
  return origin === "undo" || origin.startsWith(APP_EDIT_ORIGIN) || (origin.startsWith(LORO_SYNC_ORIGIN) && origin !== own);
}

export const LoroSyncPlugin = (props: LoroSyncPluginProps): Plugin => {
  const origin = `${LORO_SYNC_ORIGIN}:${++views}`;
  return new Plugin({
    key: loroSyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = loroSyncPluginKey.getState(state);
        return syncState?.snapshot == null;
      },
    },
    state: {
      init: (_config, editorState): LoroSyncPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        return {
          doc: props.doc,
          mapping: props.mapping ?? new Map(),
          changedBy: "local",
          containerId: props.containerId,
          origin,
        };
      },
      apply: (tr, state, oldEditorState, newEditorState) => {
        const meta = tr.getMeta(
          loroSyncPluginKey,
        ) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        if (meta?.type === "non-local-updates") {
          state.changedBy = "import";
        } else {
          state.changedBy = "local";
        }
        switch (meta?.type) {
          case "doc-changed":
            if (!undoState?.isUndoing.current) {
              // folio patch: layout 3, blocks in a LoroTree (tree.ts).
              syncTreeFromPm(state.doc, newEditorState.doc, state.mapping);
              state.doc.commit({ origin: state.origin });
            }
            break;
          case "update-state":
            state = { ...state, ...meta.state };
            state.doc.commit({
              origin: "sys:init",
              timestamp: Date.now(),
            });
            break;
          default:
            break;
        }
        return state;
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, _oldEditorState, newEditorState) => {
      if (transactions.some((tr) => tr.docChanged)) {
        return newEditorState.tr.setMeta(loroSyncPluginKey, {
          type: "doc-changed",
        });
      }
      return null;
    },
    view: (view: EditorView) => {
      const timeoutId = setTimeout(() => init(view), 0);
      return {
        update: (_view: EditorView, _prevState: EditorState) => {},
        destroy: () => {
          clearTimeout(timeoutId);
        },
      };
    },
  });
};

// This is called when the plugin's state is associated with an editor view
function init(view: EditorView) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;

  let docSubscription = state.docSubscription;

  docSubscription?.();

  docSubscription = state.doc.subscribe((event) =>
    updateNodeOnLoroEvent(view, event),
  );

  // folio patch: layout 3, the blocks of the LoroTree (tree.ts).
  const mapping: LoroNodeMapping = new Map();
  const content = bodyTree(state.doc).roots().length
    ? buildDocContent(view.state.schema, state.doc, mapping)
    : [];
  const tr = content.length
    ? view.state.tr.replace(0, view.state.doc.content.size, new Slice(Fragment.from(content), 0, 0))
    : // Empty doc
      view.state.tr.delete(0, view.state.doc.content.size);
  tr.setMeta(loroSyncPluginKey, {
    type: "update-state",
    state: { mapping, docSubscription, snapshot: null },
  });
  view.dispatch(tr);
}

function updateNodeOnLoroEvent(view: EditorView, event: LoroEventBatch) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;
  state.changedBy = event.by;
  if (event.by === "local" && !fromOtherView(event, state.origin)) {
    return;
  }

  const mapping = state.mapping;
  clearChangedTreeNodes(state.doc, event, mapping);
  const content = buildDocContent(view.state.schema, state.doc, mapping);
  const { anchor, focus } = convertPmSelectionToCursors(
    view.state.doc,
    view.state.selection,
    state,
  );

  let tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(content), 0, 0),
  );

  tr.setMeta(loroSyncPluginKey, {
    type: "non-local-updates",
  });
  view.dispatch(tr);

  if (anchor == null) {
    return;
  }
  setTimeout(() => {
    syncCursorsToPmSelection(view, anchor, focus);
  });
}

/**
 * Update ProseMirror selection based on the given Loro cursors.
 */
export function syncCursorsToPmSelection(
  view: EditorView,
  anchor: Cursor,
  focus?: Cursor,
) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (!state) {
    return;
  }

  const { doc, mapping } = state;
  const anchorPos = cursorToAbsolutePosition(anchor, doc, mapping)[0];
  const focusPos = (focus && cursorToAbsolutePosition(focus, doc, mapping)[0]) ?? undefined;
  // folio patch 11: the cursor's line was deleted (undone); the selection
  // ProseMirror mapped through the change stands.
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos);
}
