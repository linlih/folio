import { Editor } from "@tiptap/core";
import { baseExtensions } from "../editor/extensions";
import type { Engine, Peer } from "../engines/types";
import { drops } from "../engines/drops";
import { Net } from "./net";
import { applyOp, bidsOf, checkInvariants, pickOp, seeded, type OpName, type Rng } from "./ops";

export interface Replica {
  peer: Peer;
  editor: Editor;
}

/** One macrotask. loro-prosemirror loads the CRDT into the editor in a
 * `setTimeout(0)` after the view mounts; y-prosemirror does it synchronously.
 * Waiting a tick after every step treats both the same. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function createReplica(engine: Engine, peer: Peer = engine.createPeer(), element?: HTMLElement): Promise<Replica> {
  const editor = new Editor({
    element: element ?? document.createElement("div"),
    extensions: [...baseExtensions((tr) => peer.isRemoteTx(tr)), peer.binding()],
  });
  await tick();
  return { peer, editor };
}

export function destroy(rs: Replica[]) {
  rs.forEach((r) => r.editor.destroy());
}

function stable(json: unknown) {
  return JSON.stringify(json);
}

export interface Problem {
  seed: number;
  step: number;
  op: OpName | "sync";
  kind: string;
  detail: string;
}

export interface SuiteResult {
  engine: string;
  suite: string;
  runs: number;
  steps: number;
  problems: Problem[];
  /** Duplicate bids that appeared only after merging concurrent edits. */
  mergeDuplicateBids: number;
  /** Merged content the binding discarded because it violated the schema. */
  silentDrops: number;
  /** Characters of text inside the discarded content. */
  silentDropChars: number;
  dropSamples: string[];
  ms: number;
}

export const SEED_HTML = "<p>第一段</p><ul><li><p>列表一</p></li><li><p>列表二</p></li></ul><p>最后一段</p>";

/**
 * A card is created on one device and reaches the others through sync, so
 * replica 0 writes the initial content and the rest load its snapshot.
 * (Letting each replica create its own empty doc would merge N initial
 * paragraphs, which no real flow does.)
 */
export async function makeReplicas(engine: Engine, n: number, html = SEED_HTML): Promise<Replica[]> {
  const first = await createReplica(engine);
  first.editor.commands.setContent(html);
  await tick();
  // Creating a card is not an editor action the user can undo.
  first.peer.clearHistory();
  const snap = first.peer.snapshot();
  const rest: Replica[] = [];
  for (let i = 1; i < n; i++) rest.push(await createReplica(engine, engine.loadPeer(snap)));
  return [first, ...rest];
}

/**
 * Criterion 1: binding correctness. Two online replicas, random user-level
 * operations, invariants checked after every step.
 */
export async function runEditorSuite(engine: Engine, runs = 50, stepsPerRun = 60, firstSeed = 1): Promise<SuiteResult> {
  const t0 = performance.now();
  const drops0 = drops.count;
  const dropChars0 = drops.chars;
  const problems: Problem[] = [];
  let steps = 0;
  for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
    const rng = seeded(seed);
    const rs = await makeReplicas(engine, 2);
    const net = new Net(rs.map((r) => r.peer), rng);
    try {
      for (let step = 0; step < stepsPerRun; step++) {
        steps++;
        const r = rs[Math.floor(rng() * rs.length)];
        const op = pickOp(rng);
        const before = op === "moveBlock" ? bidsOf(r.editor.state.doc) : null;
        try {
          applyOp(r.editor, r.peer, op, rng);
        } catch (e) {
          problems.push({ seed, step, op, kind: "exception", detail: String((e as Error)?.stack ?? e).slice(0, 400) });
        }
        await tick();
        if (before) {
          const after = bidsOf(r.editor.state.doc);
          const lost = [...before.keys()].filter((b) => !after.has(b));
          if (lost.length) problems.push({ seed, step, op, kind: "bid-lost-on-move", detail: lost.join(",") });
        }
        for (const [i, x] of rs.entries()) {
          for (const f of checkInvariants(x.editor.state.doc)) {
            problems.push({ seed, step, op, kind: f.kind, detail: `replica ${i}: ${f.detail}` });
          }
        }
        const a = stable(rs[0].editor.getJSON());
        const b = stable(rs[1].editor.getJSON());
        if (a !== b) problems.push({ seed, step, op, kind: "replicas-diverged", detail: diffHint(a, b) });
        for (const [i, x] of rs.entries()) {
          const h = stable(x.peer.headlessJSON(x.editor.schema));
          const e = stable(x.editor.state.doc.toJSON());
          if (h !== e) problems.push({ seed, step, op, kind: "crdt-editor-mismatch", detail: `replica ${i}: ${diffHint(h, e)}` });
        }
        if (problems.length > 500) break;
      }
    } finally {
      net.dispose();
      destroy(rs);
    }
  }
  return { engine: engine.name, suite: "editor", runs, steps, problems, mergeDuplicateBids: 0, silentDrops: drops.count - drops0, silentDropChars: drops.chars - dropChars0, dropSamples: drops.samples.slice(), ms: performance.now() - t0 };
}

