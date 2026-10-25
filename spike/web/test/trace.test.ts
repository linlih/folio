import { test } from "vitest";
import { loroEngine } from "../src/engines/loro";
import { yjsEngine } from "../src/engines/yjs";
import { makeReplicas, tick, destroy } from "../src/harness/runner";
import { applyOp, checkInvariants, pickOp, seeded } from "../src/harness/ops";
import { Net } from "../src/harness/net";

const brief = (doc: any) => {
  const out: string[] = [];
  doc.descendants((n: any) => { if (n.attrs?.bid !== undefined) out.push(`${n.type.name[0]}${(n.attrs.bid ?? "NULL").slice(-3)}"${n.textContent.slice(0, 6)}"`); });
  return out.join(" ");
};
const SEED = Number(process.env.SEED ?? 3), FROM = Number(process.env.FROM ?? 30), TO = Number(process.env.TO ?? 38);
for (const engine of [loroEngine, yjsEngine]) test(`trace ${engine.name}`, async () => {
  const rng = seeded(SEED);
  const rs = await makeReplicas(engine, 2);
  const net = new Net(rs.map((r) => r.peer), rng);
  for (let step = 0; step <= TO; step++) {
    const i = Math.floor(rng() * rs.length);
    const r = rs[i];
    const op = pickOp(rng);
    applyOp(r.editor, r.peer, op, rng);
    await tick();
    if (step >= FROM) process.stdout.write(`${engine.name} ${step} r${i} ${op}: ${brief(r.editor.state.doc)} ${checkInvariants(r.editor.state.doc).map(f=>f.kind).join(",")}\n`);
  }
  net.dispose(); destroy(rs);
});
