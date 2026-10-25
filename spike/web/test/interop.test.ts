// Criterion 5, JS half. Phase "export" writes fixtures for Rust; phase
// "verify" loads what Rust wrote back and checks it in a real editor.
//   INTEROP=export npx vitest run test/interop.test.ts
//   (cargo test --test interop)
//   INTEROP=verify npx vitest run test/interop.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import * as Y from "yjs";
import { loroEngine } from "../src/engines/loro";
import { yjsEngine } from "../src/engines/yjs";
import type { Engine, Peer } from "../src/engines/types";
import { createReplica, tick } from "../src/harness/runner";
import { checkInvariants } from "../src/harness/ops";
import { loroCard, yjsCard } from "../src/interop/canonical";

const DIR = resolve(__dirname, "../../fixtures") + "/";

function pack(updates: Uint8Array[]): Uint8Array {
  const total = updates.reduce((n, u) => n + 4 + u.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const u of updates) {
    view.setUint32(off, u.byteLength, true);
    out.set(u, off + 4);
    off += 4 + u.byteLength;
  }
  return out;
}

function canonicalOf(peer: Peer): unknown {
  const doc = (peer as unknown as { doc: LoroDoc | Y.Doc }).doc;
  return peer.engine === "loro" ? loroCard(doc as LoroDoc) : yjsCard(doc as Y.Doc);
}

function boardFor(engine: Engine): { bytes: Uint8Array; canonical: unknown } {
  const items = [
    { id: "i1", card: "c1", x: 10, y: 20, w: 240, h: 160 },
    { id: "i2", card: "c2", x: 400, y: 20, w: 240, h: 200 },
  ];
  if (engine.name === "loro") {
    const doc = new LoroDoc();
    for (const it of items) {
      const m = doc.getMap("items").setContainer(it.id, new LoroMap());
      for (const [k, v] of Object.entries(it)) if (k !== "id") m.set(k, v);
    }
    const e = doc.getMap("edges").setContainer("e1", new LoroMap());
    e.set("from", "i1");
    e.set("to", "i2");
    doc.commit();
    return { bytes: doc.export({ mode: "snapshot" }), canonical: { items: doc.getMap("items").toJSON(), edges: doc.getMap("edges").toJSON() } };
  }
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const it of items) {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(it)) if (k !== "id") m.set(k, v);
      doc.getMap("items").set(it.id, m);
    }
    const e = new Y.Map<unknown>();
    e.set("from", "i1");
    e.set("to", "i2");
    doc.getMap("edges").set("e1", e);
  });
  return { bytes: Y.encodeStateAsUpdate(doc), canonical: { items: doc.getMap("items").toJSON(), edges: doc.getMap("edges").toJSON() } };
}

const phase = process.env.INTEROP ?? "export";

for (const engine of [loroEngine, yjsEngine]) {
  test.runIf(phase === "export")(`export fixtures ${engine.name}`, async () => {
    const dir = `${DIR}${engine.name}/`;
    mkdirSync(dir, { recursive: true });
    // Subscribe before the editor mounts: the binding's own init commit is
    // part of the log (Loro writes the root containers there).
    const peer = engine.createPeer();
    const updates: Uint8Array[] = [];
    peer.onLocalUpdate((u) => updates.push(u.slice()));
    const r = await createReplica(engine, peer);
    const { editor } = r;
    editor.commands.setContent("<h1>互通测试</h1><p>普通 <strong>加粗</strong> <em>斜体</em> 文本</p>");
    await tick();
    editor.commands.focus("end");
    editor.commands.insertContent("<ul><li><p>列表一</p><ul><li><p>嵌套</p></li></ul></li></ul>");
    await tick();
    editor.commands.insertContent('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>已完成</p></li></ul>');
    await tick();
    editor.commands.insertContent("<pre><code>let x = 1;</code></pre><p>结尾</p>");
    await tick();
    for (const f of checkInvariants(editor.state.doc)) throw new Error(`fixture invalid: ${f.kind} ${f.detail}`);
    writeFileSync(`${dir}card.updates`, pack(updates));
    writeFileSync(`${dir}card.snapshot`, r.peer.snapshot());
    writeFileSync(`${dir}card.version`, r.peer.version());
    writeFileSync(`${dir}card.canonical.json`, JSON.stringify(canonicalOf(r.peer), null, 1));
    const board = boardFor(engine);
    writeFileSync(`${dir}board.snapshot`, board.bytes);
    writeFileSync(`${dir}board.canonical.json`, JSON.stringify(board.canonical, null, 1));
    editor.destroy();
  });

  test.runIf(phase === "verify")(`verify Rust output ${engine.name}`, async () => {
    const dir = `${DIR}${engine.name}/`;
    expect(existsSync(`${dir}rust-card.update`)).toBe(true);
    const peer = engine.loadPeer(new Uint8Array(readFileSync(`${dir}card.snapshot`)));
    peer.importUpdate(new Uint8Array(readFileSync(`${dir}rust-card.update`)));
    // Rust appended blocks; the editor must render them schema-valid.
    const r = await createReplica(engine, peer);
    await tick();
    const fails = checkInvariants(r.editor.state.doc);
    expect(fails).toEqual([]);
    const text = r.editor.state.doc.textContent;
    expect(text).toContain("Rust 导入的段落");
    expect(text).toContain("Rust 导入的标题");
    expect(canonicalOf(peer)).toEqual(JSON.parse(readFileSync(`${dir}rust-card.canonical.json`, "utf8")));
    // Editing after the Rust write must still sync back cleanly.
    r.editor.commands.focus("end");
    r.editor.commands.insertContent("<p>前端继续编辑</p>");
    await tick();
    expect(checkInvariants(r.editor.state.doc)).toEqual([]);
    expect(JSON.stringify(peer.headlessJSON(r.editor.schema))).toBe(JSON.stringify(r.editor.state.doc.toJSON()));
    writeFileSync(`${dir}js-after-rust.update`, peer.exportSince(new Uint8Array(readFileSync(`${dir}rust-card.version`))));
    writeFileSync(`${dir}js-after-rust.canonical.json`, JSON.stringify(canonicalOf(peer), null, 1));

    // Board edited in Rust.
    const board = new Uint8Array(readFileSync(`${dir}rust-board.snapshot`));
    const expected = JSON.parse(readFileSync(`${dir}rust-board.canonical.json`, "utf8"));
    let got: unknown;
    if (engine.name === "loro") {
      const doc = LoroDoc.fromSnapshot(board);
      got = { items: doc.getMap("items").toJSON(), edges: doc.getMap("edges").toJSON() };
    } else {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, board);
      got = { items: doc.getMap("items").toJSON(), edges: doc.getMap("edges").toJSON() };
    }
    expect(got).toEqual(expected);
    r.editor.destroy();
  });
}
