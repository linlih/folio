// Cards attached to a message with @ (design/ai.md "对话窗口"): typing @ in
// the message opens a list of cards by title, as Notion and Obsidian
// Copilot let notes be mentioned; the one picked becomes a chip above the
// message and goes with it.

import { FileText } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CardRow } from "../bindings/commands";
import { cardName } from "../card/reveal";
import { backend } from "../platform";
import { filterNames, loadPinyin } from "../search/pinyin";
import type { CardRef } from "./chat";

/** The @ being typed before the caret, if any: at the start or after a
 *  space, and the words after it on the same line. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.includes("\n") || query.length > 40) return null;
  return { start: at, query };
}

/** The @ menu for a message being written; `onPick` gets the card and
 *  the text with the @ words taken out. */
export function useMention(draft: string, input: RefObject<HTMLTextAreaElement | null>, onPick: (card: CardRef, text: string) => void) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const loading = useRef(false);

  const at = mentionAt(draft, caret);
  const open = !!at && at.start !== dismissed;
  useEffect(() => {
    if (!open || cards || loading.current) return;
    loading.current = true;
    void Promise.all([backend.listCards(500), loadPinyin()]).then(
      ([rows]) => setCards(rows),
      () => setCards([]),
    );
  }, [open, cards]);
  useEffect(() => setIndex(0), [at?.query]);
  // A new @ is offered again.
  useEffect(() => {
    if (!at) setDismissed(null);
  }, [!at]);

  const items = open && cards ? filterNames(cards, at!.query.trim(), (c) => c.title).slice(0, 8) : [];
  const shown = open && items.length > 0;

  const pick = (c: CardRow) => {
    if (!at) return;
    const text = draft.slice(0, at.start) + draft.slice(caret);
    onPick({ cardId: c.id, title: cardName(c.id, c.title) }, text);
    setCaret(at.start);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at.start, at.start);
    });
  };

  /** Keys while the menu is open; true when the menu took the key. */
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!shown || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      pick(items[index]);
    } else if (e.key === "Escape") {
      setDismissed(at!.start);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  /** Inserts an @ at the caret, for the button. */
  const start = () => {
    const el = input.current;
    const pos = el?.selectionStart ?? draft.length;
    const space = pos > 0 && !/\s/.test(draft[pos - 1]) ? " " : "";
    return { text: `${draft.slice(0, pos)}${space}@${draft.slice(pos)}`, caret: pos + space.length + 1 };
  };

  const menu = shown ? <MentionMenu items={items} index={index} onPick={pick} onHover={setIndex} /> : null;
  return { menu, onKey, track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? 0), start, setCaret };
}

function MentionMenu({ items, index, onPick, onHover }: { items: CardRow[]; index: number; onPick: (c: CardRow) => void; onHover: (i: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="popup chat-mention" role="listbox" aria-label={t("ai.mention")}>
      {items.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`popup-item${i === index ? " active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}
        >
          <FileText size={13} />
          <span>{cardName(c.id, c.title)}</span>
        </button>
      ))}
    </div>
  );
}
