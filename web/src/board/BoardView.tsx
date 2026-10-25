import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlignCenterVertical,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignStartVertical,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileDown,
  Grid2x2,
  Group,
  Hand,
  Map as MapIcon,
  Maximize2,
  Minus,
  MousePointer2,
  Network,
  Plus,
  Scan,
  Search,
  SquarePlus,
  Trash2,
  Type,
  Unlink,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type { CardText } from "../bindings/commands";
import { CARDS_CHANGED, cardsChanged } from "../card/actions";
import { CARDS_MIME } from "../card/drag";
import {
  addEdge,
  addItem,
  addMindChild,
  addMindRoot,
  align,
  attach,
  boardId,
  branchColor,
  childrenOf,
  COLORS,
  descendants,
  detach,
  hiddenByFold,
  inMap,
  makeRoot,
  mindLayout,
  mindLinks,
  mindToCard,
  moveSibling,
  setCollapsed,
  duplicateItems,
  freeSpot,
  insideSection,
  placeItems,
  raise,
  readEdges,
  readItems,
  removeEdges,
  removeItems,
  sectionAround,
  setColor,
  setEdgeLabel,
  setEdgeLook,
  setItemFlags,
  setItemText,
  tidyUp,
  toJsonCanvas,
  type Alignment,
  type BoardColor,
  type BoardEdge,
  type BoardItem,
  type Side,
} from "../docs/board";
import type { DocHandle } from "../docs/hub";
import { DOC_SAVED } from "../docs/persistence";
import { useBoards, workspaceDoc } from "../docs/topics";
import { renameBoard } from "../docs/workspace";
import { CardEditor } from "../editor/CardEditor";
import { backend } from "../platform";
import { useTouch } from "../shell/phone";
import { focusedPane, useShell } from "../shell/tabs";
import { cardFragment } from "./cardHtml";
import "../editor/editor.css";
import "./board.css";

const VIEWPORT_SETTING = (id: string) => `board.viewport.${id}`;
const MINIMAP_SETTING = "board.minimap";
const SIDES: Side[] = ["top", "right", "bottom", "left"];
const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
/** Below this zoom cards show their titles only and section titles grow, so
 *  a whole board stays readable (Heptabase: zoomed out, section names). */
const FAR = 0.45;

/** Copied items, for pasting into this or another board. */
let clipboard: { items: BoardItem[]; edges: BoardEdge[] } | null = null;

type Tool = "select" | "hand";

interface BoardCtx {
  doc: DocHandle["doc"];
  texts: Map<string, CardText>;
  editing: string | null;
  setEditing: (id: string | null) => void;
  openCard: (cardId: string) => void;
  resized: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  far: boolean;
  /** Mind maps: a new node under `from`, or after it. */
  mindAdd: (from: string, how: "child" | "sibling") => void;
}
const Ctx = createContext<BoardCtx | null>(null);
const useBoard = () => useContext(Ctx)!;

/** `mind`: for a node in a mind map, how many children it has and the
 *  colour of its branch. */
type ItemData = { item: BoardItem; mind?: { kids: number; color?: BoardColor } };

/** Focuses an element once it can take focus: xyflow keeps a new node
 *  hidden until it has measured it, and a hidden field ignores focus(). */
function focusSoon(get: () => HTMLElement | null, tries = 20) {
  const el = get();
  if (el && document.activeElement === el) return;
  el?.focus();
  if ((!el || document.activeElement !== el) && tries > 0) requestAnimationFrame(() => focusSoon(get, tries - 1));
}

/** Connection points on all four sides; any can start or end a line. */
function Handles() {
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s} id={s} type="source" position={POSITION[s]} className="board-handle" />
      ))}
    </>
  );
}

/** The card's formatted body, kept current with its document. */
function CardPreview({ cardId }: { cardId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const hub = docs();
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    void hub.open(cardId).then(
      (h) => {
        if (gone) return;
        const draw = () => host.current?.replaceChildren(cardFragment(h.doc));
        draw();
        unsubscribe = h.doc.subscribe(() => {
          clearTimeout(timer);
          timer = setTimeout(draw, 120);
        });
      },
      () => {},
    );
    return () => {
      gone = true;
      clearTimeout(timer);
      unsubscribe();
      void hub.release(cardId);
    };
  }, [cardId]);
  return <div ref={host} className="card-body board-card-body" />;
}

/** The knob at a map node's right: folds its branch, and, folded, says how
 *  many nodes hang below. */
function MindFold({ item, kids }: { item: BoardItem; kids: number }) {
  const { t } = useTranslation();
  const { doc } = useBoard();
  return (
    <button
      className={`board-mind-fold nodrag${item.collapsed ? " collapsed" : ""}`}
      title={t(item.collapsed ? "board.unfoldBranch" : "board.foldBranch")}
      aria-label={t(item.collapsed ? "board.unfoldBranch" : "board.foldBranch")}
      onClick={(e) => {
        e.stopPropagation();
        setCollapsed(doc, item.id, !item.collapsed);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {item.collapsed ? kids : <Minus size={10} />}
    </button>
  );
}

/** A text node of a mind map: grows with its text; Enter ends editing,
 *  Tab ends it and starts a child. */
function MindNode({ data }: NodeProps<Node<ItemData>>) {
  const { t } = useTranslation();
  const { doc, editing, setEditing, mindAdd } = useBoard();
  const item = data.item;
  const color = item.color ?? data.mind?.color;
  const isEditing = editing === item.id;
  const [value, setValue] = useState(item.text ?? "");
  useEffect(() => setValue(item.text ?? ""), [item.text]);
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
    if (isEditing) focusSoon(() => area.current);
  }, [isEditing]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, isEditing]);
  const finish = (then?: () => void) => {
    if (done.current) return;
    done.current = true;
    // A new node left empty goes away again, unless it has branches.
    if (!value.trim() && !item.text && !item.root && !childrenOf(readItems(doc), item.id).length && !then) removeItems(doc, [item.id]);
    else if (value !== (item.text ?? "")) setItemText(doc, item.id, value);
    setEditing(null);
    then?.();
  };
  // However editing ends (Escape is taken before the field sees it, a click
  // elsewhere), what was typed is kept, and an empty new node goes away.
  const latest = useRef({ finish, editing });
  latest.current = { finish, editing };
  useEffect(() => {
    if (!isEditing) return;
    return () => {
      // StrictMode's trial unmount happens while still editing: not an end.
      if (latest.current.editing !== item.id) latest.current.finish();
    };
  }, [isEditing, item.id]);
  return (
    <div className={`board-mind${item.root ? " root" : ""}${color ? ` color-${color}` : ""}`} onDoubleClick={() => setEditing(item.id)}>
      <Handles />
      {isEditing ? (
        <textarea
          ref={area}
          className="nodrag nowheel"
          rows={1}
          value={value}
          placeholder={t("board.mindPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish()}
          // Editing goes on from the end of what is there.
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              finish();
            } else if (e.key === "Tab") {
              e.preventDefault();
              finish(() => mindAdd(item.id, e.shiftKey ? "sibling" : "child"));
            }
          }}
        />
      ) : (
        <div className={`board-mind-text${item.text ? "" : " empty"}`}>{item.text || t("board.mindPlaceholder")}</div>
      )}
      {!!data.mind?.kids && <MindFold item={item} kids={data.mind.kids} />}
    </div>
  );
}

