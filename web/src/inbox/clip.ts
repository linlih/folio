// Keeping links in the inbox (design/inbox-and-tags.md §2): from text that
// holds a link (pasted, or shared from another app) to a card with the
// page's title, site and summary.

import { create } from "zustand";
import i18n from "../i18n";
import { CARDS_CHANGED, cardsChanged } from "../card/actions";
import { backend } from "../platform";
import { layoutRestored } from "../shell/layout";
import { useShell } from "../shell/tabs";

/** The first web link in a piece of text, and the text around it. Share
 *  sheets send "Title https://…" or "Title\nhttps://…"; a trailing
 *  punctuation mark is not part of the link. */
export function firstUrl(text: string): { url: string; rest: string } | null {
  const m = /https?:\/\/[^\s<>"'“”‘’（）【】《》，。！？]+/i.exec(text);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]}>]+$/, "");
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return { url, rest };
}

/** What of the shared text to keep as a note: nothing when it only repeats
 *  the page's title (a browser shares the title with the link). */
export function noteFrom(rest: string, title: string): string {
  const a = rest.replace(/\s+/g, " ").trim();
  const b = title.replace(/\s+/g, " ").trim();
  // Part of the title, or the title with a few characters around it (a
  // site's name); longer text holds words of the person's own.
  if (!a || (b && (b.includes(a) || (a.includes(b) && a.length - b.length < 12)))) return "";
  return rest;
}

/** The inbox's size, for the sidebar and the phone's bottom bar. */
export const useInboxCount = create<{ count: number }>(() => ({ count: 0 }));

export async function reloadInboxCount() {
  try {
    useInboxCount.setState({ count: (await backend.inbox()).length });
  } catch {
    // Kept as it was; the next change tries again.
  }
}

/** Lists of the inbox listen for this to reload. */
export const INBOX_CHANGED = "folio:inbox-changed";
export function inboxChanged() {
  window.dispatchEvent(new Event(INBOX_CHANGED));
  void reloadInboxCount();
  cardsChanged();
}

/** Keeps `text` in the inbox: its first link as a clipped page, the words
 *  around it as a note. A page that cannot be read is kept as the bare
 *  link, with those words as its title. Text without a link is kept as a
 *  note, its first line the title. */
export async function saveClip(text: string): Promise<{ id: string; fetched: boolean }> {
  const found = firstUrl(text);
  if (!found) {
    const lines = text.trim().split("\n");
    if (!lines[0]) throw new Error("[empty] nothing to keep");
    const title = Array.from(lines[0].trim()).slice(0, 60).join("");
    const id = await backend.clipCreate(title, { url: "", site: "", excerpt: "", author: "" }, text.trim() === title ? "" : text.trim());
    inboxChanged();
    return { id, fetched: true };
  }
  const p = await backend.clipPreview(found.url);
  const title = p.fetched || !found.rest ? p.title : found.rest.split("\n")[0];
  const note = p.fetched ? noteFrom(found.rest, p.title) : found.rest.split("\n").slice(1).join("\n");
  const id = await backend.clipCreate(title, { url: p.url, site: p.site, excerpt: p.excerpt, author: p.author }, note);
  inboxChanged();
  return { id, fetched: p.fetched };
}

/** A failed save in words. */
export function clipErrorText(e: unknown): string {
  const raw = String(e);
  if (raw.includes("[not-a-link]")) return i18n.t("inbox.notALink");
  return i18n.t("error.generic", { message: raw.replace(/^Error: /, "") });
}

/** A text being kept in the inbox, shown at the top of its list until its
 *  card is there: while the page is read (that can take a while), and,
 *  should it fail, with the reason, to try again or let go. Kept in this
 *  device's storage too, so a share is not lost when the app is closed
 *  before it is saved: it comes back as failed, to try again. */
export type PendingClip = { key: string; text: string; state: "saving" | "failed"; error?: string };

const PENDING = "folio.pendingClips";

function loadPending(): PendingClip[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING) || "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is PendingClip => !!x && typeof x.key === "string" && typeof x.text === "string")
      .map((x) => ({ key: x.key, text: x.text, state: "failed" as const, error: x.state === "failed" ? x.error : undefined }));
  } catch {
    return [];
  }
}

export const usePendingClips = create<{ items: PendingClip[]; justSaved: string | null }>(() => ({ items: loadPending(), justSaved: null }));

function setPending(change: (items: PendingClip[]) => PendingClip[]) {
  const items = change(usePendingClips.getState().items);
  usePendingClips.setState({ items });
  try {
    if (items.length) localStorage.setItem(PENDING, JSON.stringify(items));
    else localStorage.removeItem(PENDING);
  } catch {
    // Shown here still; only not kept past a restart.
  }
}

let counter = 0;
const newKey = () => `${Date.now()}-${counter++}`;

/** Shows `text` at the top of the inbox as being saved. */
function showSaving(text: string, key: string) {
  setPending((items) => [{ key, text, state: "saving" }, ...items.filter((x) => x.key !== key)]);
}

/** Lets go of a text that could not be saved. */
export function dropPending(key: string) {
  setPending((items) => items.filter((x) => x.key !== key));
}

/** Keeps `text` in the inbox (saveClip), shown in its list while that
 *  takes, and says how it went. What failed stays listed, to try again
 *  (pass its key); text with nothing to keep does not. */
export async function keepClip(text: string, key = newKey()): Promise<boolean> {
  showSaving(text, key);
  const shell = useShell.getState();
  try {
    const { id, fetched } = await saveClip(text);
    dropPending(key);
    usePendingClips.setState({ justSaved: id });
    setTimeout(() => usePendingClips.getState().justSaved === id && usePendingClips.setState({ justSaved: null }), 2000);
    shell.setNotice(i18n.t(fetched ? "inbox.saved" : "inbox.savedBare"));
    return true;
  } catch (e) {
    const error = clipErrorText(e);
    if (/\[(empty|not-a-link)\]/.test(String(e))) dropPending(key);
    else setPending((items) => items.map((x) => (x.key === key ? { ...x, state: "failed", error } : x)));
    shell.setNotice(error);
    return false;
  }
}

/** Picks up what other apps shared to Folio (the Android or iOS share
 *  sheet): when the app starts and each time it comes back to the front.
 *  iOS may have kept several shares; each is one call. Each shows in the
 *  inbox at once, as being saved. */
export function receiveShares() {
  let busy = false;
  const take = async () => {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      for (let text = await backend.takeShared(); text; text = await backend.takeShared()) {
        const key = newKey();
        showSaving(text, key);
        // At a cold start, after the saved tabs are back (or 3 s at most).
        await Promise.race([layoutRestored(), new Promise((r) => setTimeout(r, 3000))]);
        useShell.getState().open({ kind: "inbox" });
        await keepClip(text, key);
      }
    } catch {
      // Nothing shared, or the host cannot say.
    } finally {
      busy = false;
    }
  };
  void take();
  document.addEventListener("visibilitychange", () => void take());
  // Cards change here and on other devices (sync).
  window.addEventListener(CARDS_CHANGED, () => void reloadInboxCount());
  void reloadInboxCount();
}
