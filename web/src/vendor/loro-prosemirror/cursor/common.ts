import {
  type ContainerID,
  Cursor,
  LoroList,
  LoroMovableList,
  LoroText,
  type PeerID,
} from "loro-crdt";
import { Node } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import {
  Decoration,
  type DecorationAttrs,
  DecorationSet,
} from "@tiptap/pm/view";

import {
  CHILDREN_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
} from "../lib";
import { treePosition } from "../tree";
import {
  loroSyncPluginKey,
  type LoroSyncPluginState,
} from "../sync-plugin-key";

export type CursorUser = { name: string; color: string };
export type CursorPresenceState = {
  anchor?: Cursor;
  focus?: Cursor;
  user?: CursorUser;
};

export interface CursorPresenceStore {
  getAll(): Record<PeerID, CursorPresenceState>;
  getLocal(): CursorPresenceState | undefined;
  setLocal(state: CursorPresenceState): void;
  subscribe(listener: (by: "local" | "import" | "timeout") => void): () => void;
}

export interface CursorPluginOptions {
  getSelection?: (state: EditorState) => Selection;
  createCursor?: (user: PeerID) => Element;
  createSelection?: (user: PeerID) => DecorationAttrs;
  user?: CursorUser;
}

export const createCursorPlugin = (
  pluginKey: PluginKey<{ presenceUpdated: boolean }>,
  store: CursorPresenceStore,
  options: CursorPluginOptions,
): Plugin<DecorationSet> => {
  const getSelection = options.getSelection || ((state) => state.selection);
  const createSelection =
    options.createSelection ||
    ((user) => ({
      class: "loro-selection",
      "data-peer": user,
      style: `background-color: rgba(228, 208, 102, 0.5)`,
    }));
  const createCursor =
    options.createCursor ||
    ((user) => {
      const cursorUserData = store.getAll()[user];
      const cursor = document.createElement("span");
      cursor.classList.add("ProseMirror-loro-cursor");
      cursor.setAttribute(
        "style",
        `border-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`,
      );
      const userDiv = document.createElement("div");
      userDiv.setAttribute(
        "style",
        `background-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`,
      );
      userDiv.insertBefore(
        document.createTextNode(cursorUserData?.user?.name ?? user.slice(0, 6)),
        null,
      );
      const nonbreakingSpace1 = document.createTextNode("\u2060");
      const nonbreakingSpace2 = document.createTextNode("\u2060");
      cursor.insertBefore(nonbreakingSpace1, null);
      cursor.insertBefore(userDiv, null);
      cursor.insertBefore(nonbreakingSpace2, null);
      return cursor;
    });
  const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
    key: pluginKey,
    state: {
      init(_, state) {
        return createDecorations(
          state,
          store,
          plugin,
          createSelection,
          createCursor,
        );
      },
      apply(tr, prevState, _oldState, newState) {
        const loroState = loroSyncPluginKey.getState(newState);
        const loroCursorState: { presenceUpdated: boolean } =
          tr.getMeta(pluginKey);
        if (
          (loroState && loroState.changedBy !== "local") ||
          (loroCursorState && loroCursorState.presenceUpdated)
        ) {
          return createDecorations(
            newState,
            store,
            plugin,
            createSelection,
            createCursor,
          );
        }

        return prevState.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => {
        return plugin.getState(state);
      },
    },
    view: (view) => {
      const storeListener = (origin: "local" | "import" | "timeout") => {
        if (origin !== "local") {
          setTimeout(() => {
            if (view.isDestroyed) {
              return;
            }
            let tr = view.state.tr;
            tr.setMeta(pluginKey, {
              presenceUpdated: true,
            });
            view.dispatch(tr);
          }, 0);
        }
      };

      const updateCursorInfo = () => {
        // This will be called whenever the view is updated
        // We may need to optimize it
        const loroState = loroSyncPluginKey.getState(view.state);
        const current = store.getLocal();
        if (loroState?.doc == null) {
          return;
        }

        const pmRootNode = view.state.doc;
        if (view.hasFocus()) {
          const selection = getSelection(view.state);
          const { anchor, focus } = convertPmSelectionToCursors(
            pmRootNode,
            selection,
            loroState,
          );
          if (
            current == null ||
            !cursorEq(current.anchor, anchor) ||
            !cursorEq(current.focus, focus)
          ) {
            store.setLocal({
              user: options.user,
              anchor,
              focus,
            });
          } else {
          }
        } else if (current?.focus != null) {
          store.setLocal({});
        }
      };

      // Listen to presence store changes
      const unsubscribe = store.subscribe(storeListener);
      view.dom.addEventListener("focusin", updateCursorInfo);
      view.dom.addEventListener("focusout", updateCursorInfo);

      return {
        update: updateCursorInfo,
        destroy: () => {
          view.dom.removeEventListener("focusin", updateCursorInfo);
          view.dom.removeEventListener("focusout", updateCursorInfo);
          unsubscribe();
          store.setLocal({});
        },
      };
    },
  });

  return plugin;
};