function CardNode({ data, selected }: NodeProps<Node<ItemData>>) {
  const { t } = useTranslation();
  const { doc, texts, editing, setEditing, openCard, resized, far } = useBoard();
  const zoom = useStore((s) => s.transform[2]);
  const item = data.item;
  const text = item.cardId ? texts.get(item.cardId) : undefined;
  const isEditing = editing === item.id;
  const showBody = !item.folded && (isEditing || !far);
  return (
    <>
    <div
      className={`board-card${item.color ? ` color-${item.color}` : ""}${isEditing ? " editing" : ""}${text?.deleted ? " deleted" : ""}${item.fixed ? " fixed" : ""}${item.folded ? " folded" : ""}${far ? " far" : ""}`}
      onDoubleClick={() => item.cardId && !item.folded && setEditing(item.id)}
    >
      <NodeResizer isVisible={selected && !isEditing && !item.folded} minWidth={180} minHeight={60} lineClassName="board-resize-line" handleClassName="board-resize-handle" onResizeEnd={(_, b) => resized(item.id, b)} />
      <Handles />
      {/* Zoomed out, the title keeps a readable size on screen. */}
      <div className="board-card-title" style={far ? { fontSize: Math.min(72, 17 / Math.max(zoom, 0.05)) } : undefined}>
        <button
          className="board-fold nodrag"
          aria-label={t(item.folded ? "board.unfold" : "board.fold")}
          title={t(item.folded ? "board.unfold" : "board.fold")}
          onClick={(e) => {
            e.stopPropagation();
            setItemFlags(doc, [item.id], { folded: !item.folded });
          }}
        >
          {item.folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>{text?.title || t("library.untitled")}</span>
        {item.cardId && (
          <button className="icon-button board-card-open nodrag" title={t("board.openCard")} aria-label={t("board.openCard")} onClick={() => openCard(item.cardId!)}>
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      {text?.deleted && <p className="board-card-note">{t("board.inTrash")}</p>}
      {showBody &&
        (isEditing && item.cardId ? (
          <div className="board-card-editor nodrag nowheel nopan">
            <CardEditor docId={item.cardId} placeholder={t("card.bodyPlaceholder")} autoFocus onOpenCard={(id) => openCard(id)} />
          </div>
        ) : item.cardId ? (
          <div className={`board-card-content${item.fixed ? " nowheel" : ""}`}>
            <CardPreview cardId={item.cardId} />
          </div>
        ) : null)}
    </div>
    {/* Outside the card, which clips what overflows it. */}
    {!!data.mind?.kids && <MindFold item={item} kids={data.mind.kids} />}
    </>
  );
}

function TextNode({ data, selected }: NodeProps<Node<ItemData>>) {
  const { t } = useTranslation();
  const { doc, editing, setEditing, resized } = useBoard();
  const item = data.item;
  const isEditing = editing === item.id;
  const [value, setValue] = useState(item.text ?? "");
  useEffect(() => setValue(item.text ?? ""), [item.text]);
  const area = useRef<HTMLTextAreaElement>(null);
  // Editing starts focused, also when a toolbar click (which WebKit does not
  // focus) started it.
  useEffect(() => {
    if (isEditing) focusSoon(() => area.current);
  }, [isEditing]);
  // The box grows with what is typed.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, isEditing]);
  return (
    <div className={`board-text${item.color ? ` color-${item.color}` : ""}${item.fixed ? " fixed" : ""}`} onDoubleClick={() => setEditing(item.id)}>
      <NodeResizer isVisible={selected && !isEditing} minWidth={80} minHeight={36} lineClassName="board-resize-line" handleClassName="board-resize-handle" onResizeEnd={(_, b) => resized(item.id, b)} />
      <Handles />
      {isEditing ? (
        <textarea
          ref={area}
          className="nodrag nowheel"
          autoFocus
          value={value}
          placeholder={t("board.textPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (!value.trim() && !item.text) removeItems(doc, [item.id]);
            else setItemText(doc, item.id, value);
            setEditing(null);
          }}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
      ) : (
        <div className="board-text-body">{item.text}</div>
      )}
    </div>
  );
}

function SectionNode({ data, selected }: NodeProps<Node<ItemData>>) {
  const { t } = useTranslation();
  const { doc, editing, setEditing, resized } = useBoard();
  const zoom = useStore((s) => s.transform[2]);
  const item = data.item;
  const isEditing = editing === item.id;
  // The title keeps a readable size on screen when zoomed out.
  const size = Math.min(64, Math.max(16, 16 / Math.max(zoom, 0.05)));
  return (
    <div className={`board-section${item.color ? ` color-${item.color}` : ""}${selected ? " selected" : ""}`}>
      {/* Where a section can be taken to move it: its whole title bar, a
          band along its border, and, once selected, anywhere inside (cards
          inside stay on top and keep their own clicks). */}
      {selected && <div className="board-section-body board-section-drag" />}
      {SIDES.map((s) => (
        <div key={s} className={`board-section-edge ${s} board-section-drag`} />
      ))}
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100} lineClassName="board-resize-line" handleClassName="board-resize-handle" onResizeEnd={(_, b) => resized(item.id, b)} />
      <Handles />
      <div className="board-section-bar board-section-drag" style={{ height: size * 1.3 + 22 }} onDoubleClick={() => setEditing(item.id)}>
      <div className="board-section-title" style={{ fontSize: size }}>
        {isEditing ? (
          <input
            className="nodrag"
            autoFocus
            ref={(el) => void (el && focusSoon(() => el))}
            defaultValue={item.text ?? ""}
            placeholder={t("board.untitledSection")}
            onBlur={(e) => {
              setItemText(doc, item.id, e.currentTarget.value.trim());
              setEditing(null);
            }}
            onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
          />
        ) : (
          item.text || t("board.untitledSection")
        )}
      </div>
      </div>
    </div>
  );
}

function LabeledEdge(props: EdgeProps<Edge<{ edge: BoardEdge; editing: boolean; setEditing: (id: string | null) => void }>>) {
  const { doc } = useBoard();
  const [path, lx, ly] = getBezierPath(props);
  const { edge, editing, setEditing } = props.data!;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} markerStart={props.markerStart} style={props.style} interactionWidth={18} />
      <EdgeLabelRenderer>
        <div
          className={`board-edge-label nodrag nopan${edge.label || editing ? "" : " empty"}${props.selected ? " selected" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onDoubleClick={() => setEditing(edge.id)}
        >
          {editing ? (
            <input
              autoFocus
              defaultValue={edge.label ?? ""}
              onBlur={(e) => {
                setEdgeLabel(doc, edge.id, e.currentTarget.value);
                setEditing(null);
              }}
              onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
            />
          ) : (
            edge.label
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** A mind map's branch: from the parent's right to the child's left. */
function MindEdge(props: EdgeProps) {
  const [path] = getBezierPath({ ...props, curvature: 0.35 });
  return <BaseEdge id={props.id} path={path} style={props.style} interactionWidth={0} />;
}

const NODE_TYPES = { card: CardNode, text: TextNode, section: SectionNode, mind: MindNode };
const EDGE_TYPES = { labeled: LabeledEdge, mind: MindEdge };

const toNode = (item: BoardItem, mind?: ItemData["mind"]): Node<ItemData> => ({
  id: item.id,
  type: item.kind,
  position: { x: item.x, y: item.y },
  // Map text nodes take the width of their text.
  width: item.kind === "mind" ? undefined : item.w,
  // Cards and texts that grow with their content leave the height to it.
  height: item.fixed || item.kind === "section" ? item.h : undefined,
  style: item.kind === "mind" ? {} : { width: item.w, ...(item.fixed || item.kind === "section" ? { height: item.h } : {}) },
  data: { item, mind },
  zIndex: item.kind === "section" ? -1 : item.z,
  dragHandle: item.kind === "section" ? ".board-section-drag" : undefined,
});

/** Puts a card that already exists on the board: search by title or text;
 *  with nothing typed, the latest cards. */
function AddCard({ placed, onPick }: { placed: Set<string>; onPick: (cardId: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<{ id: string; title: string; preview: string }[]>([]);
  // Each opening starts a new search.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const q = query.trim();
      const found = q
        ? (await backend.search(q, 40)).map((h) => ({ id: h.cardId, title: h.cardTitle, preview: h.bid ? h.text : "" }))
        : (await backend.listCards(30)).map((c) => ({ id: c.id, title: c.title, preview: c.preview }));
      const seen = new Set<string>();
      if (!stale) setRows(found.filter((r) => !seen.has(r.id) && seen.add(r.id) && !r.id.startsWith("journal:")));
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, query]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="board-tool" title={t("board.addCard")} aria-label={t("board.addCard")}>
        <Search size={17} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="center" sideOffset={10}>
          <Popover.Popup className="popup board-add">
            <input autoFocus value={query} placeholder={t("board.addCardSearch")} onChange={(e) => setQuery(e.target.value)} />
            <ul>
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    className="popup-item"
                    disabled={placed.has(r.id)}
                    onClick={() => {
                      onPick(r.id);
                      setOpen(false);
                    }}
                  >
                    <span>{r.title || t("library.untitled")}</span>
                    <small>{placed.has(r.id) ? t("board.onBoard") : r.preview}</small>
                  </button>
                </li>
              ))}
            </ul>
            <p className="board-add-hint">{t("board.dragHint")}</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The board's name at the top left; click to rename. */
function BoardTitle({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  return (
    <span className="board-title-wrap" data-value={value || t("board.untitled")}>
    <input
      className="board-title"
      size={1}
      value={value}
      placeholder={t("board.untitled")}
      aria-label={t("board.name")}
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => {
        const next = value.trim();
        if (!next) return setValue(name);
        if (next !== name) renameBoard((await workspaceDoc()).doc, id, next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(name);
          e.currentTarget.blur();
        }
      }}
    />
    </span>
  );
}

type MenuTarget = { on: "pane"; at: { x: number; y: number } } | { on: "node"; id: string } | { on: "edge"; id: string };
type Menu = { x: number; y: number } & MenuTarget;

/** A whiteboard (§4.3), in its own tab. */
export function BoardView({ boardId: id, active }: { boardId: string; active: boolean }) {
  return (
    <ReactFlowProvider>
      <Board id={id} active={active} />
    </ReactFlowProvider>
  );
}

function Board({ id, active }: { id: string; active: boolean }) {
  const { t } = useTranslation();
  const flow = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  // Is anything on the board in view? If not, offer the way back.
  const lost = useStore((s) => {
    const [tx, ty, k] = s.transform;
    if (s.nodeLookup.size === 0 || !s.width) return false;
    const view = { l: -tx / k, t: -ty / k, r: (s.width - tx) / k, b: (s.height - ty) / k };
    for (const n of s.nodeLookup.values()) {
      const { x, y } = n.internals.positionAbsolute;
      const w = n.measured?.width ?? n.width ?? 0;
      const h = n.measured?.height ?? n.height ?? 0;
      if (x < view.r && x + w > view.l && y < view.b && y + h > view.t) return false;
    }
    return true;
  });
  const info = useBoards((s) => s.boards.find((b) => b.id === id));
  const [handle, setHandle] = useState<DocHandle | null>(null);
  const [items, setItems] = useState<BoardItem[]>([]);
  const [edges, setEdges] = useState<BoardEdge[]>([]);
  const [nodes, setNodes] = useState<Node<ItemData>[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [texts, setTexts] = useState<Map<string, CardText>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // A finger on the canvas moves it (the select tool's box would leave no
  // way to move around); pinch zooms; long press opens the menus.
  const touch = useTouch();
  const [minimap, setMinimap] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  // A menu opened near an edge (a long press at the side of a phone) moves
  // back inside the board.
  useLayoutEffect(() => {
    const el = menuBox.current;
    const area = wrapper.current;
    if (!el || !area || !menu) return;
    const w = area.clientWidth;
    const h = area.clientHeight;
    el.style.left = `${Math.max(8, Math.min(menu.x, w - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, h - el.offsetHeight - 8))}px`;
  }, [menu]);
  const dragging = useRef(false);
  const carried = useRef<{ ids: string[]; start: Map<string, { x: number; y: number }>; from: { x: number; y: number } } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // Mind maps: measured node sizes for the layout (bumped when one changes),
  // the node to select once it appears, and the node a drag would drop on.
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const [relayout, setRelayout] = useState(0);
  const selectNext = useRef<string | null>(null);
  const dropOn = useRef<string | null>(null);
  const dragged = useRef<string[]>([]);

  // The board document: open while the tab exists.
  useEffect(() => {
    const hub = docs();
    const docId = boardId(id);
    let gone = false;
    let unsubscribe = () => {};
    void hub.open(docId).then((h) => {
      if (gone) return;
      setHandle(h);
      const read = () => {
        const next = readItems(h.doc);
        setItems(next);
        setEdges(readEdges(h.doc, next));
      };
      read();
      unsubscribe = h.doc.subscribe(read);
    });
    return () => {
      gone = true;
      unsubscribe();
      void hub.release(docId);
    };
  }, [id]);

  useEffect(() => {
    void backend.getLocalSetting<boolean>(MINIMAP_SETTING).then((v) => setMinimap(v === true), () => {});
  }, []);

  // Mind maps: where their nodes go, which are folded away, their lines.
  const maps = useMemo(() => {
    const size = (i: BoardItem) => sizes.current.get(i.id) ?? { w: i.kind === "mind" ? 120 : i.w, h: i.kind === "mind" ? 40 : i.folded ? 44 : i.h };
    const kids = new Map<string, number>();
    for (const i of items) if (i.parent) kids.set(i.parent, (kids.get(i.parent) ?? 0) + 1);
    const members = new Set(items.filter((i) => inMap(items, i)).map((i) => i.id));
    const info = new Map<string, NonNullable<ItemData["mind"]>>();
    for (const id of members) info.set(id, { kids: kids.get(id) ?? 0, color: branchColor(items, id) });
    return { at: mindLayout(items, size), hidden: hiddenByFold(items), links: mindLinks(items), members, info };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, relayout]);

  // Nodes follow the document, except while something is being dragged.
  useEffect(() => {
    if (dragging.current) return;
    // Read outside the updater, which StrictMode runs twice.
    const next = selectNext.current && items.some((i) => i.id === selectNext.current) ? selectNext.current : null;
    if (next) selectNext.current = null;
    setNodes((prev) => {
      const selected = next ? new Set([next]) : new Set(prev.filter((n) => n.selected).map((n) => n.id));
      // Keep what xyflow measured: a node without it is hidden until it is
      // measured again, and hiding it takes the focus from a field being
      // edited (a map node that grows as editing starts moves its map).
      const measuredOf = new Map(prev.map((n) => [n.id, n.measured]));
      return items.map((i) => ({
        ...toNode(i, maps.info.get(i.id)),
        measured: measuredOf.get(i.id),
        position: maps.at.get(i.id) ?? { x: i.x, y: i.y },
        hidden: maps.hidden.has(i.id),
        selected: selected.has(i.id),
      }));
    });
  }, [items, maps]);

  // Card titles (and whether a card is in the trash).
  const cardIds = useMemo(() => items.filter((i) => i.kind === "card" && i.cardId).map((i) => i.cardId!), [items]);
  const loadCards = useCallback(async () => {
    const rows = await backend.cardTexts(cardIds);
    setTexts(new Map(rows.map((r) => [r.id, r])));
  }, [cardIds]);
  useEffect(() => {
    if (!active) return;
    void loadCards();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadCards(), 600);
    };
    window.addEventListener(CARDS_CHANGED, soon);
    window.addEventListener(DOC_SAVED, soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARDS_CHANGED, soon);
      window.removeEventListener(DOC_SAVED, soon);
    };
  }, [active, loadCards]);
  const placed = useMemo(() => new Set(cardIds), [cardIds]);

  // Where the board was left, or everything in view.
  useEffect(() => {
    if (!handle || ready) return;
    void backend.getLocalSetting<Viewport>(VIEWPORT_SETTING(id)).then((v) => {
      if (v && typeof v.zoom === "number") void flow.setViewport(v);
      else setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }), 0);
      setReady(true);
    });
  }, [handle, ready, flow, id]);

  const doc = handle?.doc;
  const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
  const selectedItems = items.filter((i) => selectedIds.includes(i.id));
  /** Items with their real size (cards that grow have a measured height). */
  const measured = (list: BoardItem[]) =>
    list.map((i) => {
      const n = flow.getNode(i.id);
      return { ...i, x: n?.position.x ?? i.x, y: n?.position.y ?? i.y, w: n?.measured?.width ?? i.w, h: n?.measured?.height ?? i.h };
    });
  const centre = () => {
    const r = wrapper.current?.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 });
  };

  const openCard = useCallback((cardId: string) => useShell.getState().open({ kind: "card", cardId }, null, true), []);

  /** Puts cards on the board around a point, each in a free spot. */
  const place = (ids: string[], at: { x: number; y: number }) => {
    if (!doc) return;
    for (const cardId of ids) addItem(doc, { kind: "card", cardId, ...freeSpot(measured(readItems(doc)), { x: at.x - 140, y: at.y - 40 }, 280, 160) });
  };

  const newCard = async (at = centre()) => {
    if (!doc) return;
    const cardId = await backend.createCard("");
    const item = addItem(doc, { kind: "card", cardId, ...freeSpot(measured(items), { x: at.x - 140, y: at.y - 30 }, 280, 160) });
    setEditing(item);
    cardsChanged();
  };

  const newText = (at = centre()) => {
    if (!doc) return;
    setEditing(addItem(doc, { kind: "text", text: "", x: at.x - 110, y: at.y - 20 }));
  };

  const newSection = () => {
    if (!doc) return;
    const inside = measured(selectedItems.filter((i) => i.kind !== "section"));
    const c = centre();
    const box = inside.length ? sectionAround(inside) : { x: c.x - 240, y: c.y - 160, w: 480, h: 320 };
    setEditing(addItem(doc, { kind: "section", text: "", ...box }));
  };

  /** A new map, its centre ready for its name. */
  const newMind = (at = centre()) => {
    if (!doc) return;
    const id = addMindRoot(doc, { x: at.x - 60, y: at.y - 20 }, t("board.mindRoot"));
    selectNext.current = id;
  };

  const mindAdd = (from: string, how: "child" | "sibling") => {
    if (!doc) return;
    const all = readItems(doc);
    const node = all.find((i) => i.id === from);
    if (!node || node.kind === "section" || node.kind === "text") return;
    let id: string;
    if (how === "sibling" && node.parent && !node.root && inMap(all, node)) id = addMindChild(doc, node.parent, { after: from });
    else {
      if (!inMap(all, node)) makeRoot(doc, from);
      if (node.collapsed) setCollapsed(doc, from, false);
      id = addMindChild(doc, from);
    }
    selectNext.current = id;
    setEditing(id);
  };

  /** A map's text node becomes a card titled with its text. */
  const mindCard = async (itemId: string) => {
    const item = doc && readItems(doc).find((i) => i.id === itemId);
    if (!doc || item?.kind !== "mind") return;
    mindToCard(doc, itemId, await backend.createCard(item.text?.trim() ?? ""));
    cardsChanged();
  };

  /** The map node under a point, not one of `skip` or below them. */
  const mindNodeAt = (p: { x: number; y: number }, skip: string[]) => {
    const out = new Set(skip);
    for (const id of skip) for (const d of descendants(items, id)) out.add(d);
    let best: Node | null = null;
    for (const n of flow.getNodes()) {
      if (out.has(n.id) || n.hidden || !maps.members.has(n.id)) continue;
      const w = n.measured?.width ?? 0;
      const h = n.measured?.height ?? 0;
      if (p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h && (!best || (n.zIndex ?? 0) >= (best.zIndex ?? 0))) best = n;
    }
    return best?.id ?? null;
  };
  const markDrop = (id: string | null) => {
    if (dropOn.current === id) return;
    dropOn.current = id;
    setNodes((ns) => ns.map((n) => ({ ...n, className: n.id === id ? "drop-target" : undefined })));
  };

  const removeSelected = () => {
    if (!doc) return;
    if (selectedIds.length) removeItems(doc, selectedIds);
    if (selectedEdges.size) removeEdges(doc, [...selectedEdges]);
  };

  const copy = () => {
    if (!selectedItems.length) return;
    const ids = new Set(selectedIds);
    clipboard = { items: measured(selectedItems), edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  };
  const paste = (at?: { x: number; y: number }) => {
    if (!doc || !clipboard) return;
    const left = Math.min(...clipboard.items.map((i) => i.x));
    const top = Math.min(...clipboard.items.map((i) => i.y));
    const dx = at ? at.x - left : 40;
    const dy = at ? at.y - top : 40;
    const fresh = duplicateItems(doc, clipboard.items, clipboard.edges, dx, dy);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: fresh.includes(n.id) })));
  };
  const duplicate = () => {
    if (!doc || !selectedItems.length) return;
    const ids = new Set(selectedIds);
    duplicateItems(doc, measured(selectedItems), edges.filter((e) => ids.has(e.from) && ids.has(e.to)));
  };

  const tidy = () => doc && placeItems(doc, tidyUp(measured(selectedItems.filter((i) => i.kind !== "section"))));
  const alignTo = (how: Alignment) => doc && placeItems(doc, align(measured(selectedItems.filter((i) => i.kind !== "section")), how));

  const exportCanvas = async () => {
    const rows = new Map((await backend.cardTexts(cardIds)).map((r) => [r.id, r]));
    const md = (cardId: string) => {
      const c = rows.get(cardId);
      if (!c) return "";
      const body = c.text
        .split("\n")
        .map((l) => {
          const depth = l.length - l.replace(/^\t+/, "").length;
          return depth > 0 ? `${"  ".repeat(depth - 1)}- ${l.trim()}` : l;
        })
        .join("\n\n");
      return `# ${c.title || t("library.untitled")}\n\n${body}`.trim();
    };
    const path = await backend.saveTextFile(`${info?.name || "board"}.canvas`, toJsonCanvas(measured(items), edges, md));
    if (path) useShell.getState().setNotice(t("board.exported", { path }));
  };

  // Moving: sections take what lies inside them along.
  const onNodesChange = (changes: NodeChange<Node<ItemData>>[]) => {
    // A map node that changed size moves its neighbours.
    let moved = false;
    for (const ch of changes) {
      if (ch.type !== "dimensions" || !ch.dimensions) continue;
      const was = sizes.current.get(ch.id);
      const { width: w, height: h } = ch.dimensions;
      if (was && Math.abs(was.w - w) < 0.5 && Math.abs(was.h - h) < 0.5) continue;
      sizes.current.set(ch.id, { w, h });
      if (maps.members.has(ch.id)) moved = true;
    }
    if (moved) setRelayout((n) => n + 1);
    setNodes((ns) => {
      let next = applyNodeChanges(changes, ns);
      const c = carried.current;
      if (c) {
        const lead = changes.find((ch) => ch.type === "position" && ch.position && ch.id === c.ids[0]);
        if (lead && lead.type === "position" && lead.position) {
          const dx = lead.position.x - c.from.x;
          const dy = lead.position.y - c.from.y;
          next = next.map((n) => (c.start.has(n.id) && n.id !== c.ids[0] ? { ...n, position: { x: c.start.get(n.id)!.x + dx, y: c.start.get(n.id)!.y + dy } } : n));
        }
      }
      return next;
    });
  };

  const onNodeDragStart = (_: unknown, node: Node<ItemData>, moving: Node<ItemData>[]) => {
    dragging.current = true;
    dragged.current = moving.map((n) => n.id);
    setMenu(null);
    const item = items.find((i) => i.id === node.id);
    if (item && maps.members.has(item.id) && moving.length === 1) {
      // A map node takes its branch along.
      const below = descendants(items, item.id).filter((d) => !maps.hidden.has(d));
      carried.current = {
        ids: [item.id, ...below],
        start: new Map(below.map((d) => [d, flow.getNode(d)?.position ?? { x: 0, y: 0 }])),
        from: { ...node.position },
      };
    } else if (item?.kind === "section") {
      const all = measured(items);
      const inside = insideSection(all.find((i) => i.id === item.id)!, all);
      carried.current = {
        ids: [item.id, ...inside],
        start: new Map(all.filter((i) => inside.includes(i.id)).map((i) => [i.id, { x: i.x, y: i.y }])),
        from: { x: item.x, y: item.y },
      };
    }
  };

  // While dragging one node: is it over a map node it would join?
  const onNodeDrag = (e: MouseEvent | TouchEvent, node: Node<ItemData>) => {
    const item = node.data.item;
    const joins = dragged.current.length === 1 && (item.kind === "card" || item.kind === "mind") && !item.root;
    const p = "touches" in e ? e.touches[0] : e;
    markDrop(joins && p ? mindNodeAt(flow.screenToFlowPosition({ x: p.clientX, y: p.clientY }), [node.id]) : null);
  };

  const onNodeDragStop = () => {
    dragging.current = false;
    carried.current = null;
    const target = dropOn.current;
    markDrop(null);
    if (!doc) return;
    const current = flow.getNodes();
    const one = dragged.current.length === 1 ? items.find((i) => i.id === dragged.current[0]) : undefined;
    // Laid-out map nodes keep no position of their own.
    const laidOut = (id: string) => maps.members.has(id) && !items.find((i) => i.id === id)?.root;
    placeItems(
      doc,
      current.filter((n) => !laidOut(n.id)).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
    );
    if (one && target) attach(doc, one.id, target);
    else if (one && laidOut(one.id)) {
      // Dropped well away from its place: out of the map, where it lies.
      const was = maps.at.get(one.id);
      const now = current.find((n) => n.id === one.id)?.position;
      if (was && now && Math.hypot(now.x - was.x, now.y - was.y) > 120) detach(doc, one.id, now);
    }
    const moved = current.filter((n) => n.selected && n.type !== "section").map((n) => n.id);
    if (moved.length) raise(doc, moved);
    // Map nodes go back to their places in the layout.
    setRelayout((n) => n + 1);
  };

  const onConnect = (c: Connection) => {
    if (!doc || !c.source || !c.target) return;
    addEdge(doc, { from: c.source, to: c.target, fromSide: (c.sourceHandle as Side) ?? undefined, toSide: (c.targetHandle as Side) ?? undefined });
  };

  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest?.("input, textarea, [contenteditable='true']")) {
      if (e.key === "Escape") setEditing(null);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && key === "z" && handle) {
      take();
      if (e.shiftKey) handle.undo.redo();
      else handle.undo.undo();
    } else if (mod && key === "g") {
      take();
      newSection();
    } else if (mod && key === "0") {
      take();
      void flow.fitView({ padding: 0.2, duration: 200 });
    } else if (mod && key === "c") {
      if (selectedItems.length) take();
      copy();
    } else if (mod && key === "v" && clipboard) {
      take();
      paste();
    } else if (mod && key === "d") {
      take();
      duplicate();
    } else if (mod && key === "a") {
      take();
      setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    } else if (!mod && key === "v") {
      setTool("select");
    } else if (!mod && key === "h") {
      setTool("hand");
    } else if (!mod && e.key === "Tab" && selectedItems.length === 1) {
      take();
      mindAdd(selectedItems[0].id, e.shiftKey ? "sibling" : "child");
    } else if (!mod && e.key === "Enter" && selectedItems.length === 1 && maps.members.has(selectedItems[0].id)) {
      take();
      mindAdd(selectedItems[0].id, "sibling");
    } else if (!mod && e.key === " " && selectedItems.length === 1 && selectedItems[0].kind === "mind") {
      take();
      setEditing(selectedItems[0].id);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && selectedItems.length === 1 && doc) {
      take();
      moveSibling(doc, selectedItems[0].id, e.key === "ArrowUp" ? -1 : 1);
    } else if (!mod && key === "m") {
      take();
      newMind();
    } else if (!mod && key === "t") {
      take();
      newText();
    } else if (!mod && key === "n") {
      take();
      void newCard();
    } else if (e.key === "Escape") {
      setEditing(null);
      setMenu(null);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    }
  };

  // Board keys work while this board is the focused pane's tab, also when
  // focus fell back to the page (a deleted node had it): capture phase, so
  // the app's own shortcuts do not run too.
  const keys = useRef(onKeyDown);
  keys.current = onKeyDown;
  useEffect(() => {
    if (!active) return;
    const listener = (e: globalThis.KeyboardEvent) => {
      const s = useShell.getState();
      if (s.dialog || s.searchOpen || focusedPane(s).active !== `board:${id}`) return;
      const target = e.target;
      if (target instanceof Element && target !== document.body && !target.closest(".board")) return;
      keys.current(e);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active, id]);

  // Cards dragged in from the card library (the other pane of a split view).
  const onDrop = (e: DragEvent) => {
    const ids = JSON.parse(e.dataTransfer.getData(CARDS_MIME) || "[]") as string[];
    if (!ids.length) return;
    e.preventDefault();
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Dropped on a map node: the cards hang under it.
    const target = mindNodeAt(at, []);
    if (target && doc) for (const cardId of ids) addMindChild(doc, target, { cardId });
    else place(ids, at);
  };

  const contextMenu = (e: ReactMouseEvent | MouseEvent, m: MenuTarget) => {
    e.preventDefault();
    const r = wrapper.current!.getBoundingClientRect();
    setMenu({ ...m, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const flowEdges: Edge<{ edge: BoardEdge; editing: boolean; setEditing: (id: string | null) => void }>[] = edges.map((e) => {
    const marker = { type: MarkerType.ArrowClosed, width: 18, height: 18 };
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: e.fromSide ?? null,
      targetHandle: e.toSide ?? null,
      type: "labeled",
      selected: selectedEdges.has(e.id),
      data: { edge: e, editing: editingEdge === e.id, setEditing: setEditingEdge },
      markerEnd: e.arrows === "none" ? undefined : marker,
      markerStart: e.arrows === "both" ? marker : undefined,
      style: e.style === "dashed" ? { strokeDasharray: "6 5" } : undefined,
      className: e.color ? `color-${e.color}` : undefined,
    };
  });
  for (const l of maps.links) {
    const color = maps.info.get(l.child)?.color;
    flowEdges.push({
      id: `mind:${l.child}`,
      source: l.parent,
      target: l.child,
      sourceHandle: "right",
      targetHandle: "left",
      type: "mind",
      selectable: false,
      deletable: false,
      focusable: false,
      className: `board-mind-edge${color ? ` color-${color}` : ""}`,
    } as (typeof flowEdges)[number]);
  }

  if (!info) return <p className="empty board-gone">{t("board.gone")}</p>;
  const resized = (itemId: string, b: { x: number; y: number; width: number; height: number }) => {
    if (!doc) return;
    placeItems(doc, [{ id: itemId, x: b.x, y: b.y, w: b.width, h: b.height }]);
    // Sized by hand: it keeps that size and scrolls (Heptabase).
    if (items.find((i) => i.id === itemId)?.kind !== "section") setItemFlags(doc, [itemId], { fixed: true });
  };
  const far = zoom < FAR;
  const ctx: BoardCtx | null = doc ? { doc, texts, editing, setEditing, openCard, resized, far, mindAdd } : null;
  const cardsSelected = selectedItems.filter((i) => i.kind === "card");
  const fixedSelected = selectedItems.filter((i) => i.fixed && i.kind !== "section");
  const several = selectedItems.filter((i) => i.kind !== "section").length > 1;
  const menuItem = menu?.on === "node" ? items.find((i) => i.id === menu.id) : undefined;
  const menuEdge = menu?.on === "edge" ? edges.find((e) => e.id === menu.id) : undefined;
  const closeAnd = (f: () => void) => () => {
    setMenu(null);
    f();
  };

  return (
    <div
      className={`board${tool === "hand" ? " hand" : ""}`}
      ref={wrapper}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CARDS_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDrop}
    >
      {ctx && (
        <Ctx.Provider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) =>
              setSelectedEdges((prev) => {
                const next = new Set(prev);
                for (const c of changes) if (c.type === "select") c.selected ? next.add(c.id) : next.delete(c.id);
                return next;
              })
            }
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onNodesDelete={(ns) => removeItems(doc!, ns.map((n) => n.id))}
            onEdgesDelete={(es) => removeEdges(doc!, es.map((e) => e.id))}
            onPaneClick={() => {
              setEditing(null);
              setMenu(null);
            }}
            onNodeContextMenu={(e, n) => {
              if (!n.selected) setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
              contextMenu(e, { on: "node", id: n.id });
            }}
            onEdgeContextMenu={(e, ed) => contextMenu(e, { on: "edge", id: ed.id })}
            onPaneContextMenu={(e) => contextMenu(e, { on: "pane", at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) })}
            onDoubleClick={(e) => {
              // A new card where the canvas is double-clicked (Heptabase).
              if ((e.target as HTMLElement).classList.contains("react-flow__pane")) void newCard(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
            }}
            onMoveStart={() => setMenu(null)}
            onMoveEnd={(_, v) => void backend.setLocalSetting(VIEWPORT_SETTING(id), v).catch(() => {})}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={["Backspace", "Delete"]}
            panOnScroll
            selectionOnDrag={tool === "select" && !touch}
            panOnDrag={tool === "hand" || touch ? true : [1, 2]}
            zoomActivationKeyCode="Meta"
            zoomOnDoubleClick={false}
            elevateNodesOnSelect={false}
            multiSelectionKeyCode={["Meta", "Shift"]}
            minZoom={0.08}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            {minimap && <MiniMap pannable zoomable className="board-minimap" nodeStrokeWidth={2} maskColor="color-mix(in srgb, var(--ink) 8%, transparent)" />}
            {/* Not over one map text node: map rows sit close, and the bar would
                cover its neighbours (its colours are in the node's menu). */}
            {selectedIds.length > 0 && !editing && !dragging.current && !(selectedItems.length === 1 && selectedItems[0].kind === "mind") && (
              <NodeToolbar nodeId={selectedIds} isVisible position={Position.Top} offset={14}>
                <div className="board-selection" role="toolbar">
                  {COLORS.map((c) => (
                    <button key={c} className={`board-swatch color-${c}`} aria-label={t("board.color", { n: c })} onClick={() => setColor(doc!, selectedIds, c as BoardColor)} />
                  ))}
                  <button className="board-swatch none" aria-label={t("board.noColor")} onClick={() => setColor(doc!, selectedIds, null)} />
                  <span className="board-sep" />
                  {cardsSelected.length > 0 && (
                    <button
                      className="icon-button"
                      title={t(cardsSelected.every((c) => c.folded) ? "board.unfold" : "board.fold")}
                      aria-label={t(cardsSelected.every((c) => c.folded) ? "board.unfold" : "board.fold")}
                      onClick={() => setItemFlags(doc!, cardsSelected.map((c) => c.id), { folded: !cardsSelected.every((c) => c.folded) })}
                    >
                      {cardsSelected.every((c) => c.folded) ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    </button>
                  )}
                  {fixedSelected.length > 0 && (
                    <button className="icon-button" title={t("board.fit")} aria-label={t("board.fit")} onClick={() => setItemFlags(doc!, fixedSelected.map((i) => i.id), { fixed: false })}>
                      <Maximize2 size={14} />
                    </button>
                  )}
                  {several && (
                    <>
                      <button className="icon-button" title={t("board.tidy")} aria-label={t("board.tidy")} onClick={tidy}>
                        <Grid2x2 size={14} />
                      </button>
                      <Menu.Root>
                        <Menu.Trigger className="icon-button" title={t("board.align")} aria-label={t("board.align")}>
                          <AlignLeft size={14} />
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Positioner side="bottom" align="center" sideOffset={6}>
                            <Menu.Popup className="popup">
                              <Menu.Item className="popup-item" onClick={() => alignTo("left")}>
                                <AlignStartVertical size={14} /> {t("board.alignLeft")}
                              </Menu.Item>
                              <Menu.Item className="popup-item" onClick={() => alignTo("centerX")}>
                                <AlignHorizontalJustifyCenter size={14} /> {t("board.alignCenterX")}
                              </Menu.Item>
                              <Menu.Item className="popup-item" onClick={() => alignTo("top")}>
                                <AlignCenterVertical size={14} /> {t("board.alignTop")}
                              </Menu.Item>
                              <Menu.Item className="popup-item" onClick={() => alignTo("centerY")}>
                                <AlignCenterVertical size={14} /> {t("board.alignCenterY")}
                              </Menu.Item>
                            </Menu.Popup>
                          </Menu.Positioner>
                        </Menu.Portal>
                      </Menu.Root>
                    </>
                  )}
                  <button className="icon-button" title={`${t("board.groupSelected")} (⌘G)`} aria-label={t("board.groupSelected")} onClick={newSection}>
                    <Group size={14} />
                  </button>
                  <button className="icon-button" title={t("board.remove")} aria-label={t("board.remove")} onClick={removeSelected}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </NodeToolbar>
            )}
          </ReactFlow>

          <div className="board-top">
            <BoardTitle id={id} name={info.name} />
            <Menu.Root>
              <Menu.Trigger className="icon-button" title={t("board.menu")} aria-label={t("board.menu")}>
                <ChevronDown size={15} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="start" sideOffset={6}>
                  <Menu.Popup className="popup">
                    <Menu.Item className="popup-item" onClick={() => void exportCanvas()}>
                      <FileDown size={14} /> {t("board.export")}
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>

          <div className="board-toolbar" role="toolbar">
            <button className={`board-tool${tool === "select" ? " on" : ""}`} title={`${t("board.toolSelect")} (V)`} aria-label={t("board.toolSelect")} aria-pressed={tool === "select"} onClick={() => setTool("select")}>
              <MousePointer2 size={17} />
            </button>
            <button className={`board-tool${tool === "hand" ? " on" : ""}`} title={`${t("board.toolHand")} (H)`} aria-label={t("board.toolHand")} aria-pressed={tool === "hand"} onClick={() => setTool("hand")}>
              <Hand size={17} />
            </button>
            <span className="board-sep" />
            <button className="board-tool" title={`${t("board.newCard")} (N)`} aria-label={t("board.newCard")} onClick={() => void newCard()}>
              <SquarePlus size={17} />
            </button>
            <AddCard placed={placed} onPick={(cardId) => place([cardId], centre())} />
            <button className="board-tool" title={`${t("board.newText")} (T)`} aria-label={t("board.newText")} onClick={() => newText()}>
              <Type size={17} />
            </button>
            <button className="board-tool" title={`${t("board.newSection")} (⌘G)`} aria-label={t("board.newSection")} onClick={newSection}>
              <Group size={17} />
            </button>
            <button className="board-tool" title={`${t("board.newMind")} (M)`} aria-label={t("board.newMind")} onClick={() => newMind()}>
              <Network size={17} />
            </button>
          </div>

          <div className="board-zoom" role="group" aria-label={t("board.zoom")}>
            <button className="icon-button" aria-label={t("board.zoomOut")} title={t("board.zoomOut")} onClick={() => void flow.zoomOut({ duration: 150 })}>
              <Minus size={14} />
            </button>
            <button className="board-zoom-value" title={`${t("board.fitAll")} (⌘0)`} onClick={() => void flow.fitView({ padding: 0.2, duration: 200 })}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-button" aria-label={t("board.zoomIn")} title={t("board.zoomIn")} onClick={() => void flow.zoomIn({ duration: 150 })}>
              <Plus size={14} />
            </button>
            <span className="board-sep" />
            <button className="icon-button" aria-label={t("board.fitAll")} title={`${t("board.fitAll")} (⌘0)`} onClick={() => void flow.fitView({ padding: 0.2, duration: 250 })}>
              <Scan size={14} />
            </button>
            <button
              className={`icon-button board-minimap-toggle${minimap ? " on" : ""}`}
              aria-label={t("board.minimap")}
              title={t("board.minimap")}
              aria-pressed={minimap}
              onClick={() => {
                setMinimap(!minimap);
                void backend.setLocalSetting(MINIMAP_SETTING, !minimap).catch(() => {});
              }}
            >
              <MapIcon size={14} />
            </button>
          </div>

          {lost && (
            <button className="board-lost" onClick={() => void flow.fitView({ padding: 0.2, duration: 300 })}>
              <Scan size={14} />
              {t("board.backToContent")}
            </button>
          )}

          {menu && (
            <div ref={menuBox} className="popup board-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
              {menu.on === "pane" && (
                <>
                  <button className="popup-item" onClick={closeAnd(() => void newCard(menu.at))}>
                    <SquarePlus size={14} /> {t("board.newCard")}
                  </button>
                  <button className="popup-item" onClick={closeAnd(() => newText(menu.at))}>
                    <Type size={14} /> {t("board.newText")}
                  </button>
                  <button className="popup-item" onClick={closeAnd(() => newMind(menu.at))}>
                    <Network size={14} /> {t("board.newMind")}
                  </button>
                  {clipboard && (
                    <button className="popup-item" onClick={closeAnd(() => paste(menu.at))}>
                      {t("board.paste")}
                    </button>
                  )}
                  <button className="popup-item" onClick={closeAnd(() => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))))}>
                    {t("board.selectAll")}
                  </button>
                </>
              )}
              {menu.on === "node" && menuItem && (
                <>
                  {menuItem.kind === "card" && menuItem.cardId && (
                    <>
                      <button className="popup-item" onClick={closeAnd(() => openCard(menuItem.cardId!))}>
                        <ExternalLink size={14} /> {t("board.openCard")}
                      </button>
                      <button className="popup-item" onClick={closeAnd(() => setEditing(menuItem.id))}>
                        {t("board.edit")}
                      </button>
                      <button className="popup-item" onClick={closeAnd(() => setItemFlags(doc!, [menuItem.id], { folded: !menuItem.folded }))}>
                        {t(menuItem.folded ? "board.unfold" : "board.fold")}
                      </button>
                    </>
                  )}
                  {(menuItem.kind === "mind" || menuItem.kind === "card") && (
                    <>
                      <button className="popup-item" onClick={closeAnd(() => mindAdd(menuItem.id, "child"))}>
                        <Network size={14} /> {t(maps.members.has(menuItem.id) ? "board.mindChild" : "board.makeRoot")} <kbd>Tab</kbd>
                      </button>
                      {maps.members.has(menuItem.id) && !menuItem.root && (
                        <button className="popup-item" onClick={closeAnd(() => mindAdd(menuItem.id, "sibling"))}>
                          {t("board.mindSibling")} <kbd>↩</kbd>
                        </button>
                      )}
                      {!!maps.info.get(menuItem.id)?.kids && (
                        <button className="popup-item" onClick={closeAnd(() => setCollapsed(doc!, menuItem.id, !menuItem.collapsed))}>
                          {t(menuItem.collapsed ? "board.unfoldBranch" : "board.foldBranch")}
                        </button>
                      )}
                      {menuItem.kind === "mind" && (
                        <button className="popup-item" onClick={closeAnd(() => setEditing(menuItem.id))}>
                          {t("board.edit")}
                        </button>
                      )}
                      {menuItem.kind === "mind" && (
                        <button className="popup-item" onClick={closeAnd(() => void mindCard(menuItem.id))}>
                          <SquarePlus size={14} /> {t("board.toCard")}
                        </button>
                      )}
                      {maps.members.has(menuItem.id) && !menuItem.root && (
                        <button
                          className="popup-item"
                          onClick={closeAnd(() => {
                            const n = flow.getNode(menuItem.id);
                            detach(doc!, menuItem.id, { x: (n?.position.x ?? menuItem.x) + 60, y: (n?.position.y ?? menuItem.y) + 60 });
                          })}
                        >
                          <Unlink size={14} /> {t("board.detach")}
                        </button>
                      )}
                      <div className="popup-separator" />
                    </>
                  )}
                  {menuItem.fixed && menuItem.kind !== "section" && (
                    <button className="popup-item" onClick={closeAnd(() => setItemFlags(doc!, [menuItem.id], { fixed: false }))}>
                      {t("board.fit")}
                    </button>
                  )}
                  <div className="board-menu-row">
                    {COLORS.map((c) => (
                      <button key={c} className={`board-swatch color-${c}`} aria-label={t("board.color", { n: c })} onClick={closeAnd(() => setColor(doc!, selectedIds, c as BoardColor))} />
                    ))}
                    <button className="board-swatch none" aria-label={t("board.noColor")} onClick={closeAnd(() => setColor(doc!, selectedIds, null))} />
                  </div>
                  <div className="popup-separator" />
                  <button className="popup-item" onClick={closeAnd(copy)}>
                    {t("board.copy")} <kbd>⌘C</kbd>
                  </button>
                  <button className="popup-item" onClick={closeAnd(duplicate)}>
                    {t("board.duplicate")} <kbd>⌘D</kbd>
                  </button>
                  <div className="popup-separator" />
                  <button className="popup-item danger" onClick={closeAnd(removeSelected)}>
                    <Trash2 size={14} /> {t("board.remove")}
                  </button>
                </>
              )}
              {menu.on === "edge" && menuEdge && (
                <>
                  <button className="popup-item" onClick={closeAnd(() => setEditingEdge(menuEdge.id))}>
                    {t("board.editLabel")}
                  </button>
                  <div className="popup-label">{t("board.lineStyle")}</div>
                  <div className="board-menu-row">
                    {(["solid", "dashed"] as const).map((s) => (
                      <button key={s} className={`board-chip${menuEdge.style === s ? " on" : ""}`} onClick={closeAnd(() => setEdgeLook(doc!, menuEdge.id, { style: s }))}>
                        {t(`board.style.${s}`)}
                      </button>
                    ))}
                  </div>
                  <div className="popup-label">{t("board.arrows")}</div>
                  <div className="board-menu-row">
                    {(["end", "both", "none"] as const).map((a) => (
                      <button key={a} className={`board-chip${menuEdge.arrows === a ? " on" : ""}`} onClick={closeAnd(() => setEdgeLook(doc!, menuEdge.id, { arrows: a }))}>
                        {t(`board.arrow.${a}`)}
                      </button>
                    ))}
                  </div>
                  <div className="board-menu-row">
                    {COLORS.map((c) => (
                      <button key={c} className={`board-swatch color-${c}`} aria-label={t("board.color", { n: c })} onClick={closeAnd(() => setColor(doc!, [menuEdge.id], c as BoardColor))} />
                    ))}
                    <button className="board-swatch none" aria-label={t("board.noColor")} onClick={closeAnd(() => setColor(doc!, [menuEdge.id], null))} />
                  </div>
                  <div className="popup-separator" />
                  <button className="popup-item danger" onClick={closeAnd(() => removeEdges(doc!, [menuEdge.id]))}>
                    <Trash2 size={14} /> {t("board.removeLine")}
                  </button>
                </>
              )}
            </div>
          )}
        </Ctx.Provider>
      )}
    </div>
  );
}
