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
import type { AssetEvent, AssetInfo } from "../bindings/commands";
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
            if (asset) openFile(asset, name ?? "");
            return true;
          },
        },
      }),
      assetStates(),
    ];
  },
});

// Files not on this device (design/attachments.md §5.4). Another device
// added them and this one has not downloaded them yet: a computer downloads
// everything by itself, a phone what is looked at. An image that does not
// load asks for its file and shows, in its place and shape, how that goes;
// an attachment says "not downloaded" and downloads when opened.

/** Why a file is not shown: on its way, not downloaded, or cannot come. */
type Missing = "loading" | "absent" | "unreadable" | Extract<AssetEvent, { ready: false }>["reason"];

const missing = new Map<string, Missing>();
/** Arrivals per file, to load an image again past the failed request. */
const arrivals = new Map<string, number>();
/** Files that failed to show after they arrived: not a picture this web
 *  view can show; not asked for again. */
const showFailed = new Set<string>();
/** Files to open once they arrive, by name. */
const toOpen = new Map<string, string>();
/** Attachments whose presence was asked. */
const checked = new Set<string>();
const views = new Set<EditorView>();
let unlisten: (() => void) | null = null;

function missingText(state: Missing): string {
  return i18n.t(`assets.missing.${state === "no-sync" ? "noSync" : state}`);
}

function onAssetEvent(e: AssetEvent) {
  if (e.ready) {
    missing.delete(e.sha256);
    arrivals.set(e.sha256, (arrivals.get(e.sha256) ?? 0) + 1);
    const name = toOpen.get(e.sha256);
    toOpen.delete(e.sha256);
    if (name !== undefined) openFile(e.sha256, name);
  } else {
    missing.set(e.sha256, e.reason);
    if (toOpen.delete(e.sha256)) notify(missingText(e.reason));
  }
  views.forEach(paint);
}

/** Asks for files not here; they come as asset events. */
function request(sha256s: string[]) {
  const asked = sha256s.filter((s) => missing.get(s) !== "loading");
  if (!asked.length) return;
  for (const s of asked) missing.set(s, "loading");
  views.forEach(paint);
  backend.fetchAssets(asked).catch(() => {
    for (const s of asked) missing.set(s, "offline");
    views.forEach(paint);
  });
}

/** Opens an attachment; one not here is downloaded first, then opened. */
function openFile(sha256: string, name: string) {
  const state = missing.get(sha256);
  if (state && state !== "unreadable") {
    toOpen.set(sha256, name);
    request([sha256]);
    return;
  }
  backend.openAsset(sha256, name).catch((e) => {
    if (String(e).includes("[not-here]")) {
      toOpen.set(sha256, name);
      request([sha256]);
    } else {
      notify(i18n.t("assets.openFailed", { error: String(e) }));
    }
  });
}

/** An image's place while its file is not here: its shape, with a word on
 *  why. Grey that reads on light and dark pages alike. */
function placeholder(width: number, height: number, text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const size = Math.max(12, Math.min(width / 28, 22));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="rgba(128,128,128,0.12)"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="rgba(128,128,128,0.95)" ` +
    `font-family="-apple-system,system-ui,sans-serif" font-size="${size}">${esc}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The library address again, past what the web view remembers of the
 *  failed request (object URLs take no query). */
function freshUrl(sha256: string): string {
  const url = backend.assetUrl(sha256);
  const n = arrivals.get(sha256);
  if (!n || url.startsWith("blob:")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}r=${n}`;
}

/** Brings the editor's images and attachments in line with what is here.
 *  The nodes have no content of their own, so ProseMirror leaves these
 *  changes to their DOM alone; a node drawn again is painted again. */
function paint(view: EditorView) {
  if (view.isDestroyed) return;
  view.dom.querySelectorAll<HTMLImageElement>("img[data-asset]").forEach((img) => {
    const sha = img.dataset.asset!;
    const state = missing.get(sha);
    if (state) {
      if (img.dataset.missing === state) return;
      img.dataset.missing = state;
      img.title = missingText(state);
      img.src = placeholder(Number(img.getAttribute("width")) || 480, Number(img.getAttribute("height")) || 270, img.title);
    } else if (img.dataset.missing) {
      delete img.dataset.missing;
      img.removeAttribute("title");
      img.src = freshUrl(sha);
    }
  });
  const unknown: string[] = [];
  view.dom.querySelectorAll<HTMLElement>(".file-block[data-asset]").forEach((el) => {
    const sha = el.dataset.asset!;
    if (!checked.has(sha)) {
      checked.add(sha);
      unknown.push(sha);
    }
    const state = missing.get(sha);
    let note = el.querySelector<HTMLElement>(".file-state");
    el.classList.toggle("file-missing", !!state);
    if (!state) return note?.remove();
    if (!note) {
      note = document.createElement("span");
      note.className = "file-state";
      el.appendChild(note);
    }
    note.textContent = missingText(state);
  });
  if (unknown.length) {
    backend.assetsHere(unknown).then((here) => {
      let changed = false;
      for (const sha of unknown) {
        if (!here.includes(sha) && !missing.has(sha)) {
          missing.set(sha, "absent");
          changed = true;
        }
      }
      if (changed) views.forEach(paint);
    }, () => {});
  }
}

/** An image whose file did not load: ask for it (once; a file that came
 *  and still does not show is not a picture this web view can show). */
function onImageError(e: Event) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.asset || img.dataset.missing) return;
  const sha = img.dataset.asset;
  if (arrivals.has(sha) || showFailed.has(sha)) {
    showFailed.add(sha);
    missing.set(sha, "unreadable");
    views.forEach(paint);
    return;
  }
  request([sha]);
}

function assetStates(): Plugin {
  return new Plugin({
    key: new PluginKey("assetStates"),
    view(view) {
      views.add(view);
      unlisten ??= backend.onAssetEvent(onAssetEvent);
      // Load errors do not bubble: caught on the way down.
      view.dom.addEventListener("error", onImageError, true);
      paint(view);
      return {
        update: (v) => paint(v),
        destroy() {
          views.delete(view);
          view.dom.removeEventListener("error", onImageError, true);
        },
      };
    },
  });
}

/** Downloads every file a card uses that is not here (the card menu, on a
 *  phone, before going offline). Resolves with how many were asked for. */
export async function downloadCardFiles(json: string): Promise<number> {
  const all = [...new Set([...json.matchAll(/"asset":"([0-9a-f]{64})"/g)].map((m) => m[1]))];
  if (!all.length) return 0;
  const here = new Set(await backend.assetsHere(all));
  const absent = all.filter((s) => !here.has(s));
  request(absent);
  return absent.length;
}

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
