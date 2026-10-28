// Images and attachments in cards (design/attachments.md §3–§4): the nodes,
// and adding files by pasting, dropping or picking them. A node holds the
// file's hash and what is needed to show it before the file is here (name,
// type, size, pixel size); the address to read it from is worked out when
// shown, never stored, since it differs between systems.

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { AssetInfo } from "../bindings/commands";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { insertAfterLine } from "./outliner/tree";

/** The largest file a card can hold (same as folio_store::assets). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);

/** Attributes every file node carries besides the hash. */
const fileAttributes = {
  asset: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-asset"), renderHTML: (a: Record<string, unknown>) => (a.asset ? { "data-asset": a.asset } : {}) },
  name: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-name"), renderHTML: (a: Record<string, unknown>) => (a.name ? { "data-name": a.name } : {}) },
  mime: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-mime"), renderHTML: (a: Record<string, unknown>) => (a.mime ? { "data-mime": a.mime } : {}) },
  size: { default: null, parseHTML: (el: HTMLElement) => int(el.getAttribute("data-size")), renderHTML: (a: Record<string, unknown>) => (a.size != null ? { "data-size": a.size } : {}) },
};

/** An image: a web address (`src`) or a file in the library (`asset`).
 *  `width` / `height` are the picture's pixels, so the page keeps its
 *  shape while it loads. */
export const CardImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-asset") ? null : el.getAttribute("src")),
        renderHTML: (a: Record<string, unknown>) => ({ src: a.asset ? backend.assetUrl(a.asset as string) : a.src }),
      },
      width: { default: null, parseHTML: (el: HTMLElement) => int(el.getAttribute("width")) },
      height: { default: null, parseHTML: (el: HTMLElement) => int(el.getAttribute("height")) },
      ...fileAttributes,
    };
  },
}).configure({ inline: false });

/** "3.2 MB" */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** An attachment: one line with the file's name and size; clicking the
 *  name opens it with the system's app. */
export const FileBlock = Node.create({
  name: "file",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => fileAttributes,
  parseHTML: () => [{ tag: 'div[data-type="file"]' }],
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "file", class: "file-block", contenteditable: "false" }),
      ["span", { class: "file-icon", "aria-hidden": "true" }],
      ["span", { class: "file-name", role: "link", tabindex: "-1", title: i18n.t("assets.open") }, (node.attrs.name as string | null) || i18n.t("assets.untitled")],
      ["span", { class: "file-size" }, formatSize(node.attrs.size as number | null)],
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("fileBlockOpen"),
        props: {
          handleClickOn(_view, _pos, node, _nodePos, event) {
            if (node.type.name !== "file" || !(event.target as HTMLElement | null)?.closest(".file-name")) return false;
            const { asset, name } = node.attrs as { asset: string | null; name: string | null };
            if (asset) backend.openAsset(asset, name ?? "").catch((e) => notify(i18n.t("assets.openFailed", { error: String(e) })));
            return true;
          },
        },
      }),
    ];
  },
});

function notify(text: string | null) {
  useShell.getState().setNotice(text);
}

/** The picture's size in pixels as the page will show it (orientation
 *  applied); null when the web view cannot read it. */
async function pixels(url: string): Promise<{ width: number; height: number } | null> {
  if (!url || typeof window === "undefined" || typeof window.Image === "undefined") return null;
  const img = new window.Image();
  img.src = url;
  try {
    await img.decode();
    return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch {
    return null;
  }
}

/** The node for an added file: an image when the web view can show it. */
export async function nodeFor(schema: Schema, info: AssetInfo): Promise<PMNode> {
  const attrs = { asset: info.sha256, name: info.name, mime: info.mime, size: info.size };
  if (info.mime.startsWith("image/")) {
    const size = await pixels(backend.assetUrl(info.sha256));
    if (size) return schema.nodes.image.create({ ...attrs, alt: info.name, ...size });
  }
  return schema.nodes.file.create(attrs);
}

/** Adds the files to the library, then puts them after the current block
 *  in their order. Files too large are left out with a message. */
export async function addFiles(view: EditorView, files: File[]): Promise<void> {
  const nodes: PMNode[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      notify(i18n.t("assets.tooLarge", { name: file.name, mb: MAX_FILE_BYTES / 1024 / 1024 }));
      continue;
    }
    if (file.size > 5 * 1024 * 1024) notify(i18n.t("assets.adding", { name: file.name }));
    try {
      nodes.push(await nodeFor(view.state.schema, await backend.addAsset(file)));
    } catch (e) {
      notify(i18n.t("assets.failed", { name: file.name, error: String(e) }));
    }
  }
  if (!nodes.length || view.isDestroyed) return;
  if (files.some((f) => f.size > 5 * 1024 * 1024)) notify(null);
  view.dispatch(insertAfterLine(view.state.tr, nodes).scrollIntoView());
  view.focus();
}

/** Asks for files with the system's picker (on phones: photos, camera or
 *  files); resolves with none when cancelled. */
export function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (accept) input.accept = accept;
    input.style.display = "none";
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done([...(input.files ?? [])]));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** Files on the clipboard to add as files: a screenshot, an image copied
 *  from a page, files copied in Finder. Rich text that also carries
 *  pictures (a Word paragraph) pastes as text. */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (!files.length) return [];
  const text = data.getData("text/plain").trim();
  const html = data.getData("text/html");
  return !text || !html ? files : [];
}

/** Pasting and dropping files from outside. Runs ahead of the outline's own
 *  paste handling (extensions.ts). */
export const FileInput = Extension.create({
  name: "fileInput",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("fileInput"),
        props: {
          handlePaste(view, event) {
            const files = clipboardFiles(event.clipboardData);
            if (!files.length) return false;
            void addFiles(view, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            const files = moved ? [] : Array.from(event.dataTransfer?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
            void addFiles(view, files);
            return true;
          },
        },
      }),
    ];
  },
});