/**
 * Criterion 2: concurrent-merge correctness. Three replicas go on/offline at
 * random, edit concurrently, then fully sync; all must converge to the same
 * schema-valid document that also matches the CRDT state.
 */
export async function runConvergenceSuite(engine: Engine, runs = 20, stepsPerRun = 500, firstSeed = 1000): Promise<SuiteResult> {
  const t0 = performance.now();
  const drops0 = drops.count;
  const dropChars0 = drops.chars;
  const problems: Problem[] = [];
  let steps = 0;
  let mergeDuplicateBids = 0;
  for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
    const rng: Rng = seeded(seed);
    const rs = await makeReplicas(engine, 3);
    const net = new Net(rs.map((r) => r.peer), rng);
    try {
      for (let step = 0; step < stepsPerRun; step++) {
        steps++;
        if (rng() < 0.05) {
          const i = Math.floor(rng() * rs.length);
          net.setOnline(i, !net.isOnline(i));
        }
        const r = rs[Math.floor(rng() * rs.length)];
        const op = pickOp(rng);
        try {
          applyOp(r.editor, r.peer, op, rng);
        } catch (e) {
          problems.push({ seed, step, op, kind: "exception", detail: String((e as Error)?.stack ?? e).slice(0, 400) });
        }
        await tick();
        for (const [i, x] of rs.entries()) {
          for (const f of checkInvariants(x.editor.state.doc)) {
            if (f.kind === "duplicate-bid") continue; // counted after the final merge
            problems.push({ seed, step, op, kind: f.kind, detail: `replica ${i}: ${f.detail}` });
          }
        }
        if (problems.length > 500) break;
      }
      net.fullSync();
      await tick();
      const jsons = rs.map((x) => stable(x.editor.getJSON()));
      if (new Set(jsons).size !== 1) {
        const other = jsons.find((j) => j !== jsons[0]) ?? "";
        problems.push({ seed, step: stepsPerRun, op: "sync", kind: "not-converged", detail: diffHint(jsons[0], other) });
      }
      for (const [i, x] of rs.entries()) {
        const h = stable(x.peer.headlessJSON(x.editor.schema));
        const e = stable(x.editor.state.doc.toJSON());
        if (h !== e) problems.push({ seed, step: stepsPerRun, op: "sync", kind: "crdt-editor-mismatch", detail: `replica ${i}: ${diffHint(h, e)}` });
        for (const f of checkInvariants(x.editor.state.doc)) {
          if (f.kind === "duplicate-bid") {
            if (i === 0) mergeDuplicateBids++;
          } else problems.push({ seed, step: stepsPerRun, op: "sync", kind: f.kind, detail: `replica ${i}: ${f.detail}` });
        }
      }
    } finally {
      net.dispose();
      destroy(rs);
    }
  }
  return { engine: engine.name, suite: "convergence", runs, steps, problems, mergeDuplicateBids, silentDrops: drops.count - drops0, silentDropChars: drops.chars - dropChars0, dropSamples: drops.samples.slice(), ms: performance.now() - t0 };
}

function diffHint(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `@${i}: …${a.slice(Math.max(0, i - 60), i + 80)}… vs …${b.slice(Math.max(0, i - 60), i + 80)}…`;
}

export function summarize(r: SuiteResult) {
  const byKind: Record<string, number> = {};
  const byOp: Record<string, number> = {};
  for (const p of r.problems) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    byOp[p.op] = (byOp[p.op] ?? 0) + 1;
  }
  return {
    engine: r.engine,
    suite: r.suite,
    runs: r.runs,
    steps: r.steps,
    problems: r.problems.length,
    byKind,
    byOp,
    mergeDuplicateBids: r.mergeDuplicateBids,
    silentDrops: r.silentDrops,
    silentDropChars: r.silentDropChars,
    dropSamples: r.dropSamples.slice(0, 3),
    seconds: +(r.ms / 1000).toFixed(1),
    firstProblems: r.problems.slice(0, 4),
  };
}
