import { Check, ClipboardPaste, ExternalLink, Inbox, LibraryBig, RotateCw, Search, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { appUndo, docs } from "../app";
import type { InboxItem } from "../bindings/commands";
import type { InboxPlace } from "../docs/card";
import { CARDS_CHANGED, moveToTrash } from "../card/actions";
import { backend } from "../platform";
import { usePinyin } from "../search/pinyin";
import { EmptyState } from "../shell/EmptyState";
import { toSide, useShell } from "../shell/tabs";
import { dropPending, firstUrl, INBOX_CHANGED, inboxChanged, keepClip, type PendingClip, usePendingClips } from "./clip";
import { filterInbox } from "./filter";
import "./inbox.css";

/** Moves a card to the inbox, 已整理 or the card library, and refreshes it
 *  where it is open (the host made the change). */
export async function moveInboxCard(id: string, place: InboxPlace) {
  await backend.setInboxPlace(id, place);
  await docs().refresh([id]);
  inboxChanged();
}

type InboxTab = "waiting" | "archived";

/** The inbox (design/inbox-and-tags.md §2): links kept to read later. Each
 *  waits under 待整理 until dealt with (✓, kept under 已整理) or added to
 *  the card library as a card. Paste a link here, or share one from
 *  another app. */
export function InboxView({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const { open, setNotice } = useShell();
  const [tab, setTab] = useState<InboxTab>("waiting");
  const [waiting, setWaiting] = useState<InboxItem[] | null>(null);
  const [archived, setArchived] = useState<InboxItem[] | null>(null);
  const items = tab === "waiting" ? waiting : archived;
  const [text, setText] = useState("");
  // Only what waits here, so a hunt for one clipping is not lost among the
  // notes the global search also turns up. Not remembered.
  const [find, setFind] = useState("");
  const pinyin = usePinyin();
  // `pinyin`: matched again once the dictionary is there.
  const shown = useMemo(() => (items ? filterInbox(items, find) : null), [items, find, pinyin]);
  const finding = find.trim() !== "";
  const pending = usePendingClips((s) => s.items);
  const justSaved = usePendingClips((s) => s.justSaved);

  const reload = useCallback(() => {
    const failed = (e: unknown) => setNotice(t("error.generic", { message: String(e) }));
    backend.inbox().then(setWaiting, failed);
    backend.inboxArchived().then(setArchived, failed);
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
    setTab("waiting");
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

  /** Moves it, with undo back to where it was. */
  async function move(item: InboxItem, place: InboxPlace) {
    const from: InboxPlace = item.archivedAt === null ? "inbox" : "archived";
    try {
      await moveInboxCard(item.id, place);
    } catch (e) {
      setNotice(t("error.generic", { message: String(e) }));
      return;
    }
    appUndo.push({ label: "inbox", undo: () => moveInboxCard(item.id, from), redo: () => moveInboxCard(item.id, place) });
    const title = item.title || t("library.untitled");
    const said = { inbox: "inbox.putBack", archived: "inbox.done", library: "inbox.added" } as const;
    setNotice(t(said[place], { title }), { undo: true });
  }

  const date = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="page inbox">
      <header className="page-header">
        <h1>{t("inbox.title")}</h1>
        {finding && items && items.length > 0 && <span className="page-meta">{t("inbox.found", { count: shown!.length, total: items.length })}</span>}
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
      <div className="inbox-bar">
        <span className="segmented inbox-tabs" role="tablist" aria-label={t("inbox.title")}>
          {(["waiting", "archived"] as const).map((k) => {
            const n = (k === "waiting" ? waiting : archived)?.length;
            return (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : undefined} onClick={() => setTab(k)}>
                {t(`inbox.tabs.${k}`)}
                {n ? <span className="inbox-tab-count">{n}</span> : null}
              </button>
            );
          })}
        </span>
      {items && items.length > 0 && (
        <label className="inbox-search">
          <Search size={14} strokeWidth={1.75} />
          <input
            type="search"
            value={find}
            placeholder={t("inbox.search")}
            aria-label={t("inbox.search")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFind("")}
          />
        </label>
      )}
      </div>
      {tab === "waiting" && items?.length === 0 && pending.length === 0 && <EmptyState icon={<Inbox size={28} strokeWidth={1.5} />} title={t("inbox.empty")} hint={t("inbox.emptyHint")} />}
      {tab === "archived" && items?.length === 0 && <EmptyState icon={<Check size={28} strokeWidth={1.5} />} title={t("inbox.archivedEmpty")} hint={t("inbox.archivedEmptyHint")} />}
      {finding && shown?.length === 0 && (tab === "archived" || pending.length === 0) && <p className="empty">{t("inbox.noMatch")}</p>}
      {((tab === "waiting" && pending.length > 0) || (shown && shown.length > 0)) && (
        <ul className="inbox-list">
          {tab === "waiting" && pending.map((p) => (
            <PendingRow key={p.key} clip={p} />
          ))}
          {shown?.map((item) => (
            <li key={item.id} className={`inbox-item${item.id === justSaved && !finding ? " just-saved" : ""}`}>
              <button className="inbox-open" onClick={(e) => open({ kind: "card", cardId: item.id }, item.title, toSide(e))}>
                <span className="inbox-title">{item.title || t("library.untitled")}</span>
                <span className="inbox-meta">
                  {[item.clip?.site, item.clip?.author, item.archivedAt === null ? date.format(item.inboxAt) : t("inbox.archivedOn", { date: date.format(item.archivedAt) })].filter(Boolean).join(" · ")}
                </span>
                {item.preview && <span className="inbox-excerpt">{item.preview}</span>}
              </button>
              <span className="inbox-actions">
                {item.clip?.url && (
                  <button className="icon-button" title={t("inbox.openSource")} aria-label={t("inbox.openSource")} onClick={() => void backend.openLink(item.clip!.url)}>
                    <ExternalLink size={15} />
                  </button>
                )}
                {item.archivedAt === null ? (
                  <button className="icon-button" title={t("inbox.markDone")} aria-label={t("inbox.markDone")} onClick={() => void move(item, "archived")}>
                    <Check size={16} />
                  </button>
                ) : (
                  <button className="icon-button" title={t("inbox.putBackAction")} aria-label={t("inbox.putBackAction")} onClick={() => void move(item, "inbox")}>
                    <Undo2 size={15} />
                  </button>
                )}
                <button className="icon-button" title={t("inbox.addToLibrary")} aria-label={t("inbox.addToLibrary")} onClick={() => void move(item, "library")}>
                  <LibraryBig size={15} />
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
