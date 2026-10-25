import { Popover } from "@base-ui/react/popover";
import { Layers, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addCardTopic, readCardTopics, removeCardTopic } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { newTopic, topicName, useTopics } from "../docs/topics";
import { toSide, useShell } from "../shell/tabs";

/** The card's topics under its title (§4.7): open one, take the card out,
 *  or put it in another (search, or make a new topic). */
export function TopicRow({ handle }: { handle: DocHandle }) {
  const { t } = useTranslation();
  const topics = useTopics((s) => s.topics);
  const [ids, setIds] = useState(() => readCardTopics(handle.doc));
  useEffect(
    () =>
      handle.doc.subscribe(() =>
        setIds((prev) => {
          const next = readCardTopics(handle.doc);
          return next.join("\n") === prev.join("\n") ? prev : next;
        }),
      ),
    [handle],
  );
  // A topic deleted elsewhere drops out of the row.
  const shown = ids.map((id) => ({ id, name: topicName(topics, id) })).filter((x): x is { id: string; name: string } => x.name !== null);

  return (
    <div className="topic-row">
      {shown.map(({ id, name }) => (
        <span key={id} className="topic-chip">
          <button className="topic-chip-name" onClick={(e) => useShell.getState().openTopic(id, toSide(e))}>
            <Layers size={12} strokeWidth={2} />
            {name}
          </button>
          <button className="topic-chip-remove" aria-label={t("topics.remove", { name })} title={t("topics.remove", { name })} onClick={() => removeCardTopic(handle.doc, id)}>
            <X size={11} />
          </button>
        </span>
      ))}
      <TopicPicker taken={ids} onPick={(id) => addCardTopic(handle.doc, id)} className={`topic-add${shown.length > 0 ? " compact" : ""}`}>
        <Plus size={12} strokeWidth={2} />
        {shown.length === 0 && <span>{t("topics.add")}</span>}
      </TopicPicker>
    </div>
  );
}

/** Choose a topic, or make one from what was typed; `children` is the
 *  button that opens it. */
export function TopicPicker({ taken, onPick, className, children }: { taken: string[]; onPick: (topicId: string) => void; className: string; children: ReactNode }) {
  const { t } = useTranslation();
  const topics = useTopics((s) => s.topics);
  const counts = useTopics((s) => s.counts);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
  }, [open]);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = topics
      .filter((topic) => !taken.includes(topic.id) && (!q || topic.name.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((topic) => ({ id: topic.id, name: topic.name, count: counts[topic.id] ?? 0 }));
    const exact = topics.some((topic) => topic.name.toLowerCase() === q);
    return q && !exact ? [...found, { id: null, name: query.trim(), count: 0 }] : found;
  }, [topics, counts, query, taken]);

  const pick = async (o: { id: string | null; name: string }) => {
    setOpen(false);
    onPick(o.id ?? (await newTopic(o.name)));
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={className} title={t("topics.add")}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="popup topic-picker">
            <input
              autoFocus
              value={query}
              placeholder={t("topics.search")}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, options.length - 1));
                else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
                else if (e.key === "Enter" && options[index]) void pick(options[index]);
                else return;
                e.preventDefault();
              }}
            />
            {options.length === 0 ? (
              <p className="topic-picker-empty">{t("topics.none")}</p>
            ) : (
              <ul>
                {options.map((o, i) => (
                  <li key={o.id ?? `new:${o.name}`}>
                    <button className={`popup-item${i === index ? " active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => void pick(o)}>
                      {o.id ? <Layers size={13} /> : <Plus size={13} />}
                      <span>{o.id ? o.name : t("topics.create", { name: o.name })}</span>
                      {o.id && o.count > 0 && <span className="topic-count">{o.count}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
