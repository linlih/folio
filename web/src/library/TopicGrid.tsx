import { Menu } from "@base-ui/react/menu";
import { ChevronRight, Layers, MoreHorizontal, Plus } from "lucide-react";
import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { cardsChanged } from "../card/actions";
import { newTopic, setCardsTopic, useTopics, workspaceDoc } from "../docs/topics";
import { deleteTopic, renameTopic } from "../docs/workspace";
import { useShell } from "../shell/tabs";
import { CARDS_MIME } from "../card/drag";


/** The library's home (§4.7): a tile per topic with its newest cards; a
 *  click goes in, cards dropped on a tile join the topic. */
export function TopicGrid({ byTopic, when }: { byTopic: Map<string, CardRow[]>; when: (ms: number | null) => string }) {
  const { t } = useTranslation();
  const topics = useTopics((s) => s.topics);
  const select = useShell((s) => s.setLibraryTopic);
  const [naming, setNaming] = useState(false);
  const [over, setOver] = useState<string | null>(null);

  const drop = (topic: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const ids = JSON.parse(e.dataTransfer.getData(CARDS_MIME) || "[]") as string[];
    if (ids.length) void setCardsTopic(ids, topic, true);
  };

  return (
    <section className="topic-grid-section">
      <h2 className="library-section">{t("nav.topics")}</h2>
      <ul className="topic-grid">
        {topics.map((topic) => {
          const cards = byTopic.get(topic.id) ?? [];
          return (
            <li
              key={topic.id}
              className={`topic-tile${over === topic.id ? " drop" : ""}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(CARDS_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "link";
                setOver(topic.id);
              }}
              onDragLeave={() => setOver((o) => (o === topic.id ? null : o))}
              onDrop={drop(topic.id)}
            >
              <button className="topic-tile-open" onClick={() => select(topic.id)}>
                <span className="topic-tile-head">
                  <Layers size={15} strokeWidth={1.75} />
                  <span className="topic-tile-name">{topic.name}</span>
                  <span className="topic-tile-count">{cards.length}</span>
                </span>
                <span className="topic-tile-cards">
                  {cards.length === 0 ? (
                    <span className="topic-tile-empty">{t("topics.tileEmpty")}</span>
                  ) : (
                    cards.slice(0, 3).map((c) => <span key={c.id}>{c.title || t("library.untitled")}</span>)
                  )}
                </span>
                {cards[0] && <time className="library-tile-date">{when(cards[0].updatedAt)}</time>}
              </button>
            </li>
          );
        })}
        <li className="topic-tile new">
          {naming ? (
            <NameInput
              placeholder={t("topics.namePlaceholder")}
              onDone={async (v) => {
                setNaming(false);
                if (v.trim()) await newTopic(v);
              }}
            />
          ) : (
            <button className="topic-tile-open" onClick={() => setNaming(true)}>
              <Plus size={16} />
              {t("topics.new")}
            </button>
          )}
        </li>
      </ul>
    </section>
  );
}

/** Inside a topic: "Card library › name", rename and delete. */
export function TopicHeader({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const topic = useTopics((s) => s.topics.find((x) => x.id === topicId));
  const count = useTopics((s) => s.counts[topicId] ?? 0);
  const select = useShell((s) => s.setLibraryTopic);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!topic) return null;

  const rename = async (v: string) => {
    setRenaming(false);
    if (v.trim() && v.trim() !== topic.name) renameTopic((await workspaceDoc()).doc, topicId, v);
  };
  const remove = async () => {
    setDeleting(false);
    select(null);
    deleteTopic((await workspaceDoc()).doc, topicId);
    cardsChanged();
  };

  return (
    <>
      <h1 className="library-crumbs">
        <button className="library-crumb" onClick={() => select(null)}>
          {t("library.title")}
        </button>
        <ChevronRight className="library-crumb-sep" size={20} strokeWidth={1.5} />
        {renaming ? (
          <NameInput initial={topic.name} onDone={(v) => void rename(v)} big />
        ) : (
          <span className="library-crumb-current" onDoubleClick={() => setRenaming(true)}>
            {topic.name}
          </span>
        )}
        <Menu.Root>
          <Menu.Trigger className="icon-button" aria-label={t("topics.menu")} title={t("topics.menu")}>
            <MoreHorizontal size={18} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={4}>
              <Menu.Popup className="popup">
                <Menu.Item className="popup-item" onClick={() => setRenaming(true)}>
                  {t("topics.rename")}
                </Menu.Item>
                <Menu.Item className="popup-item" onClick={() => setDeleting(true)}>
                  {t("topics.delete")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </h1>
      {deleting && (
        <div className="topic-confirm">
          <p>{t("topics.deleteConfirm", { name: topic.name, count })}</p>
          <button className="button" onClick={() => setDeleting(false)}>
            {t("dialog.cancel")}
          </button>
          <button className="button danger" onClick={() => void remove()}>
            {t("topics.delete")}
          </button>
        </div>
      )}
    </>
  );
}

/** A name being typed: Enter or leaving the field keeps it, Esc drops it. */
function NameInput({ initial = "", placeholder, onDone, big = false }: { initial?: string; placeholder?: string; onDone: (value: string) => void; big?: boolean }) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (v: string) => {
    if (done) return;
    setDone(true);
    onDone(v);
  };
  return (
    <input
      className={`topic-name-input${big ? " big" : ""}`}
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(initial);
      }}
    />
  );
}
