// Checks for the architecture review: assumptions the spike did not cover.
import { test } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { loroEngine } from "../src/engines/loro";
import { createReplica, tick } from "../src/harness/runner";

const out = (s: string) => process.stdout.write(s + "\n");
const sync = (a: LoroDoc, b: LoroDoc) => {
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
};

test("A1: two devices create the same nested map key concurrently", () => {
  const a = new LoroDoc(), b = new LoroDoc();
  a.getMap("meta").setContainer("tags", new LoroMap()).set("from-a", 1);
  b.getMap("meta").setContainer("tags", new LoroMap()).set("from-b", 1);
  a.commit(); b.commit();
  sync(a, b);
  out(`A1 tags after merge: ${JSON.stringify(a.getMap("meta").toJSON())}`);
});

test("A2: two devices start the same (deterministic-id) journal offline", async () => {
  const pa = loroEngine.createPeer(), pb = loroEngine.createPeer();
  const ra = await createReplica(loroEngine, pa), rb = await createReplica(loroEngine, pb);
  ra.editor.commands.setContent("<p>手机上写的</p>"); await tick();
  rb.editor.commands.setContent("<p>电脑上写的</p>"); await tick();
  pb.importUpdate(pa.exportSince(pb.version()));
  pa.importUpdate(pb.exportSince(pa.version()));
  await tick();
  out(`A2 merged journal: A="${ra.editor.state.doc.textContent}" B="${rb.editor.state.doc.textContent}"`);
  ra.editor.destroy(); rb.editor.destroy();
});

test("B: a device that compacted receives an old offline device's edits", () => {
  const a = new LoroDoc(), b = new LoroDoc();
  a.getText("t").insert(0, "hello"); a.commit();
  sync(a, b);
  b.getText("t").insert(5, " from-offline-b"); b.commit();         // b goes offline
  for (let i = 0; i < 50; i++) { a.getText("t").insert(0, "x"); a.commit(); }
  const shallow = a.export({ mode: "shallow-snapshot", frontiers: a.oplogFrontiers() });
  const a2 = LoroDoc.fromSnapshot(shallow);                          // a compacted locally
  try {
    a2.import(b.export({ mode: "update", from: new LoroDoc().oplogVersion() }));
    out(`B import ok: "${a2.getText("t").toString().slice(-25)}"`);
  } catch (e) {
    out(`B import FAILED: ${String(e).slice(0, 160)}`);
  }
  // The fix (compact only up to the version every device acknowledged) is in review-fix.test.ts.
});
