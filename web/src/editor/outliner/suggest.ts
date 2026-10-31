// The `/` command menu and the `[[` card search (design/outliner.md). The
// commands follow Logseq's `commands-map` group by group; the spec's table
// says what is covered and what waits for later milestones.

import { insertNewTable } from "../table";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Extension, type Editor, type Range } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { addDays, journalId, localDate } from "../../docs/ids";
import i18n from "../../i18n";
import { cardName } from "../../card/reveal";
import { backend } from "../../platform";
import { addFiles, pickFiles } from "../assets";
import { askText, caretAnchor } from "./popover";
import { PRIORITIES, PRIORITY_ICON, STATUSES, STATUS_ICON, type Priority } from "./statusIcons";
import { makeTask } from "./tasks";
import { childList, insertAfterLine, itemAt, itemAtPos, listOf, type Item } from "./tree";
import { TAG_STOP } from "../tag";

interface Choice {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: string;
  /** Extra words the filter matches (English names, Markdown). */
  keywords?: string;
  run: (editor: Editor, range: Range) => void | Promise<void>;
}

/** A list under the cursor, with group headings; ↑ ↓ pick, Enter runs, Esc
 *  closes. */
function popup() {
  let el: HTMLDivElement | null = null;
  let props: SuggestionProps<Choice> | null = null;
  let index = 0;

  const draw = () => {
    if (!el || !props) return;
    el.replaceChildren();
    if (props.items.length === 0) {
      const none = document.createElement("div");
      none.className = "suggest-empty";
      none.textContent = i18n.t("suggest.none");
      el.append(none);
    }
    let group = "";
    props.items.forEach((item, i) => {
      if (item.group && item.group !== group) {
        group = item.group;
        const head = document.createElement("div");
        head.className = "suggest-group";
        head.textContent = group;
        el!.append(head);
      }
      const row = document.createElement("button");
      row.className = `suggest-item${i === index ? " active" : ""}`;
      row.type = "button";
      row.innerHTML = `<span class="suggest-icon">${item.icon ?? ""}</span><span class="suggest-label"></span>`;
      row.querySelector(".suggest-label")!.textContent = item.label;
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "suggest-hint";
        hint.textContent = item.hint;
        row.append(hint);
      }
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => props?.command(item));
      el!.append(row);
      if (i === index) queueMicrotask(() => row.scrollIntoView?.({ block: "nearest" }));
    });
    const rect = props.clientRect?.();
    if (!rect) return;
    const anchor = { getBoundingClientRect: () => rect };
    void computePosition(anchor, el, { placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
      if (el) Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
    });
  };

  return {
    onStart(p: SuggestionProps<Choice>) {
      props = p;
      index = 0;
      el = document.createElement("div");
      el.className = "suggest popup";
      el.setAttribute("role", "listbox");
      document.body.append(el);
      draw();
    },
    onUpdate(p: SuggestionProps<Choice>) {
      props = p;
      index = Math.min(index, Math.max(0, p.items.length - 1));
      draw();
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (!props) return false;
      const n = props.items.length;
      if (event.key === "ArrowDown") index = n ? (index + 1) % n : 0;
      else if (event.key === "ArrowUp") index = n ? (index - 1 + n) % n : 0;
      else if (event.key === "Enter" || event.key === "Tab") {
        const item = props.items[index];
        if (item) props.command(item);
        return true;
      } else if (event.key === "Escape") {
        el?.remove();
        el = null;
        return true;
      } else return false;
      draw();
      return true;
    },
    onExit() {
      el?.remove();
      el = null;
      props = null;
    },
  };
}

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

// ---- helpers the commands share ----

/** Removes the typed `/query`; returns the transaction to build on. */
const clear = (editor: Editor, range: Range) => editor.state.tr.delete(range.from, range.to);

/** True in outlines (journals), false in document-mode cards. */
const isOutline = (editor: Editor) =>
  (editor.extensionManager.extensions.find((e) => e.name === "outlinerKeys")?.options as { outline?: boolean } | undefined)?.outline !== false;

/** The block at the cursor, made into an item if it is a plain paragraph
 *  (block properties live on items, as on Logseq's blocks). In a card the
 *  paragraph becomes a task rather than a bullet: priority and dates are
 *  task properties there (design/outliner.md "任务"). */
