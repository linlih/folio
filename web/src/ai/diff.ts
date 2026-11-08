// What changed between two texts, for showing the assistant's edits in the
// card (ai/review.ts): Chinese, Japanese and Korean by character, other
// scripts by word. Short shared stretches between two changes are folded
// into them, so a rewrite reads as a few whole phrases rather than a
// scatter of single characters.

import type { Inline } from "./markdown";

export type DiffOp = { t: "=" | "-" | "+"; s: string };

const TOKEN = /[぀-ヿ㐀-鿿가-힯豈-﫿　-〿＀-￯]|[\p{L}\p{N}_]+|\s+|./gsu;

const tokens = (s: string) => s.match(TOKEN) ?? [];

/** The longest common subsequence's table is n×m: past this many tokens a
 *  side, the whole text counts as replaced (a rewrite of a long block). */
const MAX_TOKENS = 1500;

export function diffText(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ t: "=", s: before }] : [];
  const x = tokens(before);
  const y = tokens(after);
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return [...(before ? [{ t: "-" as const, s: before }] : []), ...(after ? [{ t: "+" as const, s: after }] : [])];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const raw: DiffOp[] = [];
  const push = (t: DiffOp["t"], s: string) => {
    const last = raw[raw.length - 1];
    if (last && last.t === t) last.s += s;
    else raw.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("=", x[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) push("-", x[i++]);
    else push("+", y[j++]);
  }
  while (i < n) push("-", x[i++]);
  while (j < m) push("+", y[j++]);
  // A shared stretch of one or two characters between changes joins them.
  const folded: DiffOp[] = [];
  raw.forEach((o, k) => {
    if (o.t === "=" && [...o.s].length <= 2 && k > 0 && k < raw.length - 1) folded.push({ t: "-", s: o.s }, { t: "+", s: o.s });
    else folded.push(o);
  });
  // Within each changed stretch, what goes before what comes.
  const out: DiffOp[] = [];
  let del = "";
  let ins = "";
  const flush = () => {
    if (del) out.push({ t: "-", s: del });
    if (ins) out.push({ t: "+", s: ins });
    del = ins = "";
  };
  for (const o of folded) {
    if (o.t === "-") del += o.s;
    else if (o.t === "+") ins += o.s;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.t === "=") last.s += o.s;
      else out.push({ ...o });
    }
  }
  flush();
  return out;
}

/** Less than a third of the text is kept: a rewrite rather than an edit. */
export function mostlyRewritten(ops: DiffOp[]): boolean {
  let kept = 0;
  let before = 0;
  let after = 0;
  for (const o of ops) {
    const n = [...o.s].length;
    if (o.t !== "+") before += n;
    if (o.t !== "-") after += n;
    if (o.t === "=") kept += n;
  }
  return kept * 3 < Math.max(before, after);
}

/** Inline Markdown's text, as it reads once written. */
export function inlineText(c: Inline[]): string {
  return c.map((n) => (n.t === "text" || n.t === "code" ? n.v : inlineText(n.c))).join("");
}
