// One card or journal day as Markdown: copy to the clipboard, or save as a
// file (the whole library: Settings → Export as Markdown).

import { docs } from "../app";
import i18n from "../i18n";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";

const notice = (text: string) => useShell.getState().setNotice(text);
const unavailable = () => notice(i18n.t("settings.diagnosticsUnavailable"));

/** Copies the card as Markdown. The clipboard item is filled by a promise:
 *  WebKit only allows writing during the click, and the text comes from the
 *  backend a moment later. */
export async function copyMarkdown(cardId: string) {
  const text = docs()
    .flushAll()
    .then(() => backend.cardMarkdown(cardId));
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const blob = text.then((t) => {
        if (t === null) throw new Error("unsupported");
        return new Blob([t], { type: "text/plain" });
      });
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      const t = await text;
      if (t === null) return unavailable();
      await navigator.clipboard.writeText(t);
    }
    notice(i18n.t("markdown.copied"));
  } catch (e) {
    const reason = await text.then(
      (t) => (t === null ? "unsupported" : String(e)),
      (err) => String(err),
    );
    if (reason === "unsupported") return unavailable();
    notice(empty(reason) ? i18n.t("markdown.empty") : i18n.t("error.generic", { message: reason }));
  }
}

/** A journal day nobody wrote yet has no document. */
const empty = (message: string) => message.includes("unknown document") || message.includes("NotFound");

/** Saves the card as a Markdown file; `name` is the suggested file name. */
export async function exportCardMarkdown(cardId: string, name: string) {
  try {
    await docs().flushAll();
    if (backend.kind !== "tauri") return unavailable();
    const path = await backend.exportCard(cardId, name || i18n.t("library.untitled"));
    if (path) notice(i18n.t("markdown.saved", { path }));
  } catch (e) {
    notice(empty(String(e)) ? i18n.t("markdown.empty") : i18n.t("error.generic", { message: String(e) }));
  }
}
