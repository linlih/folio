import { Check, ExternalLink, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readMeta, setInbox, type Clip } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { inboxChanged } from "../inbox/clip";
import { backend } from "../platform";
import "../inbox/inbox.css";

/** A clipped card's source (design/inbox-and-tags.md §2): the site, the
 *  link (opens in the browser) and the page's summary; and while the card
 *  is in the inbox, a way to say it is dealt with. */
export function ClipSource({ handle }: { handle: DocHandle }) {
  const { t } = useTranslation();
  const read = () => {
    const m = readMeta(handle.doc);
    return { clip: m.clip, inboxAt: m.inboxAt };
  };
  const [state, setState] = useState<{ clip: Clip | null; inboxAt: number | null }>(read);

  useEffect(() => {
    setState(read());
    return handle.doc.subscribe(() => setState(read()));
  }, [handle]);

  async function done() {
    setInbox(handle.doc, null);
    await handle.persistence.flush();
    inboxChanged();
  }

  const { clip, inboxAt } = state;
  if (!clip && inboxAt === null) return null;
  return (
    <div className="clip-source">
      <div className="clip-source-head">
        {clip && [clip.site, clip.author].filter(Boolean).join(" · ")}
        {inboxAt !== null && (
          <span className="clip-source-inbox">
            <Inbox size={13} />
            {t("inbox.inInbox")}
            <button className="button" onClick={() => void done()}>
              <Check size={13} />
              {t("inbox.markDone")}
            </button>
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
