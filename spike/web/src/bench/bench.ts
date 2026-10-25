// Criteria 3 (performance) and 4 (storage growth). Runs in jsdom for quick
// numbers and in real WebViews through the bench page (src/main.tsx).
import { TextSelection } from "@tiptap/pm/state";
import type { Engine } from "../engines/types";
import { createReplica, tick } from "../harness/runner";
import { seeded } from "../harness/ops";

export function stats(xs: number[]) {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (x: number) => +x.toFixed(3);
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** ~5,000 Chinese/English characters across paragraphs, headings and lists. */
export function largeCardHtml(chars = 5000): string {
  const rng = seeded(42);
  const words = ["卡片笔记", "白板", "知识管理", "同步", "CRDT", "note", "Tauri", "双向链接", "日记", "块引用"];
  const para = (n: number) => {
    let s = "";
    while (s.length < n) s += words[Math.floor(rng() * words.length)] + (rng() < 0.2 ? "，" : "");
    return s;
  };
  let html = "";
  let total = 0;
  let i = 0;
  while (total < chars) {
    const kind = i % 7;
    const t = para(80 + Math.floor(rng() * 60));
    total += t.length;
    if (kind === 0) html += `<h2>${t.slice(0, 20)}</h2>`;
    else if (kind === 3) html += `<ul><li><p>${t}</p><ul><li><p>${t.slice(0, 40)}</p></li></ul></li></ul>`;
    else html += `<p>${t}</p>`;
    i++;
  }
  return html;
}

export async function buildCardSnapshot(engine: Engine, html = largeCardHtml()): Promise<{ snapshot: Uint8Array; chars: number }> {
  const r = await createReplica(engine);
  r.editor.commands.setContent(html);
  await tick();
  const snapshot = r.peer.snapshot();
  const chars = r.editor.state.doc.textContent.length;
  r.editor.destroy();
  return { snapshot, chars };
}

/** Time from bytes to an editor showing the content. */
export async function benchOpen(engine: Engine, snapshot: Uint8Array, runs = 20, element?: () => HTMLElement) {
  const ms: number[] = [];
  const decodeMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const el = element?.();
    const t0 = performance.now();
    const peer = engine.loadPeer(snapshot);
    const t1 = performance.now();
    const r = await createReplica(engine, peer, el);
    // Loro fills the editor one macrotask after mount; wait until content is there.
    while (r.editor.state.doc.childCount < 2) await tick();
    ms.push(performance.now() - t0);
    decodeMs.push(t1 - t0);
    r.editor.destroy();
    el?.remove();
  }
  return { open: stats(ms), decodeOnly: stats(decodeMs) };
}

/**
 * Per-keystroke cost: one insertText transaction dispatched through the
 * editor, which includes the binding writing the change into the CRDT.
 * Also times applying one remote keystroke to an open editor.
 */
export async function benchKeystrokes(engine: Engine, snapshot: Uint8Array, keys = 500, element?: HTMLElement) {
  const local = await createReplica(engine, engine.loadPeer(snapshot), element);
  const remote = await createReplica(engine, engine.loadPeer(snapshot));
  while (local.editor.state.doc.childCount < 2 || remote.editor.state.doc.childCount < 2) await tick();
  const updates: Uint8Array[] = [];
  const off = remote.peer.onLocalUpdate((u) => updates.push(u.slice()));
  const rng = seeded(7);
  const localMs: number[] = [];
  const remoteMs: number[] = [];
  const blocks: number[] = [];
  local.editor.state.doc.descendants((n, pos) => {
    if (n.isTextblock && n.content.size > 0) blocks.push(pos + n.content.size + 1);
    return true;
  });
  for (let i = 0; i < keys; i++) {
    // Type at the end of a random block, like continuing a sentence.
    const target = blocks[Math.floor(rng() * blocks.length)] + Math.floor(i / blocks.length);
    const view = local.editor.view;
    const pos = Math.min(target, view.state.doc.content.size - 1);
    const $pos = view.state.doc.resolve(pos);
    const at = $pos.parent.isTextblock ? pos : TextSelection.near($pos).from;
    const t0 = performance.now();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).insertText("字"));
    localMs.push(performance.now() - t0);

    // Remote side: a keystroke from another device arriving.
    remote.editor.commands.setTextSelection(Math.min(at, remote.editor.state.doc.content.size - 1));
    remote.editor.commands.insertContent("远");
    const u = updates.pop();
    if (u) {
      const t1 = performance.now();
      local.peer.importUpdate(u);
      remoteMs.push(performance.now() - t1);
    }
    if (i % 50 === 0) await tick();
  }
  off();
  local.editor.destroy();
  remote.editor.destroy();
  return { localKeystroke: stats(localMs), remoteKeystroke: stats(remoteMs) };
}