function ensureItem(tr: Transaction, outline: boolean): Item | null {
  const { $head } = tr.selection;
  const item = itemAt($head);
  if (item) return item;
  if ($head.depth !== 1 || !$head.parent.isTextblock) return null;
  const { schema } = tr.doc.type;
  const start = $head.before();
  const line = schema.nodes.paragraph.create(null, $head.parent.content);
  const node = schema.nodes.bulletList.create(null, outline ? schema.nodes.listItem.create(null, line) : schema.nodes.taskItem.create(null, line));
  tr.replaceWith(start, start + $head.parent.nodeSize, node);
  tr.setSelection(TextSelection.create(tr.doc, start + 3 + $head.parentOffset));
  return itemAtPos(tr.doc, start + 1);
}

/** Inserts a block-level node: inside the current block, after its line;
 *  outside lists, after the current paragraph (in place of it if empty). */
export function insertBlock(editor: Editor, range: Range, node: PMNode | PMNode[], focusInside = false) {
  editor.view.dispatch(insertAfterLine(clear(editor, range), node, focusInside).scrollIntoView());
}

/** Turns the current line into a heading, or back into normal text. */
function setLine(editor: Editor, range: Range, level: number | null) {
  const tr = clear(editor, range);
  const { $head } = tr.selection;
  if (!$head.parent.isTextblock) return void editor.view.dispatch(tr);
  const { schema } = tr.doc.type;
  const keep = { bid: $head.parent.attrs.bid, source: $head.parent.attrs.source };
  tr.setNodeMarkup($head.before(), level ? schema.nodes.heading : schema.nodes.paragraph, level ? { ...keep, level } : keep);
  editor.view.dispatch(tr);
}

function setItemAttr(editor: Editor, range: Range, name: string, value: unknown) {
  const tr = clear(editor, range);
  const item = ensureItem(tr, isOutline(editor));
  if (!item) return void editor.view.dispatch(tr);
  tr.setNodeAttribute(item.pos, name, value);
  editor.view.dispatch(tr);
}

/** Removes the `/query` and asks for a value next to where it was. */
const ask = (editor: Editor, range: Range, opts: Parameters<typeof askText>[1]) => {
  const anchor = caretAnchor(editor.view, range.from);
  editor.view.dispatch(clear(editor, range));
  return askText(anchor, opts).finally(() => editor.view.focus());
};

const here = (editor: Editor): Range => ({ from: editor.state.selection.from, to: editor.state.selection.from });

/** A link to a journal day (Logseq links the journal page). */
function journalLink(editor: Editor, date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const title = new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(new Date(y, m - 1, d));
  editor.chain().insertContent({ type: "cardLink", attrs: { cardId: journalId(date), title } }).run();
}

/** Toggles a list between bullets and numbers. */
function toggleNumbered(editor: Editor, range: Range, children: boolean) {
  const tr = clear(editor, range);
  const item = itemAt(tr.selection.$head);
  const { schema } = tr.doc.type;
  if (!item) {
    editor.view.dispatch(tr);
    editor.commands.toggleOrderedList();
    return;
  }
  const list = children ? childList(tr.doc, item) : listOf(tr.doc, item);
  if (!list || list.pos < 0) return void editor.view.dispatch(tr);
  const numbered = list.node.type.name === "orderedList";
  tr.setNodeMarkup(list.pos, numbered ? schema.nodes.bulletList : schema.nodes.orderedList);
  editor.view.dispatch(tr);
}

// ---- the commands, in Logseq's groups ----

