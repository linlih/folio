import type { Cursor, Value } from "loro-crdt";
import { UndoManager } from "loro-crdt";
import {
  type Command,
  EditorState,
  Plugin,
  type StateField,
} from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { convertPmSelectionToCursors } from "./cursor/common";
import { syncCursorsToPmSelection } from "./sync-plugin";
import { loroSyncPluginKey } from "./sync-plugin-key";
import { configLoroTextStyle } from "./text-style";
import {
  loroUndoPluginKey,
  type LoroUndoPluginProps,
  type LoroUndoPluginState,
} from "./undo-plugin-key";

type Cursors = { anchor: Cursor | null; focus: Cursor | null };
export const LoroUndoPlugin = (props: LoroUndoPluginProps): Plugin => {
  const undoManager = props.undoManager || new UndoManager(props.doc, {});
  let lastSelection: Cursors = {
    anchor: null,
    focus: null,
  };
  return new Plugin({
    key: loroUndoPluginKey,
    state: {
      init: (_config, editorState): LoroUndoPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        undoManager.addExcludeOriginPrefix("sys:init");
        return {
          undoManager,
          canUndo: undoManager.canUndo(),
          canRedo: undoManager.canRedo(),
          isUndoing: { current: false },
        };
      },
      apply: (_tr, state, oldEditorState, _newEditorState) => {
        const undoState = loroUndoPluginKey.getState(oldEditorState);
        const loroState = loroSyncPluginKey.getState(oldEditorState);
        if (!undoState || !loroState) {
          return state;
        }

        const canUndo = undoState.undoManager.canUndo();
        const canRedo = undoState.undoManager.canRedo();
        {
          // folio patch 9: an intermediate state of one dispatch may hold a
          // line the binding never synced; keep the selection from the last
          // synced state (still the one before this change).
          const { anchor, focus, unmapped } = convertPmSelectionToCursors(
            oldEditorState.doc,
            oldEditorState.selection,
            loroState,
            true,
          );
          if (!unmapped) {
            lastSelection = {
              anchor: anchor ?? null,
              focus: focus ?? null,
            };
          }
        }
        return {
          ...state,
          canUndo,
          canRedo,
        };
      },
    } as StateField<LoroUndoPluginState>,

    view: (view: EditorView) => {
      // folio patch: several views may share one undo manager (the same card
      // in both panes of a split view). The manager has one pair of hooks;
      // they act for the view being worked in (last focused or edited).
      const hooks = sharedHooks(undoManager);
      const me: UndoView = { view, lastSelection: () => lastSelection, props };
      hooks.views.add(me);
      hooks.active = me;
      const activate = () => void (hooks.active = me);
      view.dom.addEventListener("focusin", activate);
      return {
        update: (v, prev) => {
          if (v.hasFocus() && !prev.doc.eq(v.state.doc)) hooks.active = me;
        },
        destroy: () => {
          view.dom.removeEventListener("focusin", activate);
          hooks.views.delete(me);
          if (hooks.active === me) hooks.active = hooks.views.values().next().value ?? null;
          if (!hooks.active) {
            undoManager.setOnPop();
            undoManager.setOnPush();
            shared.delete(undoManager);
          }
        },
      };
    },
  });
};

interface UndoView {
  view: EditorView;
  lastSelection: () => Cursors;
  props: LoroUndoPluginProps;
}

interface SharedHooks {
  views: Set<UndoView>;
  active: UndoView | null;
}

const shared = new WeakMap<UndoManager, SharedHooks>();

function sharedHooks(undoManager: UndoManager): SharedHooks {
  const existing = shared.get(undoManager);
  if (existing) return existing;
  const hooks: SharedHooks = { views: new Set(), active: null };
  shared.set(undoManager, hooks);

  // folio patch: the tag of the step being undone or redone. onPop is
  // followed immediately by the onPush of its inverse, which inherits it.
  let carried: Value | undefined = undefined;
  const stepValue = (isUndo: boolean): Value => {
    if (carried !== undefined) {
      const v = carried;
      carried = undefined;
      return v;
    }
    return isUndo ? (hooks.active?.props.takeStepTag?.() ?? null) : null;
  };
  undoManager.setOnPush((isUndo, _counterRange) => {
    const active = hooks.active;
    const view = active?.view;
    const loroState = view && loroSyncPluginKey.getState(view.state);
    if (!active || !view || loroState?.doc == null) {
      return {
        value: stepValue(isUndo),
        cursors: [],
      };
    }

    const cursors: Cursor[] = [];
    const selection = { ...active.lastSelection() };
    if (!isUndo) {
      const { anchor, focus } = convertPmSelectionToCursors(
        view.state.doc,
        view.state.selection,
        loroState,
      );
      selection.anchor = anchor || null;
      selection.focus = focus || null;
    }

    if (selection.anchor) {
      cursors.push(selection.anchor);
    }
    if (selection.focus) {
      cursors.push(selection.focus);
    }

    return {
      value: stepValue(isUndo),
      // The undo manager will internally transform the cursors.
      // Undo/redo operations may recreate deleted content, so we need to remap
      // the cursors to their new positions. Additionally, if containers are deleted
      // and recreated, they also need remapping. Remote changes to the document
      // should be considered in these transformations.
      cursors,
    };
  });
  undoManager.setOnPop((isUndo, meta, _counterRange) => {
    // After this call, the `onPush` will be called immediately.
    // The immediate `onPush` will contain the inverse operations that undone the effect caused by the current `onPop`
    if (meta.value != null) {
      carried = meta.value;
      hooks.active?.props.onTaggedStep?.(meta.value, isUndo);
    }
    const view = hooks.active?.view;
    const loroState = view && loroSyncPluginKey.getState(view.state);
    if (!view || loroState?.doc == null) {
      return;
    }

    const anchor: Cursor | undefined = meta.cursors[0];
    const focus: Cursor | undefined = meta.cursors[1];
    if (anchor == null) {
      return;
    }
    setTimeout(() => {
      syncCursorsToPmSelection(view, anchor, focus);
    }, 0);
  });
  return hooks;
}

export function canUndo(state: EditorState): boolean {
  const undoState = loroUndoPluginKey.getState(state);
  return undoState?.undoManager.canUndo() || false;
}

export function canRedo(state: EditorState): boolean {
  const undoState = loroUndoPluginKey.getState(state);
  return undoState?.undoManager.canRedo() || false;
}

/** folio patch: the view running undo / redo gets the cursor back. */
function activate(undoManager: UndoManager, view: EditorView | undefined) {
  const hooks = shared.get(undoManager);
  const me = view && hooks && [...hooks.views].find((v) => v.view === view);
  if (me) hooks.active = me;
}

export const undo: Command = (state, dispatch, view): boolean => {
  const undoState = loroUndoPluginKey.getState(state);
  if (!undoState) {
    return false;
  }
  if (dispatch) activate(undoState.undoManager, view);

  if (!dispatch) {
    return undoState.undoManager.canUndo();
  }

  undoState.isUndoing.current = true;
  setTimeout(() => {
    undoState.isUndoing.current = false;
  }, 0);
  return undoState.undoManager.undo();
};

export const redo: Command = (state, dispatch, view): boolean => {
  const undoState = loroUndoPluginKey.getState(state);
  if (!undoState) {
    return false;
  }
  if (dispatch) activate(undoState.undoManager, view);

  if (!dispatch) {
    return undoState.undoManager.canRedo();
  }

  undoState.isUndoing.current = true;
  setTimeout(() => {
    undoState.isUndoing.current = false;
  }, 0);
  return undoState.undoManager.redo();
};
