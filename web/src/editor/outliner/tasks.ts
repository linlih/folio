// Tasks and block properties (design/outliner.md "任务"), after Logseq's
// built-in status / priority / deadline / scheduled properties. A task is a
// `taskItem`; done is its `checked`, the other statuses its `status`.

import { Extension, InputRule } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import type { Priority, TaskStatus } from "./statusIcons";
import { itemAt, parentItem, type Item } from "./tree";

/** `[ ] ` or `[x] ` at the start of a line. */
const TASK_PREFIX = /^\s*\[([ xX])?\]\s$/;

export type TaskState = "item" | TaskStatus;

export function taskState(item: Item): TaskState {
  if (item.node.type.name !== "taskItem") return "item";
  if (item.node.attrs.checked) return "done";
  const s = item.node.attrs.status as string | null;
  return s === "backlog" || s === "doing" || s === "review" || s === "canceled" ? s : "todo";
}

/** Sets an item's task state in place: same id, same children, same other
 *  properties. "item" makes it a plain block again. */
export function setTaskState(tr: Transaction, item: Item, state: TaskState) {
  const { schema } = tr.doc.type;
  const attrs = { ...item.node.attrs };
  if (state === "item") return void tr.setNodeMarkup(item.pos, schema.nodes.listItem, attrs);
  const status = state === "todo" || state === "done" ? null : state;
  tr.setNodeMarkup(item.pos, schema.nodes.taskItem, { ...attrs, checked: state === "done", status });
}

/** Logseq's cycle-todo: Todo → Doing → Done → none → Todo; any other status
 *  goes to Todo. */
const NEXT: Record<TaskState, TaskState> = {
  item: "todo",
  todo: "doing",
  doing: "done",
  done: "item",
  backlog: "todo",
  review: "todo",
  canceled: "todo",
};

export function cycleKind(tr: Transaction, item: Item) {
  setTaskState(tr, item, NEXT[taskState(item)]);
}

/** Makes the block at the cursor a task in `state`: an item changes in
 *  place; a paragraph outside lists becomes a one-item outline first (no
 *  separate "task list" that could hold tasks only). */
export function makeTask(state: EditorState, task: TaskState): Transaction | null {
  const item = itemAt(state.selection.$head);
  const tr = state.tr;
  if (item) {
    setTaskState(tr, item, task);
    return tr;
  }
  const { $head } = state.selection;
  if (task === "item" || !$head.parent.isTextblock || $head.depth !== 1) return null;
  const { schema } = state;
  const status = task === "todo" || task === "done" ? null : task;
  const line = schema.nodes.paragraph.create(null, $head.parent.content);
  const node = schema.nodes.bulletList.create(null, schema.nodes.taskItem.create({ checked: task === "done", status }, line));
  const start = $head.before();
  tr.replaceWith(start, start + $head.parent.nodeSize, Fragment.from(node));
  // bulletList, taskItem, paragraph: three opening positions.
  tr.setSelection(TextSelection.create(tr.doc, start + 3 + $head.parentOffset));
  return tr;
}

const attr = (name: string, parse: (v: string | null) => unknown = (v) => v) => ({
  default: null,
  keepOnSplit: false,
  parseHTML: (el: HTMLElement) => parse(el.getAttribute(`data-${name}`)),
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [`data-${name}`]: attrs[name] } : {}),
});

/** Statuses and block properties, the `[ ] ` shortcut and Mod+Enter. */
export const OutlineTasks = Extension.create({
  name: "outlineTasks",
  addGlobalAttributes() {
    return [
      // backlog / doing / review / canceled (todo and done are `checked`).
      { types: ["taskItem"], attributes: { status: attr("status") } },
      {
        types: ["listItem", "taskItem"],
        attributes: {
          priority: attr("priority") as { default: Priority | null },
          // YYYY-MM-DD
          deadline: attr("deadline"),
          scheduled: attr("scheduled"),
          // "quote": the block shows as a quote (Logseq's display type).
          display: attr("display"),
        },
      },
    ];
  },
  addInputRules() {
    return [
      new InputRule({
        find: TASK_PREFIX,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          const item = itemAt($from);
          // Only at the start of a line: an item's first line, or a
          // paragraph outside lists.
          const atLine = item ? $from.parent === item.node.firstChild : $from.depth === 1 && $from.parent.type.name === "paragraph";
          if (!atLine) return null;
          const task: TaskState = (match[1] ?? " ").toLowerCase() === "x" ? "done" : "todo";
          state.tr.delete(range.from, range.to);
          if (item) return void setTaskState(state.tr, item, task);
          const $p = state.tr.doc.resolve(state.tr.mapping.map($from.pos));
          const { schema } = state;
          const line = schema.nodes.paragraph.create(null, $p.parent.content);
          const node = schema.nodes.bulletList.create(null, schema.nodes.taskItem.create({ checked: task === "done" }, line));
          const start = $p.before();
          state.tr.replaceWith(start, start + $p.parent.nodeSize, node);
          state.tr.setSelection(TextSelection.create(state.tr.doc, start + 3));
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": ({ editor }) => {
        const item = itemAt(editor.state.selection.$head);
        if (item) {
          const tr = editor.state.tr;
          cycleKind(tr, item);
          editor.view.dispatch(tr);
          return true;
        }
        const tr = makeTask(editor.state, "todo");
        if (tr) editor.view.dispatch(tr);
        return !!tr;
      },
    };
  },
});

/** Lifts a root-level item out of its list: items before it stay a list,
 *  its own blocks become top-level blocks, items after it form a second
 *  list. (ProseMirror's liftListItem refuses lists that mix plain items and
 *  tasks, which Folio's lists do.) The cursor keeps its place in the text. */
export function liftRootItem(tr: Transaction, item: Item): Transaction {
  const $p = tr.doc.resolve(item.pos);
  const list = $p.parent;
  const listPos = $p.before();
  const index = $p.index();
  const before: PMNode[] = [];
  const after: PMNode[] = [];
  list.forEach((child, _o, i) => void (i < index ? before.push(child) : i > index && after.push(child)));
  const parts: PMNode[] = [];
  if (before.length) parts.push(list.type.create(list.attrs, before));
  item.node.forEach((child) => void parts.push(child));
  if (after.length) parts.push(list.type.create(list.attrs, after));
  const offset = tr.selection.head - (item.pos + 1);
  const start = listPos + (before.length ? parts[0].nodeSize : 0);
  tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.from(parts));
  tr.setSelection(TextSelection.create(tr.doc, Math.max(start + 1, Math.min(start + offset, tr.doc.content.size))));
  return tr;
}

/** In a card (document mode), a task line that stops being a task becomes a
 *  normal paragraph, not a bullet: a root-level item is lifted out of its
 *  list. Elsewhere (journals, nested items) it becomes a plain item. Returns
 *  null when the cursor is not in a list item. */
export function plainLine(state: EditorState, outline: boolean): Transaction | null {
  const item = itemAt(state.selection.$head);
  if (!item) return null;
  const tr = state.tr;
  if (!outline && !parentItem(state.doc, item)) return liftRootItem(tr, item);
  setTaskState(tr, item, "item");
  return tr;
}