const svg = (path: string) =>
  `<svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICON = {
  ref: svg(`<path d="M7 4H4v12h3M13 4h3v12h-3"/>`),
  link: svg(`<path d="M8.5 11.5l3-3M7 9.5l-1.8 1.8a2.5 2.5 0 003.5 3.5L10.5 13M13 10.5l1.8-1.8a2.5 2.5 0 00-3.5-3.5L9.5 7"/>`),
  image: svg(`<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="M4 14l4-4 3 3 2-2 3 3"/>`),
  file: svg(`<path d="M11.5 3H6a1.5 1.5 0 00-1.5 1.5v11A1.5 1.5 0 006 17h8a1.5 1.5 0 001.5-1.5V7z"/><path d="M11.5 3v4h4"/>`),
  underline: svg(`<path d="M6 4v5a4 4 0 008 0V4M5 16h10"/>`),
  code: svg(`<path d="M7.5 6L4 10l3.5 4M12.5 6L16 10l-3.5 4"/>`),
  table: svg(`<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M3 12h14M8 4v12"/>`),
  quote: svg(`<path d="M5 6h4v4c0 2-1 3-3 4M11 6h4v4c0 2-1 3-3 4"/>`),
  math: svg(`<path d="M15 5H6l4 5-4 5h9"/>`),
  text: svg(`<path d="M5 5h10M10 5v10"/>`),
  heading: (n: number) => svg(`<path d="M3.5 5v10M9.5 5v10M3.5 10h6"/><text x="12" y="15.5" font-size="8" fill="currentColor" stroke="none">${n}</text>`),
  calendar: svg(`<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>`),
  clock: svg(`<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>`),
  numbered: svg(`<path d="M9 5.5h7M9 10h7M9 14.5h7M4 4.5l1-.5v3"/>`),
};

