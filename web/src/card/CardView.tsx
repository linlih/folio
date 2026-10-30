import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { isPinned, setPin, usePins } from "./pins";
import { TopicRow } from "./TopicRow";
import { ClipSource } from "./ClipSource";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Extension, type Editor } from "@tiptap/core";
import { docs } from "../app";
import { readMeta, setTitle } from "../docs/card";
import type { DocHandle } from "../docs/hub";
import { CardEditor, focusEditor } from "../editor/CardEditor";
import { extractExtension } from "../editor/extract";
import { belowText, continueAtEnd, firstTextblock } from "../editor/outliner/feel";
import { focusedPane, useShell } from "../shell/tabs";
import { Backlinks } from "./Backlinks";
import { copyMarkdown, exportCardMarkdown } from "./markdown";
import { downloadCardFiles } from "../editor/assets";
import { backend } from "../platform";
import { usePhone } from "../shell/phone";
import { onReveal, revealIn, takePending } from "./reveal";
import "./card.css";

/** Title and body behave as one text (Notion, Heptabase): ↑ on the body's
 *  first line, or Backspace at its very start, goes back to the title. Only
 *  for a plain first paragraph: a first list item or heading has its own
 *  Backspace rules. */
function titleEdge(toTitle: () => void) {
  return Extension.create({
    name: "titleEdge",
    priority: 1000,
    addKeyboardShortcuts() {
      const onFirstLine = (editor: Editor) => {
        const first = firstTextblock(editor.state.doc);
        const { $head, empty } = editor.state.selection;
        return !!first && empty && $head.parent === first.node && first.node.type.name === "paragraph" && $head.depth === 1;
      };
      return {
        ArrowUp: ({ editor }) => {
          if (!onFirstLine(editor) || !editor.view.endOfTextblock("up")) return false;
          toTitle();
          return true;
        },
        Backspace: ({ editor }) => {
          if (!onFirstLine(editor) || editor.state.selection.$head.parentOffset !== 0) return false;
          toTitle();
          return true;
        },
      };
    },
  });
}

/** The card's actions, behind "⋯" at the end of the title line (also in
 *  the card tab's right-click menu). */
