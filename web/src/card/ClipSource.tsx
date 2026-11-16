import { Check, ExternalLink, Inbox, LibraryBig, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readMeta, setInboxPlace, type Clip, type InboxPlace } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { inboxChanged } from "../inbox/clip";
import { backend } from "../platform";
import "../inbox/inbox.css";

/** A clipped card's source (design/inbox-and-tags.md §2): the site, the
 *  link (opens in the browser) and the page's summary. Where the card
 *  stands: waiting in the inbox (deal with it, or add it to the card
 *  library), under 已整理 (add it, or put it back), or a card that came
 *  from the inbox, and when. */
export function ClipSource({ handle }: { handle: DocHandle }) {
  const { t, i18n } = useTranslation();
  const read = () => {
    const m = readMeta(handle.doc);
    return { clip: m.clip, inboxAt: m.inboxAt, inboxFrom: m.inboxFrom, archivedAt: m.archivedAt };
  };
  const [state, setState] = useState<{ clip: Clip | null; inboxAt: number | null; inboxFrom: number | null; archivedAt: number | null }>(read);

  useEffect(() => {
    setState(read());
    return handle.doc.subscribe(() => setState(read()));
  }, [handle]);

  async function move(place: InboxPlace) {
    setInboxPlace(handle.doc, place, Date.now());
    await handle.persistence.flush();
    inboxChanged();
  }

  const { clip, inboxAt, inboxFrom, archivedAt } = state;
  const archived = inboxAt === null && archivedAt !== null;
  const from = inboxAt === null ? inboxFrom : null;
  const day = (at: number) => new Date(at).toLocaleDateString(i18n.language, { year: "numeric", month: "long", day: "numeric" });
  const addButton = (
    <button className="button" onClick={() => void move("library")}>
      <LibraryBig size={13} />
      {t("inbox.addToLibrary")}
    </button>
  );
  if (!clip && inboxAt === null && from === null && !archived) return null;
  return (
    <div className="clip-source">
      <div className="clip-source-head">
        {clip && [clip.site, clip.author].filter(Boolean).join(" · ")}
        {from !== null && !archived && (
          <span className="clip-source-inbox clip-source-from">
            <Inbox size={13} />
            {t("inbox.fromInbox", { date: day(from) })}
          </span>
        )}
        {archived && (
          <span className="clip-source-inbox">
            <Check size={13} />
            {t("inbox.inArchive", { date: day(archivedAt) })}
            {addButton}
            <button className="button" onClick={() => void move("inbox")}>
              <Undo2 size={13} />
              {t("inbox.putBackAction")}
            </button>
          </span>
        )}
        {inboxAt !== null && (
          <span className="clip-source-inbox">
            <Inbox size={13} />
            {t("inbox.inInbox")}
            <button className="button" onClick={() => void move("archived")}>
              <Check size={13} />
              {t("inbox.markDone")}
            </button>
            {addButton}
          </span>
        )}
      </div>
      {clip?.url && (
        <button className="clip-source-link" title={clip.url} onClick={() => void backend.openLink(clip.url)}>
          <ExternalLink size={13} />
          <span>{clip.url}</span>
        </button>
      )}
      {clip?.excerpt && <p className="clip-source-excerpt">{clip.excerpt}</p>}
    </div>
  );
}
