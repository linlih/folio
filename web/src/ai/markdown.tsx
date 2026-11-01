// The assistant's Markdown, shown safely: parsed here into a small tree and
// drawn as React elements (never as HTML from the model), or written as
// HTML with every piece of text escaped, for saving into a card. Covers
// what models write: headings, paragraphs, nested lists, task boxes, code,
// quotes, tables, rules; bold, italic, strikethrough, code and links.

import type { ReactNode } from "react";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: { task: null | boolean; blocks: Block[] }[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => parseInline(c.trim()));

export function parseMarkdown(text: string): Block[] {
  return parseLines(text.replace(/\r\n/g, "\n").split("\n"));
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const body = line.trim();
    if (!body) {
      i++;
      continue;
    }
    const fence = body.match(/^(```+|~~~+)\s*(\S*)/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2], v: code.join("\n") });
      continue;
    }
    const h = body.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      out.push({ t: "h", level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(body)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (body.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(body);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows });
      continue;
    }
    if (body.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quoted.push(lines[i++].trim().replace(/^>\s?/, ""));
      out.push({ t: "quote", blocks: parseLines(quoted) });
      continue;
    }
    if (LIST.test(line)) {
      const [block, next] = parseList(lines, i);
      out.push(block);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6}\s|```|~~~|>)/.test(lines[i].trim())) para.push(lines[i++].trim());
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/** A list from `start`: its items, each with the lines under it (deeper
 *  items, continued text) parsed again. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start].match(LIST)!;
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items: { task: null | boolean; blocks: Block[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || indentOf(lines[i]) !== base) break;
    let text = m[3];
    let task: null | boolean = null;
    const box = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (box) {
      task = box[1] !== " ";
      text = box[2];
    }
    const own = [text];
    i++;
    // Lines under the item: deeper, or a blank line followed by deeper ones.
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) {
          own.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) <= base) break;
      own.push(l.slice(Math.min(indentOf(l), base + 2)).replace(/^\s{0,2}/, ""));
      i++;
    }
    const sub = own.slice(1);
    const blocks: Block[] = [{ t: "p", c: parseInline(own[0]) }, ...parseLines(sub.map((l) => l))];
    items.push({ task, blocks });
    while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && indentOf(lines[i + 1]) === base) i++;
  }
  return [{ t: "list", ordered, items }, i];
}

/** Inline marks, the first that starts earliest winning. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const RULES: [RegExp, (m: RegExpExecArray) => Inline][] = [
    [/`([^`]+)`/, (m) => ({ t: "code", v: m[1] })],
    [/\[([^\]]+)\]\(([^)\s]+)\)/, (m) => ({ t: "link", href: m[2], c: parseInline(m[1]) })],
    [/\*\*(.+?)\*\*|__(.+?)__/, (m) => ({ t: "strong", c: parseInline(m[1] ?? m[2]) })],
    [/~~(.+?)~~/, (m) => ({ t: "del", c: parseInline(m[1]) })],
    [/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/, (m) => ({ t: "em", c: parseInline(m[1] ?? m[2]) })],
    [/https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）]/, (m) => ({ t: "link", href: m[0], c: [{ t: "text", v: m[0] }] })],
  ];
  let rest = text;
  while (rest) {
    let best: { at: number; len: number; node: Inline } | null = null;
    for (const [re, make] of RULES) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.at)) best = { at: m.index, len: m[0].length, node: make(m) };
    }
    if (!best) {
      out.push({ t: "text", v: rest });
      break;
    }
    if (best.at > 0) out.push({ t: "text", v: rest.slice(0, best.at) });
    out.push(best.node);
    rest = rest.slice(best.at + best.len);
  }
  return out;
}

/** A link the assistant may make: into the notes, or to the web. */
export type Target = { kind: "card"; cardId: string; bid: string | null } | { kind: "web"; url: string } | null;

export function linkTarget(href: string): Target {
  const block = href.match(/^folio:block\/([^/\s]+)\/([^/\s]+)$/);
  if (block) return { kind: "card", cardId: decodeURIComponent(block[1]), bid: decodeURIComponent(block[2]) };
  const card = href.match(/^folio:card\/([^/\s]+)$/);
  if (card) return { kind: "card", cardId: decodeURIComponent(card[1]), bid: null };
  if (/^https?:\/\//i.test(href)) return { kind: "web", url: href };
  return null;
}

// ---- React ----

export function renderBlocks(blocks: Block[], onLink: (t: NonNullable<Target>, ev: React.MouseEvent) => void): ReactNode {
  const inl = (c: Inline[]): ReactNode =>
    c.map((n, i) => {
      switch (n.t) {
        case "text":
          return n.v.split("\n").flatMap((s, j) => (j ? [<br key={`${i}-${j}`} />, s] : [s]));
        case "code":
          return <code key={i}>{n.v}</code>;
        case "strong":
          return <strong key={i}>{inl(n.c)}</strong>;
        case "em":
          return <em key={i}>{inl(n.c)}</em>;
        case "del":
          return <del key={i}>{inl(n.c)}</del>;
        case "link": {
          const target = linkTarget(n.href);
          if (!target) return <span key={i}>{inl(n.c)}</span>;
          return (
            <a
              key={i}
              href={target.kind === "web" ? target.url : "#"}
              className={target.kind === "card" ? "chat-ref" : undefined}
              onClick={(ev) => {
                ev.preventDefault();
                onLink(target, ev);
              }}
            >
              {inl(n.c)}
            </a>
          );
        }
      }
    });
  const blk = (b: Block, i: number): ReactNode => {
    switch (b.t) {
      case "h": {
        const H = `h${Math.min(6, b.level + 2)}` as "h3";
        return <H key={i}>{inl(b.c)}</H>;
      }
      case "p":
        return <p key={i}>{inl(b.c)}</p>;
      case "code":
        return (
          <pre key={i}>
            <code>{b.v}</code>
          </pre>
        );
      case "quote":
        return <blockquote key={i}>{b.blocks.map(blk)}</blockquote>;
      case "hr":
        return <hr key={i} />;
      case "table":
        return (
          <div className="chat-table" key={i}>
            <table>
              <thead>
                <tr>{b.head.map((c, j) => <th key={j}>{inl(c)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{r.map((c, k) => <td key={k}>{inl(c)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j} className={it.task === null ? undefined : "task"}>
                {it.task !== null && <input type="checkbox" checked={it.task} disabled readOnly />}
                {it.blocks.map(blk)}
              </li>
            ))}
          </L>
        );
      }
    }
  };
  return blocks.map(blk);
}

// ---- HTML, for the editor ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML the editor reads as a card's content: links into the notes become
 *  card links and block references, as if typed. */
export function toHtml(blocks: Block[]): string {
  const inl = (c: Inline[]): string =>
    c
      .map((n) => {
        switch (n.t) {
          case "text":
            return esc(n.v).replace(/\n/g, "<br>");
          case "code":
            return `<code>${esc(n.v)}</code>`;
          case "strong":
            return `<strong>${inl(n.c)}</strong>`;
          case "em":
            return `<em>${inl(n.c)}</em>`;
          case "del":
            return `<s>${inl(n.c)}</s>`;
          case "link": {
            const t = linkTarget(n.href);
            if (t?.kind === "web") return `<a href="${esc(t.url)}">${inl(n.c)}</a>`;
            if (t?.kind === "card" && t.bid) return `<span data-ref="${esc(t.bid)}" data-card-hint="${esc(t.cardId)}"></span>`;
            if (t?.kind === "card") return `<span data-card-id="${esc(t.cardId)}">${esc(plain(n.c))}</span>`;
            return inl(n.c);
          }
        }
      })
      .join("");
  const blk = (b: Block): string => {
    switch (b.t) {
      case "h":
        return `<h${Math.min(3, b.level)}>${inl(b.c)}</h${Math.min(3, b.level)}>`;
      case "p":
        return `<p>${inl(b.c)}</p>`;
      case "code":
        return `<pre><code>${esc(b.v)}</code></pre>`;
      case "quote":
        return `<blockquote>${b.blocks.map(blk).join("")}</blockquote>`;
      case "hr":
        return "";
      case "table":
        return `<table><tr>${b.head.map((c) => `<th><p>${inl(c)}</p></th>`).join("")}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td><p>${inl(c)}</p></td>`).join("")}</tr>`).join("")}</table>`;
      case "list": {
        if (b.items.some((it) => it.task !== null))
          return `<ul data-type="taskList">${b.items.map((it) => `<li data-type="taskItem" data-checked="${it.task ? "true" : "false"}">${it.blocks.map(blk).join("")}</li>`).join("")}</ul>`;
        const L = b.ordered ? "ol" : "ul";
        return `<${L}>${b.items.map((it) => `<li>${it.blocks.map(blk).join("")}</li>`).join("")}</${L}>`;
      }
    }
  };
  return blocks.map(blk).join("");
}

/** The text of inline content, marks dropped. */
export function plain(c: Inline[]): string {
  return c.map((n) => (n.t === "text" || n.t === "code" ? n.v : plain(n.c))).join("");
}
