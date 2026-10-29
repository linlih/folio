import { Menu } from "@base-ui/react/menu";
import { ChevronRight, Layers, MoreHorizontal, Plus } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { cardsChanged } from "../card/actions";
import { mergeTopic, newTopic, setCardsTopic, topicPath, useTopics, workspaceDoc } from "../docs/topics";
import { deleteTopic, moveTopic, renameTopic, subTopics, topicTargets } from "../docs/workspace";
import { useShell } from "../shell/tabs";
import { CARDS_MIME } from "../card/drag";

/** What a dragged topic tile carries: its id. A top-level tile takes it as
 *  a sub-topic. */
const TOPIC_MIME = "application/x-folio-topic";

/** The library's home (§4.7): a tile per top-level topic with its
 *  sub-topics' names and its newest cards (theirs included); a click goes
 *  in, cards dropped on a tile join the topic, and on a computer a tile
 *  dropped on another becomes its sub-topic. */
export function TopicGrid({ byTopic, when }: { byTopic: Map<string, CardRow[]>; when: (ms: number | null) => string }) {
  const { t } = useTranslation();
  const all = useTopics((s) => s.topics);
  const counts = useTopics((s) => s.counts);
  const topics = all.filter((x) => !x.parent);
  const select = useShell((s) => s.setLibraryTopic);
  const [naming, setNaming] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);

  /** A topic tile may land here: a top-level target it can move under. */
  const takesTopic = (target: string) => {
    const id = dragging.current;
    return !!id && topicTargets(all, id).some((x) => x?.id === target);
  };

  const drop = (topic: string) => async (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const moved = e.dataTransfer.getData(TOPIC_MIME);
    if (moved) {
      if (takesTopic(topic)) moveTopic((await workspaceDoc()).doc, moved, topic);
      return;
    }
    const ids = JSON.parse(e.dataTransfer.getData(CARDS_MIME) || "[]") as string[];
    if (ids.length) void setCardsTopic(ids, topic, true);
  };

  return (
    <section className="topic-grid-section">
      <h2 className="library-section">{t("nav.topics")}</h2>
      <ul className="topic-grid">
        {topics.map((topic) => {
          const cards = byTopic.get(topic.id) ?? [];
          const subs = subTopics(all, topic.id);
          return (
            <li
              key={topic.id}
              className={`topic-tile${over === topic.id ? " drop" : ""}`}
              draggable={subs.length === 0}
              onDragStart={(e) => {
                dragging.current = topic.id;
                e.dataTransfer.setData(TOPIC_MIME, topic.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => (dragging.current = null)}
              onDragOver={(e) => {
                const card = e.dataTransfer.types.includes(CARDS_MIME);
                if (!card && !(e.dataTransfer.types.includes(TOPIC_MIME) && takesTopic(topic.id))) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = card ? "link" : "move";
                setOver(topic.id);
              }}
              onDragLeave={() => setOver((o) => (o === topic.id ? null : o))}
              onDrop={(e) => void drop(topic.id)(e)}
            >
              <button className="topic-tile-open" onClick={() => select(topic.id)}>
                <span className="topic-tile-head">
                  <Layers size={15} strokeWidth={1.75} />
                  <span className="topic-tile-name">{topic.name}</span>
                  <span className="topic-tile-count">{counts[topic.id] ?? 0}</span>
                </span>
                {subs.length > 0 && (
                  <span className="topic-tile-subs" title={t("topics.subTopics")}>
                    {subs.map((x) => x.name).join(t("topics.sep"))}
                  </span>
                )}
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

/** Inside a topic: its sub-topics in one quiet row, each with its count, to
 *  go into or drop cards on; at its end a small button names a new one. */
export function SubTopicStrip({ parent, adding, onAdded }: { parent: string; adding: boolean; onAdded: () => void }) {
  const { t } = useTranslation();
  const all = useTopics((s) => s.topics);
  const counts = useTopics((s) => s.counts);
  const select = useShell((s) => s.setLibraryTopic);
  const [naming, setNaming] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const subs = subTopics(all, parent);
  return (
    <nav className="subtopics" aria-label={t("topics.subTopics")}>
      {subs.map((x) => (
        <button
          key={x.id}
          className={`subtopic${over === x.id ? " drop" : ""}`}
          onClick={() => select(x.id)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(CARDS_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "link";
            setOver(x.id);
          }}
          onDragLeave={() => setOver((o) => (o === x.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const ids = JSON.parse(e.dataTransfer.getData(CARDS_MIME) || "[]") as string[];
            if (ids.length) void setCardsTopic(ids, x.id, true);
          }}
        >
          <Layers size={14} strokeWidth={1.75} />
          <span className="subtopic-name">{x.name}</span>
          <span className="subtopic-count">{counts[x.id] ?? 0}</span>
        </button>
      ))}
      {naming || adding ? (
        <span className="subtopic new">
          <NameInput
            placeholder={t("topics.subNamePlaceholder")}
            onDone={async (v) => {
              setNaming(false);
              onAdded();
              if (v.trim()) await newTopic(v, parent);
            }}
          />
        </span>
      ) : (
        <button className="subtopic new" onClick={() => setNaming(true)}>
          <Plus size={14} />
          {t("topics.newSub")}
        </button>
      )}
    </nav>
  );
}

/** Inside a topic: "Card library › parent › name"; rename, move under
 *  another topic or to the top, merge into another, delete. */
export function TopicHeader({ topicId, onNewSub }: { topicId: string; onNewSub: () => void }) {
  const { t } = useTranslation();
  const topics = useTopics((s) => s.topics);
  const topic = topics.find((x) => x.id === topicId);
  const count = useTopics((s) => s.counts[topicId] ?? 0);
  const select = useShell((s) => s.setLibraryTopic);
  const [renaming, setRenaming] = useState(false);
  const [asking, setAsking] = useState<"delete" | "move" | "merge" | null>(null);
  if (!topic) return null;
  const parent = topic.parent ? topics.find((x) => x.id === topic.parent) : undefined;
  const subs = subTopics(topics, topicId).length;
  const moveTo = topicTargets(topics, topicId);
  const mergeTo = topics.filter((x) => x.id !== topicId);

  const rename = async (v: string) => {
    setRenaming(false);
    if (v.trim() && v.trim() !== topic.name) renameTopic((await workspaceDoc()).doc, topicId, v);
  };
  const remove = async () => {
    setAsking(null);
    select(topic.parent);
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
        {parent && (
          <>
            <button className="library-crumb" onClick={() => select(parent.id)}>
              {parent.name}
            </button>
            <ChevronRight className="library-crumb-sep" size={20} strokeWidth={1.5} />
          </>
        )}
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
                {!topic.parent && (
                  <Menu.Item className="popup-item" onClick={onNewSub}>
                    {t("topics.newSub")}
                  </Menu.Item>
                )}
                {moveTo.length > 0 && (
                  <Menu.Item className="popup-item" onClick={() => setAsking("move")}>
                    {t("topics.moveTopic")}
                  </Menu.Item>
                )}
                {mergeTo.length > 0 && (
                  <Menu.Item className="popup-item" onClick={() => setAsking("merge")}>
                    {t("topics.merge")}
                  </Menu.Item>
                )}
                <Menu.Item className="popup-item" onClick={() => setAsking("delete")}>
                  {t("topics.delete")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </h1>
      {asking === "delete" && (
        <div className="topic-confirm">
          <p>
            {t("topics.deleteConfirm", { name: topic.name, count })}
            {subs > 0 && ` ${t("topics.deleteSubs", { count: subs })}`}
          </p>
          <button className="button" onClick={() => setAsking(null)}>
            {t("dialog.cancel")}
          </button>
          <button className="button danger" onClick={() => void remove()}>
            {t("topics.delete")}
          </button>
        </div>
      )}
      {asking === "move" && (
        <ChooseTopic
          text={t("topics.moveTopicTo", { name: topic.name })}
          options={moveTo.map((x) => ({ id: x?.id ?? "", label: x ? x.name : t("topics.top") }))}
          action={t("topics.moveTopicDo")}
          onCancel={() => setAsking(null)}
          onChoose={async (id) => {
            setAsking(null);
            moveTopic((await workspaceDoc()).doc, topicId, id || null);
          }}
        />
      )}
      {asking === "merge" && (
        <ChooseTopic
          text={t(subs > 0 ? "topics.mergeIntoSubs" : "topics.mergeInto", { name: topic.name, count })}
          options={mergeTo.map((x) => ({ id: x.id, label: topicPath(topics, x.id) ?? x.name }))}
          action={t("topics.mergeDo")}
          onCancel={() => setAsking(null)}
          onChoose={async (id) => {
            setAsking(null);
            await mergeTopic(topicId, id);
            select(id);
          }}
        />
      )}
    </>
  );
}

/** A choice of topic under the header (a native list: a phone shows its own
 *  picker), with a button to act and one to cancel. */
function ChooseTopic({ text, options, action, onChoose, onCancel }: { text: string; options: { id: string; label: string }[]; action: string; onChoose: (id: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(options[0]?.id ?? "");
  return (
    <div className="topic-confirm choose">
      <p>{text}</p>
      <select value={value} onChange={(e) => setValue(e.target.value)} aria-label={text}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button className="button" onClick={onCancel}>
        {t("dialog.cancel")}
      </button>
      <button className="button primary" onClick={() => onChoose(value)}>
        {action}
      </button>
    </div>
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
