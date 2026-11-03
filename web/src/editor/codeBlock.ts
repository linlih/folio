// Code blocks with a language and syntax highlighting (TipTap's lowlight
// code block). The language is the node's `language` attribute, so it is
// stored, synced and exported (```go) like any other attribute. A block in
// "mermaid" is a diagram: drawn from its source, which shows while the
// cursor is in it (as in Obsidian and Typora).

import { Extension } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";
import i18n from "../i18n";

const lowlight = createLowlight(common);
lowlight.register({ dockerfile });

/** The language of a diagram's source. */
export const DIAGRAM = "mermaid";

/** A first diagram for "/diagram" to start from. */
export const DIAGRAM_START = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -- Yes --> C[Done]\n  B -- No --> A";

const isDiagram = (language: unknown) => typeof language === "string" && language.toLowerCase() === DIAGRAM;

/** The languages offered, in the order shown (highlight.js names). */
export const LANGUAGES: [id: string, label: string][] = [
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["kotlin", "Kotlin"],
  ["swift", "Swift"],
  ["objectivec", "Objective-C"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["php", "PHP"],
  ["ruby", "Ruby"],
  ["lua", "Lua"],
  ["perl", "Perl"],
  ["r", "R"],
  ["bash", "Bash"],
  ["shell", "Shell"],
  ["sql", "SQL"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["ini", "INI / TOML"],
  ["xml", "HTML / XML"],
  ["css", "CSS"],
  ["scss", "SCSS"],
  ["less", "Less"],
  ["markdown", "Markdown"],
  ["graphql", "GraphQL"],
  ["dockerfile", "Dockerfile"],
  ["makefile", "Makefile"],
  ["diff", "Diff"],
  ["wasm", "WebAssembly"],
  [DIAGRAM, "Mermaid"],
];

/** The language's own name (aliases such as c++, golang, py work too). */
function canonical(language: string | null): string {
  if (!language) return "";
  const lower = language.toLowerCase();
  if (LANGUAGES.some(([id]) => id === lower)) return lower;
  return lowlight.registered(lower) ? lower : language;
}

/** Shift+Enter in code is a new line, as in most editors (TipTap's line
 *  break would leave the block). ↓ at the end or Enter three times still
 *  leaves it. Its own extension: a higher priority on the node itself would
 *  change which block the schema makes by default. */
export const CodeBlockKeys = Extension.create({
  name: "codeBlockKeys",
  priority: 110,
  addKeyboardShortcuts() {
    return { "Shift-Enter": ({ editor }) => editor.isActive("codeBlock") && editor.commands.insertContent("\n") };
  },
});

const editingKey = new PluginKey("diagramEditing");

/** Marks the diagram the cursor is in, which then shows its source. */
export const DiagramEditing = Extension.create({
  name: "diagramEditing",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: editingKey,
        props: {
          decorations(state) {
            const { $head } = state.selection;
            for (let d = $head.depth; d > 0; d--) {
              const node = $head.node(d);
              if (node.type.name !== "codeBlock") continue;
              if (!isDiagram(node.attrs.language)) return null;
              const at = $head.before(d);
              return DecorationSet.create(state.doc, [Decoration.node(at, at + node.nodeSize, { class: "diagram-editing" })]);
            }
            return null;
          },
        },
      }),
    ];
  },
});

export const CodeBlock = CodeBlockLowlight.configure({ lowlight, defaultLanguage: null, enableTabIndentation: false }).extend({
  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let node = initial;
      const dom = document.createElement("div");
      dom.className = "code-block";
      // The language picker: a native select (keyboard and screen reader
      // friendly), outside the editable text.
      const picker = document.createElement("select");
      picker.className = "code-language";
      picker.contentEditable = "false";
      picker.setAttribute("aria-label", i18n.t("code.language"));
      const fill = () => {
        const current = canonical(node.attrs.language as string | null);
        const options: [string, string][] = [["", i18n.t("code.plain")], ...LANGUAGES];
        // A language from a paste or another app that is not in the list.
        if (current && !options.some(([id]) => id === current)) options.push([current, current]);
        picker.replaceChildren(
          ...options.map(([id, label]) => {
            const o = document.createElement("option");
            o.value = id;
            o.textContent = label;
            return o;
          }),
        );
        picker.value = current;
      };
      fill();
      picker.addEventListener("change", () => {
        const pos = getPos();
        if (typeof pos !== "number" || !editor.isEditable) return;
        const at = editor.state.doc.nodeAt(pos);
        if (!at) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, language: picker.value || null }));
        editor.view.focus();
      });
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.append(code);
      // A diagram's drawing, outside the editable text. A click on it puts
      // the cursor in the source.
      const drawing = document.createElement("div");
      drawing.className = "diagram-drawing";
      drawing.contentEditable = "false";
      drawing.addEventListener("mousedown", (e) => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        e.preventDefault();
        const end = pos + 1 + node.content.size;
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
        editor.view.focus();
      });
      dom.append(picker, pre, drawing);
      let drawn: string | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let round = 0;
      const draw = () => {
        const diagram = isDiagram(node.attrs.language);
        dom.classList.toggle("is-diagram", diagram);
        if (!diagram) {
          drawn = null;
          drawing.replaceChildren();
          delete dom.dataset.error;
          return;
        }
        const source = node.textContent;
        if (source === drawn) return;
        const first = drawn === null;
        drawn = source;
        clearTimeout(timer);
        // While typing, once the typing pauses.
        timer = setTimeout(async () => {
          const mine = ++round;
          if (!source.trim()) {
            drawing.replaceChildren();
            dom.dataset.error = "";
            return;
          }
          const { drawDiagram } = await import("./diagram");
          const out = await drawDiagram(source);
          if (mine !== round) return;
          if ("svg" in out) {
            drawing.innerHTML = out.svg;
            delete dom.dataset.error;
          } else {
            const p = document.createElement("p");
            p.className = "diagram-error";
            p.textContent = out.error;
            drawing.replaceChildren(p);
            dom.dataset.error = "";
          }
        }, first ? 0 : 400);
      };
      draw();
      return {
        dom,
        contentDOM: code,
        update(next) {
          if (next.type !== node.type) return false;
          const changed = next.attrs.language !== node.attrs.language;
          node = next;
          if (changed) fill();
          draw();
          return true;
        },
        destroy() {
          clearTimeout(timer);
          round++;
        },
        stopEvent: (e) => picker.contains(e.target as Node) || drawing.contains(e.target as Node),
        // The drawing's own marks on the block (is-diagram, data-error)
        // are not edits.
        ignoreMutation: (m) => picker.contains(m.target) || drawing.contains(m.target) || (m.type === "attributes" && m.target === dom),
      };
    };
  },
});
