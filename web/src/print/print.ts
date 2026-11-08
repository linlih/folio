// Saving a card or a journal day as a PDF file, with no print dialog
// (src-tauri/src/pdf.rs). What is on screen is copied into #print-root, the
// only thing print.css lets onto paper; the copy stays until the next
// export, since the webview may lay the page out after the call returns.

import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import "./print.css";

/** The desktop app only: phone webviews have no way to write a PDF here. */
export const canExportPdf = () =>
  backend.kind === "tauri" && !/Android|iPhone|iPad/i.test(navigator.userAgent) && !(/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 0);

/** Editor and page furniture that is not the text. The outline's gutter
 *  stays, for its bullets and task states, without its fold arrows. */
const NOT_TEXT = "button, .drag-handle, .ProseMirror-gapcursor, .ol-chevron, [data-print=no], .journal-day-menu";

/** Saves `body` under `title` as a PDF where the user picks; `title` is also
 *  the suggested file name. Its classes and its ancestors' up to the page
 *  are kept, so it is styled as on screen. */
export async function exportPdf(title: string, body: Element | null): Promise<void> {
  if (!placeContent(title, body)) return;
  try {
    const path = await backend.exportPdf(title);
    if (path) useShell.getState().setNotice(i18n.t("print.saved", { path }));
  } catch (e) {
    useShell.getState().setNotice(i18n.t("error.generic", { message: String(e) }));
  }
}

/** Puts a copy of `body` under `title` into #print-root. */
export function placeContent(title: string, body: Element | null): boolean {
  if (!body) return false;
  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.append(root);
  }
  const copy = body.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll("[contenteditable]")]) el.removeAttribute("contenteditable");
  copy.querySelectorAll(NOT_TEXT).forEach((el) => (el.matches(".ol-chevron") || !el.closest(".ol-gutter")) && el.remove());
  // The same nesting of classes, from the page down.
  let inner: Element = copy;
  for (let a = body.parentElement; a && a !== document.body; a = a.parentElement) {
    const shell = document.createElement("div");
    shell.className = a.className;
    shell.append(inner);
    inner = shell;
    if (a.classList.contains("page")) break;
  }
  const heading = document.createElement("h1");
  heading.className = "print-title";
  heading.textContent = title;
  const page = inner.classList.contains("page") ? inner : Object.assign(document.createElement("div"), { className: "page" });
  if (page !== inner) page.append(inner);
  page.prepend(heading);
  root.replaceChildren(page);
  return true;
}