/**
 * One card edited for a "year": `days` sessions of `opsPerDay` keystroke-level
 * transactions (typing, deleting, new paragraphs). Every update is kept as
 * the store's update log; we report raw log size, full-history snapshot,
 * compacted state and load times.
 */
export async function benchGrowth(engine: Engine, days = 365, opsPerDay = 550, onProgress?: (msg: string) => void) {
  const r = await createReplica(engine);
  r.editor.commands.setContent("<h1>一年的卡片</h1><p>开始</p>");
  await tick();
  r.peer.clearHistory();
  const rng = seeded(2026);
  let logBytes = 0;
  let updates = 0;
  r.peer.onLocalUpdate((u) => {
    logBytes += u.byteLength;
    updates++;
  });
  const t0 = performance.now();
  let ops = 0;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < opsPerDay; k++) {
      const view = r.editor.view;
      const size = view.state.doc.content.size;
      const roll = rng();
      // A card that keeps being rewritten: it grows to ~8,000 characters,
      // then typing and deleting balance out (1.5% of ops start a new paragraph).
      // content.size is O(1) and tracks text length closely enough here.
      const typeShare = size < 9000 ? 0.6 : 0.3;
      if (roll < typeShare) {
        // type a character near the end (most writing appends)
        const pos = Math.max(1, size - 1 - Math.floor(rng() * Math.min(size - 2, 200)));
        const sel = TextSelection.near(view.state.doc.resolve(pos));
        view.dispatch(view.state.tr.setSelection(sel).insertText(rng() < 0.5 ? "字" : "a"));
      } else if (roll < 0.985) {
        // delete a character anywhere (editing old text)
        // Backspace anywhere: inside text it deletes a character, at the start
        // of a block it joins the block with the previous one.
        const pos = 2 + Math.floor(rng() * Math.max(1, size - 4));
        const $p = view.state.doc.resolve(pos);
        if ($p.parent.isTextblock && $p.parentOffset > 0) view.dispatch(view.state.tr.delete(pos - 1, pos));
        else if ($p.parent.isTextblock) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
          r.editor.commands.joinBackward();
        }
      } else {
        const sel = TextSelection.near(view.state.doc.resolve(Math.max(1, size - 1)));
        view.dispatch(view.state.tr.setSelection(sel));
        r.editor.commands.splitBlock();
      }
      ops++;
    }
    await tick();
    if (d % 30 === 29) onProgress?.(`${engine.name} day ${d + 1}: ${r.editor.state.doc.textContent.length} chars, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
  const editMs = performance.now() - t0;
  const chars = r.editor.state.doc.textContent.length;
  const snapshot = r.peer.snapshot();
  const compact = r.peer.compact();
  const loadSnapshot = await benchOpen(engine, snapshot, 5);
  const loadCompact = await benchOpen(engine, compact, 5);
  r.editor.destroy();
  return {
    ops,
    updates,
    finalChars: chars,
    updateLogBytes: logBytes,
    snapshotBytes: snapshot.byteLength,
    compactBytes: compact.byteLength,
    bytesPerFinalChar: { snapshot: +(snapshot.byteLength / chars).toFixed(2), compact: +(compact.byteLength / chars).toFixed(2) },
    editSeconds: +(editMs / 1000).toFixed(1),
    openFromSnapshot: loadSnapshot.open,
    openFromCompact: loadCompact.open,
    blobs: { snapshot, compact },
  };
}
