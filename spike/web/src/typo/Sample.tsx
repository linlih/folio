// Preview content for the typography lab: a slice of the real app window
// (sidebar, tabs, journal, card, context panel) plus typesetting stress cases.
import type { ComponentType } from "react";
import * as L from "lucide-react";
import * as P from "@phosphor-icons/react";
import * as T from "@tabler/icons-react";
import type { IconSet } from "./tokens";

type IconName = "search" | "journal" | "cards" | "board" | "tag" | "pin" | "trash" | "settings" | "plus" | "panel";

type AnyIcon = ComponentType<Record<string, unknown>>;

const ICONS: Record<IconSet, Record<IconName, AnyIcon>> = {
  lucide: {
    search: L.Search, journal: L.CalendarDays, cards: L.StickyNote, board: L.LayoutDashboard, tag: L.Hash,
    pin: L.Pin, trash: L.Trash2, settings: L.Settings, plus: L.Plus, panel: L.PanelRight,
  } as Record<IconName, AnyIcon>,
  phosphor: {
    search: P.MagnifyingGlass, journal: P.CalendarBlank, cards: P.Note, board: P.SquaresFour, tag: P.Hash,
    pin: P.PushPin, trash: P.Trash, settings: P.Gear, plus: P.Plus, panel: P.SidebarSimple,
  } as Record<IconName, AnyIcon>,
  tabler: {
    search: T.IconSearch, journal: T.IconCalendar, cards: T.IconNotes, board: T.IconLayoutBoard, tag: T.IconHash,
    pin: T.IconPin, trash: T.IconTrash, settings: T.IconSettings, plus: T.IconPlus, panel: T.IconLayoutSidebarRight,
  } as Record<IconName, AnyIcon>,
};

export function Icon({ set, name, stroke }: { set: IconSet; name: IconName; stroke: number }) {
  const C = ICONS[set][name];
  // Phosphor has weights instead of a stroke width; "light" is its thin, quiet style.
  // Lucide takes `strokeWidth`; Tabler's `stroke` prop is its stroke width.
  const props =
    set === "phosphor" ? { size: 16, weight: "light" } : set === "lucide" ? { size: 16, strokeWidth: stroke } : { size: 16, stroke };
  return <C aria-hidden="true" {...props} />;
}