function slashChoices(): Choice[] {
  const g = (k: string) => t(`slash.group.${k}`);
  return [
    // basic
    {
      id: "ref", group: g("basic"), label: t("slash.ref"), hint: "[[", icon: ICON.ref, keywords: "page card link reference",
      run: (editor, range) => {
        const tr = editor.state.tr.insertText("[[]]", range.from, range.to);
        editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, range.from + 2)));
      },
    },
    // format
    {
      id: "link", group: g("format"), label: t("slash.link"), icon: ICON.link, keywords: "link url",
      run: async (editor, range) => {
        const url = (await ask(editor, range, { label: t("slash.linkAsk"), type: "url", placeholder: "https://" }))?.trim();
        if (url) editor.chain().focus().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
      },
    },
    {
      id: "image", group: g("format"), label: t("slash.image"), icon: ICON.image, keywords: "image picture photo img tupian",
      run: async (editor, range) => {
        editor.view.dispatch(clear(editor, range));
        const files = await pickFiles("image/*");
        if (files.length) await addFiles(editor.view, files);
      },
    },
    {
      id: "file", group: g("format"), label: t("slash.file"), icon: ICON.file, keywords: "file attachment pdf upload fujian",
      run: async (editor, range) => {
        editor.view.dispatch(clear(editor, range));
        const files = await pickFiles("");
        if (files.length) await addFiles(editor.view, files);
      },
    },
    {
      id: "imageUrl", group: g("format"), label: t("slash.imageUrl"), icon: ICON.image, keywords: "image url link web",
      run: async (editor, range) => {
        const url = (await ask(editor, range, { label: t("slash.imageAsk"), type: "url", placeholder: "https://" }))?.trim();
        if (url) insertBlock(editor, here(editor), editor.schema.nodes.image.create({ src: url }));
      },
    },
    {
      id: "underline", group: g("format"), label: t("slash.underline"), icon: ICON.underline, keywords: "underline ins",
      run: (editor, range) => {
        editor.view.dispatch(clear(editor, range));
        editor.commands.toggleUnderline();
      },
    },
    {
      id: "code", group: g("format"), label: t("slash.code"), hint: "```", icon: ICON.code, keywords: "code block",
      run: (editor, range) => insertBlock(editor, range, editor.schema.nodes.codeBlock.create(), true),
    },
    {
      id: "table", group: g("format"), label: t("slash.table"), hint: "| |", icon: ICON.table, keywords: "table grid sheet biaoge",
      run: (editor, range) => insertNewTable(editor, range),
    },
    {
      id: "quote", group: g("format"), label: t("slash.quote"), hint: ">", icon: ICON.quote, keywords: "quote blockquote",
      run: (editor, range) => {
        const tr = clear(editor, range);
        const item = itemAt(tr.selection.$head);
        if (!item) {
          editor.view.dispatch(tr);
          editor.commands.toggleBlockquote();
          return;
        }
        tr.setNodeAttribute(item.pos, "display", item.node.attrs.display === "quote" ? null : "quote");
        editor.view.dispatch(tr);
      },
    },
    {
      id: "math", group: g("format"), label: t("slash.math"), hint: "$$", icon: ICON.math, keywords: "math latex formula katex",
      run: async (editor, range) => {
        const latex = await ask(editor, range, { label: t("slash.mathEdit"), multiline: true, placeholder: "E = mc^2" });
        if (latex) insertBlock(editor, here(editor), editor.schema.nodes.blockMath.create({ latex }));
      },
    },
    // headings
    { id: "text", group: g("heading"), label: t("slash.text"), icon: ICON.text, keywords: "normal text paragraph clear heading", run: (e, r) => setLine(e, r, null) },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      id: `h${n}`, group: g("heading"), label: t("slash.heading", { level: n }), hint: "#".repeat(n), icon: ICON.heading(n), keywords: `heading h${n}`,
      run: (e: Editor, r: Range) => setLine(e, r, n),
    })),
    // task status
    ...STATUSES.map((s) => ({
      id: s, group: g("task"), label: t(`task.${s}`), icon: `<span class="status-${s}">${STATUS_ICON[s]}</span>`, keywords: `task status ${s}`,
      run: (editor: Editor, range: Range) => {
        editor.view.dispatch(clear(editor, range));
        const tr = makeTask(editor.state, s);
        if (tr) editor.view.dispatch(tr);
      },
    })),
    // task dates
    ...(["deadline", "scheduled"] as const).map((k) => ({
      id: k, group: g("date"), label: t(`task.${k}`), icon: ICON.calendar, keywords: `${k} date due`,
      run: async (editor: Editor, range: Range) => {
        const date = await ask(editor, range, { label: t(`task.${k}`), type: "date" });
        if (date) setItemAttr(editor, here(editor), k, date);
      },
    })),
    // priority
    { id: "priority-none", group: g("priority"), label: t("priority.none"), keywords: "priority none", run: (e, r) => setItemAttr(e, r, "priority", null) },
    ...PRIORITIES.map((p: Priority) => ({
      id: `priority-${p}`, group: g("priority"), label: t(`priority.${p}`), icon: `<span class="priority-${p}">${PRIORITY_ICON[p]}</span>`, keywords: `priority ${p}`,
      run: (e: Editor, r: Range) => setItemAttr(e, r, "priority", p),
    })),
    // time and date
    ...([["today", 0], ["tomorrow", 1], ["yesterday", -1]] as const).map(([k, delta]) => ({
      id: k, group: g("time"), label: t(`slash.${k}`), icon: ICON.calendar, keywords: `${k} date journal`,
      run: (editor: Editor, range: Range) => {
        editor.view.dispatch(clear(editor, range));
        journalLink(editor, addDays(localDate(new Date()), delta));
      },
    })),
    {
      id: "time", group: g("time"), label: t("slash.time"), icon: ICON.clock, keywords: "time now clock",
      run: (editor, range) => {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        editor.view.dispatch(clear(editor, range).insertText(hhmm));
      },
    },
    {
      id: "date", group: g("time"), label: t("slash.datePicker"), icon: ICON.calendar, keywords: "date picker journal",
      run: async (editor, range) => {
        const date = await ask(editor, range, { label: t("slash.datePicker"), type: "date" });
        if (date) journalLink(editor, date);
      },
    },
    // list type
    { id: "numbered", group: g("list"), label: t("slash.numbered"), hint: "1.", icon: ICON.numbered, keywords: "number ordered list", run: (e, r) => toggleNumbered(e, r, false) },
    { id: "numbered-children", group: g("list"), label: t("slash.numberedChildren"), icon: ICON.numbered, keywords: "number children ordered", run: (e, r) => toggleNumbered(e, r, true) },
  ];
}

const matches = (choice: Choice, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [choice.label, choice.id, choice.hint ?? "", choice.keywords ?? ""].some((s) => s.toLowerCase().includes(q));
};

// ---- `[[` card search ----

/** Replaces `[[query]]` with a link to the card. */
function linkCard(editor: Editor, range: Range, cardId: string, title: string) {
  const { doc } = editor.state;
  const to = doc.textBetween(range.to, Math.min(doc.content.size, range.to + 2), "", "￼") === "]]" ? range.to + 2 : range.to;
  editor.chain().insertContentAt({ from: range.from, to }, { type: "cardLink", attrs: { cardId, title } }).run();
}

