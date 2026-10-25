import { ChevronRight, PanelRightClose } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import { Backlinks } from "../card/Backlinks";
import { openAt } from "../card/reveal";
import { bodyFacts, readCardTopics, readMeta, type BodyFacts } from "../docs/card";
import { topicName, useTopics } from "../docs/topics";
import { keyLabel, PANEL_COMBO, togglePanel } from "./shortcuts";
import { focusedPane, useShell } from "./tabs";
import "./panel.css";

/** Recomputing the outline while typing: once the edits settle. */
const SETTLE_MS = 300;

/** The details panel on the right (like Claude's side panel): the focused
 *  pane's card — its outline, backlinks and facts. */
export function DetailsPanel() {
  const { t } = useTranslation();
  const open = useShell((s) => s.panelOpen);
  const active = useShell((s) => focusedPane(s).active);
  if (!open) return null;
  const cardId = active.startsWith("card:") ? active.slice(5) : null;
  return (
    <aside className="details-panel" aria-label={t("panel.title")}>
      <header className="details-head" data-tauri-drag-region>
        <span>{t("panel.title")}</span>
        <button className="icon-button" title={`${t("panel.hide")} (${keyLabel(PANEL_COMBO)})`} aria-label={t("panel.hide")} onClick={togglePanel}>
          <PanelRightClose size={15} strokeWidth={1.75} />
        </button>
      </header>
      <div className="details-body">{cardId ? <CardDetails key={cardId} cardId={cardId} /> : <p className="details-empty">{t("panel.empty")}</p>}</div>
    </aside>
  );
}

function Section({ title, children, startOpen = true }: { title: string; children: ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section className="details-section">
      <button className="details-section-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={13} className={open ? "open" : undefined} />
        {title}
      </button>
      {open && children}
    </section>
  );
}

function useFacts(cardId: string) {
  const [facts, setFacts] = useState<(BodyFacts & { topics: string[]; title: string; createdAt: number | null }) | null>(null);
  useEffect(() => {
    const hub = docs();
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    void hub.open(cardId).then((h) => {
      if (gone) return;
      const read = () => {
        const m = readMeta(h.doc);
        setFacts({ ...bodyFacts(h.doc), topics: readCardTopics(h.doc), title: m.title, createdAt: m.createdAt });
      };
      read();
      unsubscribe = h.doc.subscribe(() => {
        clearTimeout(timer);
        timer = setTimeout(read, SETTLE_MS);
      });
    }, () => {});
    return () => {
      gone = true;
      clearTimeout(timer);
      unsubscribe();
      void hub.release(cardId);
    };
  }, [cardId]);
  return facts;
}

function CardDetails({ cardId }: { cardId: string }) {
  const { t, i18n } = useTranslation();
  const facts = useFacts(cardId);
  const allTopics = useTopics((s) => s.topics);
  if (!facts) return null;
  const topics = facts.topics.map((id) => ({ id, name: topicName(allTopics, id) })).filter((x) => x.name !== null);
  const top = Math.min(...facts.headings.map((h) => h.level));
  const date = (ms: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  return (
    <>
      <Section title={t("panel.outline")}>
        {facts.headings.length === 0 ? (
          <p className="details-empty">{t("panel.noHeadings")}</p>
        ) : (
          <ul className="details-outline">
            {facts.headings.map((h) => (
              <li key={h.bid} style={{ paddingLeft: (h.level - top) * 14 }}>
                <button onClick={() => openAt(cardId, facts.title, h.bid)} title={h.text}>
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("panel.backlinks")}>
        <div className="details-backlinks">
          <Backlinks cardId={cardId} active />
        </div>
      </Section>
      <Section title={t("panel.info")}>
        <dl className="details-info">
          {facts.createdAt !== null && (
            <>
              <dt>{t("panel.created")}</dt>
              <dd>{date(facts.createdAt)}</dd>
            </>
          )}
          <dt>{t("panel.chars")}</dt>
          <dd>{facts.chars.toLocaleString(i18n.language)}</dd>
          <dt>{t("panel.blocks")}</dt>
          <dd>{facts.blocks.toLocaleString(i18n.language)}</dd>
          {topics.length > 0 && (
            <>
              <dt>{t("panel.topics")}</dt>
              <dd className="details-tags">
                {topics.map((x) => (
                  <button key={x.id} className="details-tag" onClick={() => useShell.getState().openTopic(x.id)}>
                    {x.name}
                  </button>
                ))}
              </dd>
            </>
          )}
          {facts.tags.length > 0 && (
            <>
              <dt>{t("panel.tags")}</dt>
              <dd className="details-tags">
                {facts.tags.map((tag) => (
                  <button key={tag} className="details-tag" onClick={() => useShell.getState().open({ kind: "tag", name: tag })}>
                    #{tag}
                  </button>
                ))}
              </dd>
            </>
          )}
        </dl>
      </Section>
    </>
  );
}