export function Sample({ icons, stroke }: { icons: IconSet; stroke: number }) {
  const I = (name: IconName) => <Icon set={icons} name={name} stroke={stroke} />;
  return (
    <div className="tl-window">
      <aside className="tl-sidebar">
        <div className="tl-search">{I("search")}<span>Search</span><kbd>⌘K</kbd></div>
        <div className="tl-nav">{I("plus")}<span>New card</span></div>
        <div className="tl-gap" />
        <div className="tl-nav tl-active">{I("journal")}<span>Journal</span></div>
        <div className="tl-nav">{I("cards")}<span>Cards</span></div>
        <div className="tl-nav">{I("board")}<span>Boards</span></div>
        <div className="tl-section">Pinned</div>
        <div className="tl-nav">{I("pin")}<span>Folio architecture</span></div>
        <div className="tl-nav">{I("pin")}<span>阅读清单</span></div>
        <div className="tl-section">Tags</div>
        <div className="tl-nav">{I("tag")}<span>method</span></div>
        <div className="tl-nav">{I("tag")}<span>设计</span></div>
        <div className="tl-section">Recent</div>
        <div className="tl-nav tl-plain">卡片要独立可读</div>
        <div className="tl-nav tl-plain">Thinking, Fast and Slow</div>
        <div className="tl-spacer" />
        <div className="tl-nav tl-dim">{I("trash")}<span>Trash</span></div>
        <div className="tl-nav tl-dim">{I("settings")}<span>Settings</span></div>
      </aside>

      <div className="tl-main">
        <div className="tl-tabs">
          <span>Journal</span>
          <span className="tl-tab-on">卡片要独立可读</span>
          <span>Thinking, Fast and Slow</span>
          <span className="tl-tabs-end">{I("panel")}</span>
        </div>

        {/* Editable so you can paste your own notes and try your input method. */}
        <div className="tl-doc" contentEditable suppressContentEditableWarning spellCheck={false}>
          <section className="tl-journal" lang="zh-CN">
            <h2 className="tl-date">10 月 23 日 星期四</h2>
            <ul>
              <li>完成了 CRDT 方案评审，结论见 <a>CRDT 选型</a>，选定 Loro。</li>
              <li>
                预研数据
                <ul>
                  <li>一年期卡片：完整快照 2.2 MB，压缩后 61 KB，WKWebView 打开约 20ms。</li>
                  <li lang="en">Remote updates are 3–5× slower than Yjs on desktop.</li>
                </ul>
              </li>
              <li className="tl-task">☐ 起草界面原则 <span className="tl-tag">#设计</span></li>
              <li className="tl-task tl-done">☑ 调研纸面风格的配色与字体 <span className="tl-tag">#design</span></li>
              <li>读了 Heptabase 的白板交互，记在 <a>阅读清单</a> 里。</li>
            </ul>
          </section>

          <article className="tl-card" lang="zh-CN">
            <h1>卡片要独立可读</h1>
            <p className="tl-meta">10 月 23 日 · 来自日记 · 3 个反向链接</p>
            <p>
              白板上的卡片会脱离原来的上下文，所以每一张都要能单独读懂：先写结论，再写理由。这和“卡片盒笔记法”（Zettelkasten）的原子化原则一致——一张卡片只表达一个想法。
            </p>
            <h3>为什么</h3>
            <ul>
              <li>同一张卡片会出现在多块白板上，读者每次看到它时的上下文都不同。</li>
              <li>块引用指向的是具体段落，被引用的段落最好也能独立成立。</li>
            </ul>
            <blockquote>
              <p>“写作不是记录已经想好的东西，而是思考本身。”——这句话常被归到卢曼名下。</p>
            </blockquote>
            <p>
              我们用Tauri 2和Loro 1.16做了预研，打开一年期的卡片只要20ms，比Yjs快6.5倍。<span className="tl-hint">（这句故意不加空格，用来看“中西文自动间距”）</span>
            </p>
            <p>
              我们用 Tauri 2 和 Loro 1.16 做了预研，打开一年期的卡片只要 20 ms。<span className="tl-hint">（手动加空格的对照）</span>
            </p>
            <pre><code>{`// 块 id 规范化：首个出现者保留，其余改为 id~n
const id = bid ? repairedId(bid, all) : newBid();`}</code></pre>
          </article>

          <article className="tl-card" lang="en">
            <h1>Thinking, Fast and Slow</h1>
            <p className="tl-meta">Oct 21 · Reading notes · #book</p>
            <p>
              The mind runs on two systems. System 1 is fast, automatic and intuitive; System 2 is slow, effortful and deliberate. Most of the time we live in System 1 and only call on System 2 when something surprises us — which is characteristically rare, and internationalization of this insight is left as an exercise.
            </p>
            <h3>Anchoring</h3>
            <p>
              People are swayed by the first number they see, even when it is “obviously” irrelevant. Typographic details matter here too: curly quotes, en dashes (2020–2026) and em dashes — all of them.
            </p>
          </article>

          <section className="tl-stress">
            <h3 lang="zh-CN">排版难点</h3>
            <p lang="zh-CN">连续标点：他说：“你好！”（然后）——停顿……再说：「好的。」？！</p>
            <p lang="zh-CN">「行首的引号」和行尾的句号。窄栏里观察标点挤压、避头尾和标点悬挂：这一行会被故意写得很长，好让句号、逗号和右括号落到行尾，看看它们是否被正确处理（尤其是这里）。</p>
            <p lang="ja">日本語：文章を自然な位置で改行できるかどうかを確認します。句読点「、」と「。」の扱いにも注目してください。</p>
            <p lang="en">Long words: internationalization, counterrevolutionaries, incomprehensibilities — watch the hyphenation.</p>
          </section>
        </div>
      </div>

      <aside className="tl-panel">
        <div className="tl-panel-title">Outline</div>
        <div className="tl-panel-item">为什么</div>
        <div className="tl-panel-title">Linked references · 3</div>
        <div className="tl-panel-item">10 月 23 日 · 日记</div>
        <div className="tl-panel-item">白板设计原则</div>
        <div className="tl-panel-item">Project Folio</div>
        <div className="tl-panel-title">On boards · 1</div>
        <div className="tl-panel-item">{I("board")} Folio architecture</div>
      </aside>
    </div>
  );
}
