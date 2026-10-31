import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { endItemDrag, startItemDrag } from "./dnd";
import { focusKey, focusPlugin, focusTrail, focusedBid, findItem } from "./focus";
import type { Node as PMNode } from "@tiptap/pm/model";
import i18n from "../../i18n";
import { chooseFrom, type Option } from "./popover";
import { PRIORITY_ICON, STATUS_ICON, STATUSES, type Priority, type TaskStatus } from "./statusIcons";
import { setTaskState, taskState, type TaskState } from "./tasks";
import { hasChildren, isItem, itemAt, itemAtPos } from "./tree";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    outline: {
      /** Shows one item alone; null shows everything again. */
      focusItem: (bid: string | null) => ReturnType;
    };
  }
}

/** Collapses or expands the item at `pos`. A cursor inside the part that
 *  disappears moves to the end of the item's first line. */
export function setCollapsed(state: EditorState, pos: number, collapsed: boolean): Transaction | null {
  const item = state.doc.nodeAt(pos);
  if (!isItem(item) || !hasChildren(item!) || !!item!.attrs.collapsed === collapsed) return null;
  const tr = state.tr.setNodeAttribute(pos, "collapsed", collapsed);
  if (collapsed) {
    const firstEnd = pos + 1 + item!.firstChild!.nodeSize;
    const { from, to } = state.selection;
    if (to > firstEnd && from < pos + item!.nodeSize) tr.setSelection(TextSelection.create(tr.doc, firstEnd - 1));
  }
  return tr;
}

const label = (key: string, opts?: Record<string, unknown>) => i18n.t(`outline.${key}`, opts);

interface GutterSpec {
  collapsed: boolean;
  kids: boolean;
  /** A task's status icon takes the bullet's place in any list; plain items
   *  of ordered lists keep their number instead of a bullet. */
  marker: "bullet" | "task" | "none";
  status: TaskStatus | null;
}

/** The status menu: Logseq's six statuses, and "not a task". */
async function pickStatus(view: EditorView, anchor: HTMLElement, pos: number) {
  const item = itemAtPos(view.state.doc, pos);
  if (!item) return;
  const current = taskState(item);
  const options: Option<TaskState>[] = [
    ...STATUSES.map((s) => ({ value: s as TaskState, label: i18n.t(`task.${s}`), icon: `<span class="status-${s}">${STATUS_ICON[s]}</span>` })),
    { value: "item", label: i18n.t("task.none") },
  ];
  const chosen = await chooseFrom(anchor, options, current);
  const now = chosen && itemAtPos(view.state.doc, pos);
  if (!chosen || !now || chosen === current) return view.focus();
  const tr = view.state.tr;
  setTaskState(tr, now, chosen);
  view.dispatch(tr);
  view.focus();
}

/** The gutter left of a list item: a chevron when it has children, then the
 *  bullet or status icon, which is also the drag handle (design/outliner.md). */
function gutter(view: EditorView, getPos: () => number | undefined, spec: GutterSpec) {
  const el = document.createElement("span");
  el.className = "ol-gutter";
  el.contentEditable = "false";
  const itemPos = () => (getPos() ?? 0) - 1;
  const chevron = document.createElement("button");
  chevron.className = `ol-chevron${spec.collapsed ? " collapsed" : ""}`;
  chevron.tabIndex = -1;
  if (spec.kids) {
    chevron.setAttribute("aria-label", label(spec.collapsed ? "expand" : "collapse"));
    chevron.addEventListener("mousedown", (e) => e.preventDefault());
    chevron.addEventListener("click", () => {
      const tr = setCollapsed(view.state, itemPos(), !spec.collapsed);
      if (tr) view.dispatch(tr);
    });
  } else {
    chevron.classList.add("empty");
    chevron.setAttribute("aria-hidden", "true");
  }
  el.append(chevron);
  if (spec.marker === "none") return el;

  const marker = document.createElement("button");
  marker.tabIndex = -1;
  marker.draggable = true;
  if (spec.marker === "task" && spec.status) {
    marker.className = `ol-status status-${spec.status}`;
    marker.innerHTML = STATUS_ICON[spec.status];
    marker.setAttribute("aria-label", label("status", { status: i18n.t(`task.${spec.status}`) }));
    marker.title = i18n.t(`task.${spec.status}`);
  } else {
    marker.className = `ol-bullet${spec.collapsed && spec.kids ? " collapsed" : ""}`;
    marker.setAttribute("aria-label", label("bullet"));
  }
  marker.addEventListener("mousedown", (e) => e.stopPropagation());
  marker.addEventListener("click", () => {
    const item = itemAtPos(view.state.doc, itemPos());
    if (!item) return;
    if (spec.marker === "task") void pickStatus(view, marker, item.pos);
    else if (item.node.attrs.bid) view.dispatch(view.state.tr.setMeta(focusKey, { bid: item.node.attrs.bid }));
  });
  marker.addEventListener("dragstart", (e) => {
    const item = itemAtPos(view.state.doc, itemPos());
    if (item) startItemDrag(view, item, e);
  });
  marker.addEventListener("dragend", endItemDrag);
  el.append(marker);
  return el;
}