function CardMenu({ cardId, title }: { cardId: string; title: string }) {
  const { t } = useTranslation();
  const pinned = usePins((s) => isPinned(s.cards, cardId));
  // Phones download files when they are looked at; this takes a card's
  // all along before going offline (design/attachments.md §5.4).
  const phone = usePhone() && backend.kind === "tauri";
  const downloadAll = async () => {
    const h = await docs().open(cardId);
    const n = await downloadCardFiles(JSON.stringify(h.doc.toJSON()));
    useShell.getState().setNotice(n ? t("assets.downloading", { count: n }) : t("assets.allHere"));
  };
  return (
    <Menu.Root>
      <Menu.Trigger className="icon-button card-menu" aria-label={t("card.menu")} title={t("card.menu")}>
        <MoreHorizontal size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="popup">
            <Menu.Item className="popup-item" onClick={() => void setPin(cardId, !pinned)}>
              {t(pinned ? "nav.unpin" : "nav.pin")}
            </Menu.Item>
            <Menu.Separator className="popup-separator" />
            <Menu.Item className="popup-item" onClick={() => void copyMarkdown(cardId)}>
              {t("markdown.copy")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => void exportCardMarkdown(cardId, title)}>
              {t("markdown.export")}
            </Menu.Item>
            {phone && (
              <>
                <Menu.Separator className="popup-separator" />
                <Menu.Item className="popup-item" onClick={() => void downloadAll()}>
                  {t("assets.downloadAll")}
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A card in its own tab: title, then the body. */
export function CardView({ cardId, pane, active = true }: { cardId: string; pane: string; active?: boolean }) {
  const { t } = useTranslation();
  const { open, renameCard } = useShell();
  const inPanel = useShell((s) => s.panelOpen && s.focused === pane && focusedPane(s).active === `card:${cardId}`);
  const [handle, setHandle] = useState<DocHandle | null>(null);
  const [title, setTitleState] = useState("");
  const editor = useRef<Editor | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  // A backlink or search hit asked to show a block of this (open) card.
  useEffect(() => onReveal(pane, cardId, (bid) => editor.current && revealIn(editor.current.view, bid)), [pane, cardId]);

  const toTitle = () => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  useEffect(() => {
    const hub = docs();
    let cancelled = false;
    let unsubscribe = () => {};
    hub.open(cardId).then((h) => {
      if (cancelled) return;
      setHandle(h);
      setTitleState(readMeta(h.doc).title);
      // The title edited elsewhere: the same card in the other pane, or
      // another device.
      unsubscribe = h.doc.subscribe(() => {
        const next = readMeta(h.doc).title;
        setTitleState((prev) => (prev === next ? prev : next));
      });
    }, () => {});
    return () => {
      cancelled = true;
      unsubscribe();
      void hub.release(cardId);
    };
  }, [cardId]);

  function changeTitle(value: string) {
    const clean = value.replace(/\n/g, " ");
    setTitleState(clean);
    if (handle) setTitle(handle.doc, clean);
    renameCard(cardId, clean);
  }

  function titleKeys(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const body = editor.current;
    if (!body || e.nativeEvent.isComposing) return;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    // The title fits on one line: ↓ anywhere goes to the body.
    const oneLine = el.scrollHeight <= parseFloat(getComputedStyle(el).lineHeight) * 1.5;
    if (e.key === "Enter") {
      e.preventDefault();
      // The text after the cursor becomes the body's first line (Notion).
      const rest = el.value.slice(el.selectionEnd);
      if (rest) {
        changeTitle(el.value.slice(0, el.selectionStart));
        const { schema, doc } = body.state;
        const blank = doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" && doc.firstChild!.content.size === 0;
        // Into the empty first line of a new card, else as a new first line.
        body.view.dispatch(
          blank ? body.state.tr.insertText(rest, 1) : body.state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text(rest))),
        );
      }
      focusEditor(body, "start");
    } else if ((e.key === "ArrowDown" && (atEnd || oneLine)) || (e.key === "ArrowRight" && atEnd)) {
      e.preventDefault();
      focusEditor(body, "start");
    }
  }

  /** A click below the text continues writing at the end. */
  function clickBelow(e: React.MouseEvent) {
    if (!editor.current || !belowText(editor.current, e)) return;
    e.preventDefault();
    continueAtEnd(editor.current, false);
  }

  return (
    <div className="page card-page">
      {handle && (
        <div className="card-title-row">
          <textarea
            ref={titleRef}
            className="card-page-title"
            rows={1}
            value={title}
            placeholder={t("card.titlePlaceholder")}
            onChange={(e) => changeTitle(e.target.value)}
            onKeyDown={titleKeys}
            autoFocus={!title}
            spellCheck={false}
          />
          <CardMenu cardId={cardId} title={title} />
        </div>
      )}
      {handle && <TopicRow handle={handle} />}
      {handle && <ClipSource handle={handle} />}
      <div className="card-body-area" onMouseDown={clickBelow}>
        <CardEditor
          docId={cardId}
          placeholder={t("card.bodyPlaceholder")}
          onOpenCard={(id, linkTitle, side) => open({ kind: "card", cardId: id }, linkTitle, side)}
          extensions={(h) => [extractExtension(h), titleEdge(toTitle)]}
          onReady={(e) => {
            editor.current = e;
            const bid = takePending(pane, cardId);
            if (bid) setTimeout(() => revealIn(e.view, bid), 50);
          }}
        />
      </div>
      {/* Shown in the details panel instead while it is about this card. */}
      {!inPanel && <Backlinks cardId={cardId} active={active} />}
    </div>
  );
}