async function cardChoices(query: string): Promise<Choice[]> {
  const q = query.trim();
  const rows = await backend.listCards(500);
  const hits = rows.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const out: Choice[] = hits.map((r) => ({
    id: r.id,
    group: "",
    label: r.title || i18n.t("library.untitled"),
    icon: ICON.ref,
    run: (editor, range) => linkCard(editor, range, r.id, r.title),
  }));
  if (q && !rows.some((r) => r.title === q)) {
    out.unshift({
      id: "new",
      group: "",
      label: i18n.t("suggest.newCard", { title: q }),
      run: async (editor, range) => {
        const id = await backend.createCard(q);
        linkCard(editor, range, id, q);
        window.dispatchEvent(new Event("folio:cards-changed"));
      },
    });
  }
  return out;
}

// ---- `((` block search ----

async function blockChoices(query: string): Promise<Choice[]> {
  const q = query.replace(/\)+$/, "").trim();
  if (!q) return [];
  const hits = (await backend.search(q, 30)).filter((h) => h.bid && h.text.trim());
  return hits.slice(0, 10).map((h) => ({
    id: h.bid!,
    group: "",
    label: h.text.length > 80 ? `${h.text.slice(0, 80)}…` : h.text,
    hint: cardName(h.cardId, h.cardTitle),
    icon: ICON.ref,
    run: (editor: Editor, range: Range) => {
      const { doc } = editor.state;
      const to = doc.textBetween(range.to, Math.min(doc.content.size, range.to + 2), "", "\ufffc") === "))" ? range.to + 2 : range.to;
      editor.chain().insertContentAt({ from: range.from, to }, { type: "blockRef", attrs: { bid: h.bid, cardId: h.cardId } }).run();
    },
  }));
}

// ---- `#` tags ----

/** Replaces `#query` with a tag and a space. */
function insertTag(editor: Editor, range: Range, name: string) {
  editor.chain().insertContentAt(range, [{ type: "tag", attrs: { name } }, { type: "text", text: " " }]).run();
}

async function tagChoices(query: string): Promise<Choice[]> {
  const q = query.trim();
  const tags = await backend.tags(500);
  const hits = tags.filter((t) => !q || t.key.includes(q.toLowerCase())).slice(0, 8);
  const out: Choice[] = hits.map((t) => ({
    id: `tag:${t.key}`,
    group: "",
    label: `#${t.name}`,
    hint: String(t.blocks),
    run: (editor, range) => insertTag(editor, range, t.name),
  }));
  if (q && !tags.some((t) => t.key === q.toLowerCase())) {
    out.push({ id: "new", group: "", label: i18n.t("suggest.newTag", { name: q }), run: (editor, range) => insertTag(editor, range, q) });
  }
  return out;
}

/** For tests: the commands with their ids. */
export const _slashChoices = slashChoices;

export const Suggestions = Extension.create({
  name: "suggestions",
  // An open popup gets ↑ ↓ Enter Esc before the outline keys and block
  // selection do.
  priority: 1200,
  addProseMirrorPlugins() {
    const run = ({ editor, range, props }: { editor: Editor; range: Range; props: Choice }) => void props.run(editor, range);
    return [
      Suggestion<Choice>({
        editor: this.editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        // Not inside words or URLs ("a/b", "http://").
        allowedPrefixes: [" ", "　"],
        items: ({ query }) => slashChoices().filter((c) => matches(c, query)),
        command: run,
        render: popup,
      }),
      Suggestion<Choice>({
        editor: this.editor,
        pluginKey: new PluginKey("blockSearch"),
        char: "((",
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => blockChoices(query),
        command: run,
        render: popup,
      }),
      Suggestion<Choice>({
        editor: this.editor,
        pluginKey: new PluginKey("tagSearch"),
        char: "#",
        // Only at a word's start: not in "C#" or URLs' "#anchor".
        allowedPrefixes: [" ", "　"],
        // A tag name has no spaces or punctuation; nor do headings start
        // with one ("# " closes the list and makes a heading).
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => (new RegExp(`[${TAG_STOP}]`).test(query) ? [] : tagChoices(query)),
        command: run,
        render: popup,
      }),
      Suggestion<Choice>({
        editor: this.editor,
        pluginKey: new PluginKey("cardSearch"),
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => cardChoices(query.replace(/\]+$/, "")),
        command: run,
        render: popup,
      }),
    ];
  },
});
