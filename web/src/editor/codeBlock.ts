// Code blocks with a language and syntax highlighting (TipTap's lowlight
// code block). The language is the node's `language` attribute, so it is
// stored, synced and exported (```go) like any other attribute.

import { Extension } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";
import i18n from "../i18n";

const lowlight = createLowlight(common);
lowlight.register({ dockerfile });

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
      dom.append(picker, pre);
      return {
        dom,
        contentDOM: code,
        update(next) {
          if (next.type !== node.type) return false;
          const changed = next.attrs.language !== node.attrs.language;
          node = next;
          if (changed) fill();
          return true;
        },
        stopEvent: (e) => picker.contains(e.target as Node),
        ignoreMutation: (m) => picker.contains(m.target),
      };
    };
  },
});
