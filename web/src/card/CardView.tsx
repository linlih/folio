import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { isPinned, setPin, usePins } from "./pins";
import { cardsChanged } from "./actions";
import { isTemplate, markTemplate, useTemplates } from "./templates";
import { TopicRow } from "./TopicRow";
import { ClipSource } from "./ClipSource";
import { CardFields } from "./CardFields";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Extension, type Editor } from "@tiptap/core";
import { docs } from "../app";
import { bodyFacts, readMeta, setTitle } from "../docs/card";
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
import { TocSheet, type Heading } from "./Toc";
import { offerToc, setTocSheet, tocSlot, useHeadingTracker, useTocSheetOpen } from "./tocState";
import type { EditorView } from "@tiptap/pm/view";
import { canExportPdf, exportPdf } from "../print/print";
import { TitleChange } from "../ai/ReviewBar";
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
function CardMenu({ cardId, title, onToc }: { cardId: string; title: string; onToc?: () => void }) {
  const { t } = useTranslation();
  const pinned = usePins((s) => isPinned(s.cards, cardId));
  const template = useTemplates((s) => isTemplate(s.ids, cardId));
  // Phones download files when they are looked at; this takes a card's
  // all along before going offline (design/attachments.md §5.4).
  const phone = usePhone() && backend.kind === "tauri";
  const trigger = useRef<HTMLButtonElement>(null);
  const downloadAll = async () => {
    const h = await docs().open(cardId);
    const n = await downloadCardFiles(JSON.stringify(h.doc.toJSON()));
    useShell.getState().setNotice(n ? t("assets.downloading", { count: n }) : t("assets.allHere"));
  };
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} className="icon-button card-menu" aria-label={t("card.menu")} title={t("card.menu")}>
        <MoreHorizontal size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="popup">
            {onToc && (
              <>
                <Menu.Item className="popup-item" onClick={onToc}>
                  {t("panel.outline")}
                </Menu.Item>
                <Menu.Separator className="popup-separator" />
              </>
            )}
            <Menu.Item className="popup-item" onClick={() => void setPin(cardId, !pinned)}>
              {t(pinned ? "nav.unpin" : "nav.pin")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => void markTemplate(cardId, !template)}>
              {t(template ? "templates.unmark" : "templates.mark")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => useShell.getState().setDialog({ kind: "history", cardId })}>
              {t("history.menu")}
            </Menu.Item>
            <Menu.Separator className="popup-separator" />
            <Menu.Item className="popup-item" onClick={() => void copyMarkdown(cardId)}>
              {t("markdown.copy")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => void exportCardMarkdown(cardId, title)}>
              {t("markdown.export")}
            </Menu.Item>
            {canExportPdf() && (
              <Menu.Item
                className="popup-item"
                onClick={() => void exportPdf(title || t("library.untitled"), trigger.current?.closest(".card-page")?.querySelector(".card-body-area .ProseMirror") ?? null)}
              >
                {t("print.export")}
              </Menu.Item>
            )}
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

/** On a phone, the card's headings for its table of contents (the ⋯ menu
 *  offers it from two on), kept current once edits settle. */
function usePhoneHeadings(handle: DocHandle | null): Heading[] {
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    if (!handle) return setHeadings([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => setHeadings(bodyFacts(handle.doc).headings);
    read();
    const unsubscribe = handle.doc.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(read, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [handle]);
  return headings;
}

/** A card in its own tab: title, then the body. */
export function CardView({ cardId, pane, active = true }: { cardId: string; pane: string; active?: boolean }) {
  const { t } = useTranslation();
  const { open, renameCard } = useShell();
  const inPanel = useShell((s) => s.panelOpen && s.focused === pane && focusedPane(s).active === `card:${cardId}`);
  const [handle, setHandle] = useState<DocHandle | null>(null);
  const [title, setTitleState] = useState("");
  /** In the trash (here, or moved there on another device while open). */
  const [trashed, setTrashed] = useState(false);
  const editor = useRef<Editor | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const phone = usePhone();
  const headings = usePhoneHeadings(phone ? handle : null);
  const tocKey = tocSlot(pane, cardId);
  const tocOpen = useTocSheetOpen(tocKey);
  const tocOffered = headings.length >= 2;
  // The phone's top bar offers it too, reachable anywhere down the card.
  useEffect(() => {
    offerToc(tocKey, tocOffered);
    return () => offerToc(tocKey, false);
  }, [tocKey, tocOffered]);

  // A backlink, search hit or the table of contents asked to show a block
  // of this (open) card.
  useEffect(() => onReveal(pane, cardId, (at) => editor.current && revealIn(editor.current.view, at)), [pane, cardId]);
  // Which heading is being read, for the table of contents.
  useHeadingTracker(pane, cardId, view, root, active);

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
      setTrashed(readMeta(h.doc).deletedAt !== null);
      // The title edited elsewhere: the same card in the other pane, or
      // another device.
      unsubscribe = h.doc.subscribe(() => {
        const meta = readMeta(h.doc);
        setTitleState((prev) => (prev === meta.title ? prev : meta.title));
        setTrashed(meta.deletedAt !== null);
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

  async function restore() {
    try {
      await backend.restoreCard(cardId);
      await docs().refresh([cardId]);
    } catch (e) {
      useShell.getState().setNotice(t("error.generic", { message: String(e) }));
      return;
    }
    useShell.getState().setNotice(t("trash.restored", { title: title || t("library.untitled") }));
    cardsChanged();
  }

  return (
    <div className="page card-page" ref={root}>
      {/* Still open, but in the trash: say so, and how to get it back. It
          is not in the library, search or pinned cards until then. */}
      {handle && trashed && (
        <div className="card-trashed" role="status">
          <Trash2 size={15} />
          <span>{t("card.inTrash")}</span>
          <button className="button" onClick={() => void restore()}>
            {t("trash.restore")}
          </button>
        </div>
      )}
      {handle && (
        <div className="card-title-row" data-page-title>
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
          <CardMenu cardId={cardId} title={title} onToc={tocOffered ? () => setTocSheet(tocKey) : undefined} />
        </div>
      )}
      {handle && <TitleChange cardId={cardId} />}
      {handle && <TopicRow handle={handle} />}
      {handle && <ClipSource handle={handle} />}
      {handle && <CardFields handle={handle} />}
      <div className="card-body-area" onMouseDown={clickBelow}>
        <CardEditor
          docId={cardId}
          placeholder={t("card.bodyPlaceholder")}
          onOpenCard={(id, linkTitle, side) => open({ kind: "card", cardId: id }, linkTitle, side)}
          extensions={(h) => [extractExtension(h), titleEdge(toTitle)]}
          onReady={(e) => {
            editor.current = e;
            setView(e.view);
            const at = takePending(pane, cardId);
            if (at) setTimeout(() => revealIn(e.view, at), 50);
          }}
        />
      </div>
      {/* Shown in the details panel instead while it is about this card. */}
      {!inPanel && <Backlinks cardId={cardId} active={active} />}
      {tocOpen && <TocSheet cardId={cardId} title={title} pane={pane} headings={headings} onClose={() => setTocSheet(null)} />}
    </div>
  );
}
