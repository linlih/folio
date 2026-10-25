import { expect, test } from "vitest";
import { loroEngine } from "../src/engines/loro";
import { yjsEngine } from "../src/engines/yjs";
import { runConvergenceSuite, runEditorSuite, summarize } from "../src/harness/runner";

const out = (x: unknown) => process.stdout.write("\n" + JSON.stringify(x, null, 1) + "\n");

for (const engine of [loroEngine, yjsEngine]) {
  test(`smoke ${engine.name}`, async () => {
    const a = summarize(await runEditorSuite(engine, 2, 20));
    const b = summarize(await runConvergenceSuite(engine, 1, 50));
    out(a);
    out(b);
    expect(a.steps).toBe(40);
  });
}