function createDecorations(
  state: EditorState,
  store: CursorPresenceStore,
  _plugin: Plugin<DecorationSet>,
  createSelection: (user: PeerID) => DecorationAttrs,
  createCursor: (user: PeerID) => Element,
): DecorationSet {
  const all = store.getAll();
  const d: Decoration[] = [];
  const loroState = loroSyncPluginKey.getState(state);
  if (!loroState) {
    return DecorationSet.create(state.doc, []);
  }

  const doc = loroState.doc;
  const thisPeer = doc.peerIdStr;

  for (const [peer, cursor] of Object.entries(all)) {
    if (peer === thisPeer) {
      continue;
    }

    if (!cursor.anchor || !cursor.focus) {
      continue;
    }

    const [focus, focusCursorUpdate] = cursorToAbsolutePosition(
      cursor.focus,
      doc as LoroDocType,
      loroState.mapping,
    );
    d.push(Decoration.widget(focus, createCursor(peer as PeerID)));
    if (!cursorEq(cursor.anchor, cursor.focus)) {
      const [anchor, anchorCursorUpdate] = cursorToAbsolutePosition(
        cursor.anchor,
        doc as LoroDocType,
        loroState.mapping,
      );
      d.push(
        Decoration.inline(
          Math.min(anchor, focus),
          Math.max(anchor, focus),
          createSelection(peer as PeerID),
        ),
      );
      if (focusCursorUpdate || anchorCursorUpdate) {
        const existingLocalState = store.getLocal();
        store.setLocal({
          ...(existingLocalState?.user && {
            user: existingLocalState.user,
          }),
          anchor: anchorCursorUpdate || cursor.anchor,
          focus: focusCursorUpdate || cursor.focus,
        });
      }
    } else {
      if (focusCursorUpdate) {
        const existingLocalState = store.getLocal();
        store.setLocal({
          ...(existingLocalState?.user && {
            user: existingLocalState.user,
          }),
          focus: focusCursorUpdate,
          anchor: focusCursorUpdate,
        });
      }
    }
  }

  const decorations = DecorationSet.create(state.doc, d);
  return decorations;
}

export function convertPmSelectionToCursors(
  pmRootNode: Node,
  selection: Selection,
  loroState: LoroSyncPluginState,
): { anchor: Cursor | undefined; focus: Cursor | undefined };
/** With `quiet`, `unmapped` is true when a node is not known yet (see
 *  folio patch 9) instead of logging an error. */
export function convertPmSelectionToCursors(
  pmRootNode: Node,
  selection: Selection,
  loroState: LoroSyncPluginState,
  quiet: true,
): { anchor: Cursor | undefined; focus: Cursor | undefined; unmapped: boolean };
export function convertPmSelectionToCursors(
  pmRootNode: Node,
  selection: Selection,
  loroState: LoroSyncPluginState,
  quiet = false,
) {
  const anchor = absolutePositionToCursor(
    pmRootNode,
    selection.anchor,
    loroState.doc as LoroDocType,
    loroState.mapping,
    quiet,
  );
  const focus =
    selection.head == selection.anchor
      ? anchor
      : absolutePositionToCursor(
          pmRootNode,
          selection.head,
          loroState.doc as LoroDocType,
          loroState.mapping,
          quiet,
        );
  const unmapped = anchor === UNMAPPED || focus === UNMAPPED;
  const known = (c: typeof anchor) => (c === UNMAPPED ? undefined : c);
  return { anchor: known(anchor), focus: known(focus), unmapped };
}

