import type { AnyExtension } from "@tiptap/core";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { Mathematics } from "@tiptap/extension-mathematics";
import StarterKit from "@tiptap/starter-kit";
import { CardImage, FileBlock, FileInput } from "./assets";
import { BlockId, type RemoteTxPredicate } from "./blockId";
import { CardLink } from "./cardLink";
import { CodeBlock, CodeBlockKeys } from "./codeBlock";
import { BlockRef } from "./refs";
import { Tag } from "./tag";
import { RevealBlock } from "./reveal";
import { MathEditing } from "./mathEditing";
import { DragHandle } from "./outliner/dragHandle";
import { OutlineGutter } from "./outliner/gutter";
import { Autopair } from "./outliner/autopair";
import { InputFeel, KeepFocusKeys } from "./outliner/feel";
import { BlockSelection, OutlinerKeys } from "./outliner/keys";
import { OutlinePaste } from "./outliner/paste";
import { Suggestions } from "./outliner/suggest";
import { OutlineTasks } from "./outliner/tasks";
import { PasteIds } from "./pasteIds";
import { TableKeys, TableNodes } from "./table";

/** Any list holds plain items and tasks alike (Logseq: a status is a
 *  property of a block, not a kind of list). */
const LIST_CONTENT = "(listItem | taskItem)+";

/** A block: its line (a paragraph or heading), then anything else. */
const BLOCK_CONTENT = "(paragraph | heading) block*";

/** The card schema and editing behaviour, without the CRDT binding. Rules
 *  from §5.1 point 7: no extension may add content on its own on every
 *  device, because each device would add it once and a merge keeps both. */
export function baseExtensions(isRemote: RemoteTxPredicate, placeholder = "", mode: "outline" | "document" = "outline"): AnyExtension[] {
  return [
    StarterKit.configure({
      // Loro owns undo; ProseMirror history would fight it.
      undoRedo: false,
      // trailingNode appends a paragraph on every device.
      trailingNode: false,
      // Replaced by the highlighted code block below.
      codeBlock: false,
      // Autolinking runs on every device; links still work when pasted.
      link: { autolink: false, openOnClick: false },
      // Replaced below: bullet lists may hold tasks; a block's first line may
      // be a heading (as in Logseq).
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: {
        listTypes: [
          { itemName: "listItem", wrapperNames: ["bulletList", "orderedList", "taskList"] },
          { itemName: "taskItem", wrapperNames: ["taskList", "bulletList", "orderedList"] },
        ],
      },
    }),
    // Any outline item can be a task without splitting its list (§0.2).
    BulletList.extend({ content: LIST_CONTENT }),
    OrderedList.extend({ content: LIST_CONTENT }),
    ListItem.extend({ content: BLOCK_CONTENT }),
    // Kept to read task lists pasted from elsewhere; it may hold plain items
    // too, so a new line in it is never forced to be a task.
    TaskList.extend({ content: LIST_CONTENT }),
    // Tasks are made by our rules (tasks.ts), and Enter / Tab are the
    // outline's: none of TaskItem's own shortcuts.
    TaskItem.configure({ nested: true }).extend({ content: BLOCK_CONTENT, addInputRules: () => [], addKeyboardShortcuts: () => ({}) }),
    // Code with a language and syntax highlighting.
    CodeBlock,
    CodeBlockKeys,
    // Images and attachments (design/attachments.md).
    CardImage,
    FileBlock,
    // Tables (table.ts): in a card or under an outline item.
    ...TableNodes,
    TableKeys,
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
    MathEditing,
    OutlineTasks,
    OutlineGutter,
    // Outline editing rules (design/outliner.md).
    OutlinerKeys.configure({ outline: mode === "outline" }),
    BlockSelection.configure({ outline: mode === "outline" }),
    InputFeel.configure({ placeholder, outline: mode === "outline" }),
    KeepFocusKeys,
    Autopair,
    // Before the outline's paste: files on the clipboard are files.
    FileInput,
    OutlinePaste,
    Suggestions,
    DragHandle,
    CardLink,
    BlockRef,
    Tag,
    RevealBlock,
    BlockId(isRemote),
    PasteIds,
  ];
}
