import { ArrowUp, BookPlus, CalendarPlus, Check, Copy, FileText, History, Pencil, Plus, Settings, Square, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import { cardName, openAt } from "../card/reveal";
import { readMeta } from "../docs/card";
import { chatDeleted, deleteChat, markUndone, readChats, readMessages, readUndone, type ChatInfo, type ChatMessage } from "../docs/chat";
import { workspaceDoc } from "../docs/topics";
import { backend } from "../platform";
import { usePhone } from "../shell/phone";
import { CHAT_COMBO, keyLabel } from "../shell/shortcuts";
import { focusedPane, toSide, useShell } from "../shell/tabs";
import { answerTitle, appendToJournal, saveAsCard } from "./actions";
import { allowAll, decide, messageText, newChat, openChat, send, stop, useChatLive, type ChatContext, type LiveTurn as LiveTurnState, type PendingWrite, type UserMessage } from "./chat";
import { parseMarkdown, renderBlocks, type Target } from "./markdown";
import { ModelPicker } from "./ModelPicker";
import { loadAiSettings, useAiSettings } from "./settings";
import type { AiPart, AiToolResult } from "./types";
import { ChangedSince, isWriteTool, undo as undoChange, type WriteRecord } from "./writes";

type ToolPart = Extract<AiPart, { type: "tool" }>;
import "./ai.css";

/** The conversation shown, remembered on this device. */
const CURRENT = "ai.chat";

/** The assistant's panel (design/ai.md): a conversation with the model
 *  about the notes, beside them; full screen on a phone. */
export function ChatPanel() {
  const open = useShell((s) => s.chatOpen);
  if (!open) return null;
  return <Panel />;
}

function useChats(): ChatInfo[] {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  useEffect(() => {
    let off = () => {};
    let gone = false;
    void workspaceDoc().then((h) => {
      if (gone) return;
      const read = () => setChats(readChats(h.doc));
      read();
      off = h.doc.subscribe(read);
    });
    return () => {
      gone = true;
      off();
    };
  }, []);
  return chats;
}

function useMessages(chatId: string | null): { messages: ChatMessage[]; undone: Set<string> } {
  const [state, setState] = useState<{ messages: ChatMessage[]; undone: Set<string> }>({ messages: [], undone: new Set() });
  useEffect(() => {
    setState({ messages: [], undone: new Set() });
    if (!chatId) return;
    let off = () => {};
    let gone = false;
    let held = false;
    void openChat(chatId).then((h) => {
      held = true;
      if (gone) return void docs().release(chatId);
      const read = () => setState({ messages: readMessages(h.doc), undone: readUndone(h.doc) });
      read();
      off = h.doc.subscribe(read);
    });
    return () => {
      gone = true;
      off();
      if (held) void docs().release(chatId);
    };
  }, [chatId]);
  return state;
}

/** The card in the focused pane, to talk about. */
function useFocusedCard(): ChatContext | null {
  const active = useShell((s) => focusedPane(s).active);
  const cardId = active.startsWith("card:") ? active.slice(5) : null;
  const [title, setTitle] = useState("");
  useEffect(() => {
    setTitle("");
    if (!cardId) return;
    let gone = false;
    backend.titles([cardId]).then((t) => !gone && setTitle(t[0]?.[1] ?? ""), () => {});
    return () => {
      gone = true;
    };
  }, [cardId]);
  return cardId ? { cardId, title: cardName(cardId, title) } : null;
}

function Panel() {
  const { t } = useTranslation();
  const phone = usePhone();
  const settings = useAiSettings();
  const chats = useChats();
  const [chatId, setChatId] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const { messages, undone } = useMessages(chatId);
  const live = useChatLive((s) => (chatId ? s.live[chatId] : undefined));
  const error = useChatLive((s) => (chatId ? s.errors[chatId] : undefined));
  const focused = useFocusedCard();
  const [withCard, setWithCard] = useState(true);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!settings.loaded) void loadAiSettings();
    void backend.getLocalSetting<string>(CURRENT).then((id) => id && setChatId((c) => c ?? id), () => {});
    // Not on a phone: the keyboard would cover half the screen at once.
    if (!phone) setTimeout(() => input.current?.focus());
  }, [settings.loaded]);

  // A conversation deleted (here or elsewhere) is not shown.
  useEffect(() => {
    if (chatId) void workspaceDoc().then((h) => chatDeleted(h.doc, chatId) && setChatId(null));
  }, [chats, chatId]);

  // A new card focused: it is offered again.
  useEffect(() => setWithCard(true), [focused?.cardId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live?.text, live?.tools.length, live?.pending?.length, error]);

  const choose = (id: string | null) => {
    setChatId(id);
    setListing(false);
    void backend.setLocalSetting(CURRENT, id);
    if (!phone) setTimeout(() => input.current?.focus());
  };

  const submit = async (text = draft) => {
    const body = text.trim();
    if (!body || live) return;
    setDraft("");
    const context = withCard && focused ? focused : null;
    const id = chatId ?? (await newChat(body));
    if (id !== chatId) choose(id);
    await send(id, body, context);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const current = chats.find((c) => c.id === chatId);
  const noProvider = settings.loaded && settings.providers.length === 0;
  const openSettings = () => useShell.getState().setDialog({ kind: "settings", section: "ai" });

  return (
    <aside className={`chat-panel${phone ? " phone" : ""}`} aria-label={t("ai.title")}>
      <header className="chat-head" data-tauri-drag-region>
        <button className="chat-title" onClick={() => setListing((l) => !l)} aria-expanded={listing} title={t("ai.history")}>
          <History size={14} strokeWidth={1.75} />
          <span>{listing ? t("ai.history") : (current?.title ?? t("ai.newChat"))}</span>
        </button>
        <span className="chat-head-actions">
          <button className="icon-button" title={t("ai.newChat")} aria-label={t("ai.newChat")} onClick={() => choose(null)}>
            <Plus size={15} strokeWidth={1.75} />
          </button>
          <button className="icon-button" title={`${t("ai.close")} (${keyLabel(CHAT_COMBO)})`} aria-label={t("ai.close")} onClick={() => useShell.getState().setChatOpen(false)}>
            <X size={15} strokeWidth={1.75} />
          </button>
        </span>
      </header>

      {listing ? (
        <ChatList chats={chats} current={chatId} onChoose={choose} />
      ) : (
        <>
          <div className="chat-scroll" ref={scroller}>
            {messages.length === 0 && !live && (
              <Welcome noProvider={noProvider} onSettings={openSettings} onPick={(text) => void submit(text)} hasCard={!!focused} />
            )}
            <Messages chatId={chatId} messages={messages} undone={undone} answering={!!live} pending={live?.pending} />
            {live && chatId && <LiveTurn chatId={chatId} live={live} />}
            {error && (
              <div className="chat-error" role="alert">
                <p>{error}</p>
                <button className="chat-link" onClick={openSettings}>
                  <Settings size={13} /> {t("ai.settings")}
                </button>
              </div>
            )}
          </div>
          <footer className="chat-compose">
            {focused && withCard && (
              <span className="chat-context" title={t("ai.contextHint")}>
                <FileText size={12} />
                <span>{focused.title}</span>
                <button aria-label={t("ai.contextRemove")} onClick={() => setWithCard(false)}>
                  <X size={11} />
                </button>
              </span>
            )}
            <textarea
              ref={input}
              value={draft}
              rows={1}
              placeholder={t("ai.placeholder")}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
              }}
              onKeyDown={onKey}
            />
            <div className="chat-compose-bar">
              {settings.providers.length > 0 ? (
                <ModelPicker onManage={openSettings} />
              ) : (
                <button className="chat-link" onClick={openSettings}>
                  {t("ai.addModel")}
                </button>
              )}
              {live ? (
                <button className="chat-send" aria-label={t("ai.stop")} title={t("ai.stop")} onClick={() => chatId && stop(chatId)}>
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button className="chat-send" aria-label={t("ai.send")} title={t("ai.send")} disabled={!draft.trim()} onClick={() => void submit()}>
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </aside>
  );
}

function Welcome({ noProvider, onSettings, onPick, hasCard }: { noProvider: boolean; onSettings: () => void; onPick: (text: string) => void; hasCard: boolean }) {
  const { t } = useTranslation();
  if (noProvider)
    return (
      <div className="chat-welcome">
        <p>{t("ai.setupHint")}</p>
        <button className="button primary" onClick={onSettings}>
          {t("ai.addModel")}
        </button>
      </div>
    );
  const ideas = [...(hasCard ? ["summarizeCard", "quizCard"] : []), "recent", "openTasks"];
  return (
    <div className="chat-welcome">
      <p>{t("ai.welcome")}</p>
      <div className="chat-ideas">
        {ideas.map((k) => (
          <button key={k} onClick={() => onPick(t(`ai.ideas.${k}`))}>
            {t(`ai.ideas.${k}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatList({ chats, current, onChoose }: { chats: ChatInfo[]; current: string | null; onChoose: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }), [i18n.language]);
  if (chats.length === 0) return <p className="chat-empty">{t("ai.noChats")}</p>;
  return (
    <ul className="chat-list">
      {chats.map((c) => (
        <li key={c.id} className={c.id === current ? "current" : undefined}>
          <button className="chat-list-open" onClick={() => onChoose(c.id)}>
            <span>{c.title || t("ai.newChat")}</span>
            <time>{fmt.format(c.updatedAt)}</time>
          </button>
          <button
            className="icon-button"
            aria-label={t("ai.delete")}
            title={t("ai.delete")}
            onClick={() => void workspaceDoc().then((h) => (deleteChat(h.doc, c.id), useShell.getState().setNotice(t("ai.deleted"))))}
          >
            <Trash2 size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Opens a card with its title, for its tab and the recent list (the
 *  link's words are the model's, not the title). */
async function openCard(cardId: string, bid: string | null, side = false) {
  let title = "";
  try {
    const h = await docs().open(cardId);
    title = readMeta(h.doc).title;
    void docs().release(cardId);
  } catch {
    // Opened as untitled; the card view reads it.
  }
  openAt(cardId, cardName(cardId, title), bid, side);
}

const onLink = (target: NonNullable<Target>, ev: React.MouseEvent) => {
  if (target.kind === "card") void openCard(target.cardId, target.bid, toSide(ev));
  else void backend.openLink(target.url);
};

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="chat-md">{renderBlocks(blocks, onLink)}</div>;
}

/** What a tool call did, in a few words. */
function ToolLine({ part, result }: { part: { name: string; input?: Record<string, unknown> }; result?: AiToolResult | "running" }) {
  const { t } = useTranslation();
  const input = part.input ?? {};
  const what = ["query", "title", "tag", "topic", "date", "id"].map((k) => input[k]).find((v) => typeof v === "string" && v) as string | undefined;
  const label = t(`ai.tools.${part.name}`, { defaultValue: part.name });
  return (
    <div className={`chat-tool${result && result !== "running" && result.isError ? " failed" : ""}`}>
      {result === "running" || !result ? <span className="chat-spinner" /> : <Check size={12} />}
      <span>{label}</span>
      {what && <span className="chat-tool-what">{what}</span>}
    </div>
  );
}

function Messages({ chatId, messages, undone, answering, pending }: { chatId: string | null; messages: ChatMessage[]; undone: Set<string>; answering: boolean; pending?: PendingWrite[] }) {
  // Proposed changes show as proposals, under the conversation.
  const proposed = new Set(pending?.map((p) => p.part.id));
  const results = new Map<string, AiToolResult>();
  const writes = new Map<string, WriteRecord>();
  for (const m of messages) {
    if (m.message.role !== "tools") continue;
    for (const r of m.message.results) results.set(r.id, r);
    for (const [id, w] of Object.entries(m.message.writes ?? {})) writes.set(id, w);
  }
  const out: ReactNode[] = [];
  messages.forEach((m, i) => {
    const msg = m.message;
    if (msg.role === "user") {
      const context = (msg as UserMessage).context;
      out.push(
        <div key={m.id || i} className="chat-msg user">
          {context && (
            <span className="chat-context quiet">
              <FileText size={11} />
              {context.title}
            </span>
          )}
          <div className="chat-bubble">{msg.text}</div>
        </div>,
      );
    } else if (msg.role === "assistant") {
      const tools = msg.parts.filter((p): p is Extract<AiPart, { type: "tool" }> => p.type === "tool");
      const text = messageText(m);
      // The actions go under the last text of the answer to one message.
      const next = messages.slice(i + 1).find((x) => x.message.role !== "tools");
      const lastOfAnswer = next ? next.message.role === "user" : !answering;
      out.push(
        <div key={m.id || i} className="chat-msg assistant">
          {text && <Markdown text={text} />}
          {tools.filter((p) => !proposed.has(p.id)).map((p) =>
            isWriteTool(p.name) && chatId ? (
              <WriteLine key={p.id} chatId={chatId} part={p} result={results.get(p.id)} record={writes.get(p.id)} undone={undone.has(p.id)} />
            ) : (
              <ToolLine key={p.id} part={p} result={results.get(p.id)} />
            ),
          )}
          {text && lastOfAnswer && <Actions messages={messages} upTo={i} />}
        </div>,
      );
    }
  });
  return <>{out}</>;
}

/** The answer's text: what the model wrote after its last tool calls (what
 *  it said before them, like "let me search", is left out). */
function answerText(messages: ChatMessage[], upTo: number): string {
  const parts: string[] = [];
  for (let i = upTo; i >= 0 && messages[i].message.role !== "user"; i--) {
    if (messages[i].message.role === "tools" && parts.length) break;
    const text = messageText(messages[i]);
    if (text.trim()) parts.unshift(text.trim());
  }
  return parts.join("\n\n");
}

function Actions({ messages, upTo }: { messages: ChatMessage[]; upTo: number }) {
  const { t } = useTranslation();
  const [done, setDone] = useState<string | null>(null);
  const text = answerText(messages, upTo);
  const notice = (s: string) => useShell.getState().setNotice(s);
  const act = async (key: string, f: () => Promise<unknown>) => {
    try {
      await f();
      setDone(key);
      setTimeout(() => setDone(null), 1500);
    } catch (e) {
      notice(t("ai.errors.other", { message: String(e) }));
    }
  };
  return (
    <div className="chat-actions">
      <button title={t("ai.copy")} aria-label={t("ai.copy")} onClick={() => void act("copy", () => navigator.clipboard.writeText(text))}>
        {done === "copy" ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        title={t("ai.saveCard")}
        aria-label={t("ai.saveCard")}
        onClick={() =>
          void act("card", async () => {
            const id = await saveAsCard(text, answerTitle(text, t("ai.answer")));
            notice(t("ai.savedCard"));
            await openCard(id, null);
          })
        }
      >
        {done === "card" ? <Check size={13} /> : <BookPlus size={13} />}
      </button>
      <button title={t("ai.toJournal")} aria-label={t("ai.toJournal")} onClick={() => void act("journal", async () => (await appendToJournal(text), notice(t("ai.addedJournal"))))}>
        {done === "journal" ? <Check size={13} /> : <CalendarPlus size={13} />}
      </button>
    </div>
  );
}

function LiveTurn({ chatId, live }: { chatId: string; live: LiveTurnState }) {
  const { text, tools, pending } = live;
  return (
    <div className="chat-msg assistant live">
      {text ? <Markdown text={text} /> : tools.length === 0 && !pending && <span className="chat-dots" aria-label="…" />}
      {!pending && tools.map((p) => <ToolLine key={p.id} part={p} result="running" />)}
      {pending && <Proposals chatId={chatId} pending={pending} />}
    </div>
  );
}

/** Changes the assistant wants to make, for the user to allow or decline. */
function Proposals({ chatId, pending }: { chatId: string; pending: PendingWrite[] }) {
  const { t } = useTranslation();
  const open = pending.filter((p) => p.allowed === undefined).length;
  return (
    <div className="chat-proposals">
      {pending.map((p) => (
        <ProposalView key={p.part.id} chatId={chatId} pending={p} />
      ))}
      {open > 0 && (
        <div className="chat-proposals-all">
          {open > 1 && (
            <button className="button" onClick={() => allowAll(chatId)}>
              {t("ai.write.allowAll")}
            </button>
          )}
          <button className="chat-link" onClick={() => allowAll(chatId, true)}>
            {t("ai.write.allowChat")}
          </button>
        </div>
      )}
    </div>
  );
}

function ProposalView({ chatId, pending }: { chatId: string; pending: PendingWrite }) {
  const { t } = useTranslation();
  const { part, proposal: p, allowed } = pending;
  return (
    <div className="chat-proposal">
      <div className="chat-proposal-head">
        <Pencil size={12} />
        <span>{t(`ai.writes.${part.name}`)}</span>
        <b>{p.target}</b>
      </div>
      <div className="chat-proposal-body">
        {p.content !== undefined && <Markdown text={p.content} />}
        {part.name === "update_block" && (
          <>
            <p className="chat-before">{p.before}</p>
            <Markdown text={p.after ?? ""} />
          </>
        )}
        {part.name === "rename_card" && (
          <p>
            <span className="chat-before">{p.before}</span> → {p.after}
          </p>
        )}
        {p.topic !== undefined && <p>{t(p.add ? "ai.write.topicAdd" : "ai.write.topicRemove", { topic: p.topic })}</p>}
      </div>
      <div className="chat-proposal-actions">
        {allowed === undefined ? (
          <>
            <button className="button" onClick={() => decide(chatId, part.id, false)}>
              {t("ai.write.decline")}
            </button>
            <button className="button primary" onClick={() => decide(chatId, part.id, true)}>
              {t("ai.write.allow")}
            </button>
          </>
        ) : (
          <span className="chat-proposal-status">{t(allowed ? "ai.write.allowed" : "ai.write.declined")}</span>
        )}
      </div>
    </div>
  );
}

/** A change the assistant made (or was not let make), with a way back. */
function WriteLine({ chatId, part, result, record, undone }: { chatId: string; part: ToolPart; result?: AiToolResult; record?: WriteRecord; undone: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const notice = (s: string) => useShell.getState().setNotice(s);
  const status = !result ? "running" : record?.status === "done" ? (undone ? "undone" : "done") : record?.status === "declined" ? "declined" : "failed";
  const title = typeof part.input?.title === "string" ? part.input.title : "";
  const target = record?.target ?? title;
  const canOpen = record?.cardId && status === "done";
  const revert = async () => {
    if (!record?.change || busy) return;
    setBusy(true);
    try {
      await undoChange(record.change);
      const h = await openChat(chatId);
      markUndone(h.doc, part.id);
      void docs().release(chatId);
    } catch (e) {
      notice(e instanceof ChangedSince ? t("ai.write.changedSince") : t("ai.write.undoFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`chat-tool chat-write ${status}`} title={status === "failed" ? result?.content : undefined}>
      {status === "running" ? <span className="chat-spinner" /> : status === "done" ? <Check size={12} /> : <Pencil size={12} />}
      <span>{t(`ai.writes.${part.name}`)}</span>
      {target &&
        (canOpen ? (
          <button className="chat-tool-what chat-write-target" onClick={(e) => void openCard(record.cardId!, null, toSide(e))}>
            {target}
          </button>
        ) : (
          <span className="chat-tool-what">{target}</span>
        ))}
      {status !== "running" && status !== "done" && <span className="chat-write-status">{t(`ai.write.${status}`)}</span>}
      {status === "done" && record?.change && (
        <button className="chat-write-undo" disabled={busy} onClick={() => void revert()}>
          <Undo2 size={11} /> {t("ai.write.undo")}
        </button>
      )}
    </div>
  );
}