function getByValue(map: Map<ContainerID, Node | Node[]>, searchValue: Node) {
  for (let [key, value] of map.entries()) {
    if (value === searchValue) return key;
  }
}

/** Returned (with `quiet`) when the position's text block is not mapped. */
export const UNMAPPED = Symbol("unmapped");

function absolutePositionToCursor(
  pmRootNode: Node,
  anchor: number,
  doc: LoroDocType,
  mapping: LoroNodeMapping,
  quiet = false,
): Cursor | undefined | typeof UNMAPPED {
  const pos = pmRootNode.resolve(anchor);
  const nodeParent = pos.node(pos.depth);
  const offset = pos.parentOffset;

  const loroId =
    WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(nodeParent) ??
    getByValue(mapping, nodeParent);
  if (!loroId) {
    // folio patch 9: a state inside one dispatch that the binding never
    // synced (another plugin appended a transaction, e.g. BlockId giving a
    // new line its id) has nodes it cannot know. Callers that can wait say
    // so and keep what they had; only an unexpected miss is an error.
    if (anchor > 1 && !quiet) {
      console.error("Cannot find the loroNode");
    }
    return quiet ? UNMAPPED : undefined;
  }

  const loroMap = doc.getMap(loroId as any) as unknown as LoroNode;
  const children = loroMap.get(CHILDREN_KEY);
  if (children.length == 0) {
    // This is a new line, so we can use the list cursor instead
    return children.getCursor(0);
  }

  let index = offset;
  let childIndex = 0;
  while (index >= 0 && childIndex < children.length) {
    const child = children.get(childIndex);
    childIndex += 1;
    if (child instanceof LoroText) {
      return child.getCursor(index);
    } else {
      if (index == 0) {
        // This happens when user selects an image or a horizontal rule
        if (childIndex < children.length) {
          // Select next text node
          index += 1;
        }
      }

      index -= 1;
    }
  }

  // Selection is not on text
  return undefined;
}

export function cursorToAbsolutePosition(
  cursor: Cursor,
  doc: LoroDocType,
  mapping: LoroNodeMapping,
): [number, Cursor | undefined] {
  // folio patch: layout 3. The cursor is in a text block's inline list (an
  // empty line) or in one of its texts; the block sits in the LoroTree.
  const containerId = cursor.containerId();
  if (containerId.endsWith("List")) {
    const list = doc.getContainerById(containerId) as LoroMovableList | undefined;
    const block = list?.parent();
    if (!block) {
      return [1, undefined];
    }
    return [treePosition(doc, block.id, 0, mapping), undefined];
  }
  const loroText = doc.getText(containerId);
  const pos = doc.getCursorPos(cursor);
  if (!pos) {
    return [1, undefined];
  }
  const list = loroText.parent() as LoroMovableList | LoroList | undefined;
  const block = list?.parent();
  if (!list || !block) {
    return [1, undefined];
  }
  // Inline content before the text, then the text offset.
  let index = pos.offset;
  for (const child of list.toArray() as { id: ContainerID }[]) {
    if (child.id === loroText.id) break;
    const mapped = mapping.get(child.id);
    if (Array.isArray(mapped)) mapped.forEach((n) => (index += n.nodeSize));
    else if (mapped != null) index += mapped.nodeSize;
  }
  return [treePosition(doc, block.id, index, mapping), pos.update];
}

export function cursorEq(a?: Cursor | null, b?: Cursor | null) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  const aPos = a.pos();
  const bPos = b.pos();
  return (
    aPos?.peer === bPos?.peer &&
    aPos?.counter === bPos?.counter &&
    a.containerId() === b.containerId()
  );
}