export const dateLabel = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(new Date(y, m - 1, d));
};

/** Priority before the line's text; deadline and scheduled date after it. */
function propertyWidgets(node: PMNode, pos: number, decos: Decoration[]) {
  const line = node.firstChild;
  if (!line) return;
  const lineStart = pos + 2;
  const lineEnd = pos + 1 + line.nodeSize - 1;
  const priority = node.attrs.priority as Priority | null;
  if (priority && PRIORITY_ICON[priority]) {
    decos.push(
      Decoration.widget(lineStart, () => {
        const el = document.createElement("span");
        el.className = `ol-priority priority-${priority}`;
        el.contentEditable = "false";
        el.innerHTML = PRIORITY_ICON[priority];
        el.title = i18n.t(`priority.${priority}`);
        return el;
      }, { side: -1, ignoreSelection: true, key: `p:${priority}` }),
    );
  }
  for (const kind of ["scheduled", "deadline"] as const) {
    const date = node.attrs[kind] as string | null;
    if (!date) continue;
    decos.push(
      Decoration.widget(lineEnd, () => {
        const el = document.createElement("span");
        el.className = `ol-date ${kind}`;
        el.contentEditable = "false";
        el.textContent = `${i18n.t(`task.${kind}`)} ${dateLabel(date)}`;
        return el;
      }, { side: 1, ignoreSelection: true, key: `${kind}:${date}` }),
    );
  }
}

// Built once per document version, not on every selection change.
const gutterCache = new WeakMap<object, DecorationSet>();

function gutterDecorations(state: EditorState): DecorationSet {
  const cached = gutterCache.get(state.doc);
  if (cached) return cached;
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos, parent) => {
    if (!isItem(node)) return true;
    const isTask = node.type.name === "taskItem";
    const status = isTask ? taskState({ node, pos }) : null;
    const spec: GutterSpec = {
      collapsed: !!node.attrs.collapsed,
      kids: hasChildren(node),
      marker: isTask ? "task" : parent?.type.name === "orderedList" ? "none" : "bullet",
      status: status === "item" ? null : status,
    };
    decos.push(
      Decoration.widget(pos + 1, (view, getPos) => gutter(view, getPos, spec), {
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
        // Redrawn only when what it shows changes.
        key: `${node.attrs.bid}:${spec.collapsed}:${spec.kids}:${spec.marker}:${spec.status}`,
      }),
    );
    propertyWidgets(node, pos, decos);
    return true;
  });
  const set = DecorationSet.create(state.doc, decos);
  gutterCache.set(state.doc, set);
  return set;
}

/** Collapsing, bullets / checkboxes and focus for list items. */
export const OutlineGutter = Extension.create({
  name: "outlineGutter",
  addGlobalAttributes() {
    return [
      {
        types: ["listItem", "taskItem"],
        attributes: {
          // Content, not view state: synced, like Logseq's `collapsed::`.
          collapsed: {
            default: false,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-collapsed") === "true",
            renderHTML: (attrs: Record<string, unknown>) => (attrs.collapsed ? { "data-collapsed": "true" } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      focusItem:
        (bid) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(focusKey, { bid });
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    const collapse = (value: boolean) => () => {
      const target = itemAt(this.editor.state.selection.$head);
      if (!target) return false;
      const tr = setCollapsed(this.editor.state, target.pos, value);
      if (tr) this.editor.view.dispatch(tr);
      return true;
    };
    return {
      "Mod-ArrowUp": collapse(true),
      "Mod-ArrowDown": collapse(false),
      "Mod-;": () => {
        const target = itemAt(this.editor.state.selection.$head);
        if (!target) return false;
        const tr = setCollapsed(this.editor.state, target.pos, !target.node.attrs.collapsed);
        if (tr) this.editor.view.dispatch(tr);
        return true;
      },
      // Focus on the item at the cursor; Mod+, goes one level back out.
      "Mod-.": () => {
        const target = itemAt(this.editor.state.selection.$head);
        return !!target && this.editor.commands.focusItem(target.node.attrs.bid as string);
      },
      "Mod-,": () => {
        const trail = focusTrail(this.editor.state);
        if (trail.length === 0) return false;
        return this.editor.commands.focusItem(trail.length > 1 ? trail[trail.length - 2].bid : null);
      },
    };
  },
  addProseMirrorPlugins() {
    return [focusPlugin(), new Plugin({ key: new PluginKey("outlineGutter"), props: { decorations: gutterDecorations } })];
  },
});

export { findItem, focusTrail, focusedBid };
