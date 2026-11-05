import { Check, ClipboardPaste, ExternalLink, Inbox, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { appUndo, docs } from "../app";
import type { InboxItem } from "../bindings/commands";
import { CARDS_CHANGED, moveToTrash } from "../card/actions";
import { backend } from "../platform";
import { EmptyState } from "../shell/EmptyState";
import { toSide, useShell } from "../shell/tabs";
import { dropPending, firstUrl, INBOX_CHANGED, inboxChanged, keepClip, type PendingClip, usePendingClips } from "./clip";
import "./inbox.css";

/** Takes a card out of the inbox, or puts it back, and refreshes it where
 *  it is open (the host made the change). */
export async function markDealtWith(id: string, done: boolean) {
  await backend.setInbox(id, !done);
  await docs().refresh([id]);
  inboxChanged();
}

/** The inbox (design/inbox-and-tags.md §2): links kept to read later, until
 *  each is dealt with. Paste a link here, or share one from another app. */
export function InboxView({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const { open, setNotice } = useShell();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [text, setText] = useState("");
  const pending = usePendingClips((s) => s.items);
  const justSaved = usePendingClips((s) => s.justSaved);

  const reload = useCallback(() => {
    backend.inbox().then(setItems, (e) => setNotice(t("error.generic", { message: String(e) })));
  }, [setNotice, t]);

  useEffect(() => {
    if (!active) return;
    reload();
    window.addEventListener(INBOX_CHANGED, reload);
    window.addEventListener(CARDS_CHANGED, reload);
    return () => {
      window.removeEventListener(INBOX_CHANGED, reload);
      window.removeEventListener(CARDS_CHANGED, reload);
    };
  }, [active, reload]);

  // Shown at the top of the list while it saves; the box is free at once.
  async function save(value: string) {
    if (!value.trim()) return;
    setText("");
    await keepClip(value);
  }

  async function paste() {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) await save(clip);
      else setNotice(t("inbox.clipboardEmpty"));
    } catch {
      setNotice(t("inbox.clipboardBlocked"));
    }
  }

  async function done(item: InboxItem) {
    try {
      await markDealtWith(item.id, true);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
      return;
    }
    appUndo.push({ label: "inbox", undo: () => markDealtWith(item.id, false), redo: () => markDealtWith(item.id, true) });
    setNotice(t("inbox.done", { title: item.title || t("library.untitled") }), { undo: true });
  }

  const date = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="page inbox">
      <header className="page-header">
        <h1>{t("inbox.title")}</h1>
        {items && items.length > 0 && <span className="page-meta">{t("inbox.count", { count: items.length })}</span>}
      </header>
      <form
        className="inbox-add"
        onSubmit={(e) => {
          e.preventDefault();
          void save(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("inbox.placeholder")}
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="done"
        />
        {text.trim() ? (
          <button type="submit" className="button primary">
            {t("inbox.save")}
          </button>
        ) : (
          <button type="button" className="button" onClick={() => void paste()}>
            <ClipboardPaste size={14} />
            {t("inbox.paste")}
          </button>
        )}
      </form>
      {items?.length === 0 && pending.length === 0 && <EmptyState icon={<Inbox size={28} strokeWidth={1.5} />} title={t("inbox.empty")} hint={t("inbox.emptyHint")} />}
      {(pending.length > 0 || (items && items.length > 0)) && (
        <ul className="inbox-list">
          {pending.map((p) => (
            <PendingRow key={p.key} clip={p} />
          ))}
          {items?.map((item) => (
            <li key={item.id} className={`inbox-item${item.id === justSaved ? " just-saved" : ""}`}>
              <button className="inbox-open" onClick={(e) => open({ kind: "card", cardId: item.id }, item.title, toSide(e))}>
                <span className="inbox-title">{item.title || t("library.untitled")}</span>
                <span className="inbox-meta">
                  {[item.clip?.site, item.clip?.author, date.format(item.inboxAt)].filter(Boolean).join(" · ")}
                </span>
                {item.preview && <span className="inbox-excerpt">{item.preview}</span>}
              </button>
              <span className="inbox-actions">
                {item.clip?.url && (
                  <button className="icon-button" title={t("inbox.openSource")} aria-label={t("inbox.openSource")} onClick={() => void backend.openLink(item.clip!.url)}>
                    <ExternalLink size={15} />
                  </button>
                )}
                <button className="icon-button" title={t("inbox.markDone")} aria-label={t("inbox.markDone")} onClick={() => void done(item)}>
                  <Check size={16} />
                </button>
                <button className="icon-button" title={t("library.moveToTrash")} aria-label={t("library.moveToTrash")} onClick={() => void moveToTrash(item.id, item.title)}>
                  <Trash2 size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A text on its way into the inbox: being saved, or failed, with the
 *  reason and buttons to try again or let it go. */
function PendingRow({ clip }: { clip: PendingClip }) {
  const { t } = useTranslation();
  const found = firstUrl(clip.text);
  const title = (found ? found.rest.split("\n")[0] || found.url : clip.text.trim().split("\n")[0]) || clip.text;
  const saving = clip.state === "saving";
  return (
    <li className={`inbox-item inbox-pending ${clip.state}`} aria-busy={saving}>
      <div className="inbox-open">
        <span className="inbox-title">{title}</span>
        {found && found.url !== title && <span className="inbox-meta inbox-url">{found.url}</span>}
        <span className="inbox-status" role="status">
          {saving ? (
            <>
              <span className="inbox-spinner" aria-hidden />
              {t(found ? "inbox.reading" : "inbox.keeping")}
            </>
          ) : (
            clip.error || t("inbox.interrupted")
          )}
        </span>
      </div>
      {!saving && (
        <span className="inbox-actions">
          <button className="icon-button" title={t("inbox.retry")} aria-label={t("inbox.retry")} onClick={() => void keepClip(clip.text, clip.key)}>
            <RotateCw size={15} />
          </button>
          <button className="icon-button" title={t("inbox.discard")} aria-label={t("inbox.discard")} onClick={() => dropPending(clip.key)}>
            <X size={16} />
          </button>
        </span>
      )}
    </li>
  );
}
