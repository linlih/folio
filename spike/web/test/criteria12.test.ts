import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { loroEngine } from "../src/engines/loro";
import { yjsEngine } from "../src/engines/yjs";
import type { Engine } from "../src/engines/types";
import { runConvergenceSuite, runEditorSuite, summarize } from "../src/harness/runner";

// Criterion 1 and 2 at full size. ENGINE=loro|yjs picks one so both can run in parallel.
const engines: Engine[] = process.env.ENGINE === "yjs" ? [yjsEngine] : process.env.ENGINE === "loro" ? [loroEngine] : [loroEngine, yjsEngine];

for (const engine of engines) {
  test(`criterion 1+2 ${engine.name}`, async () => {
    const quick = process.env.SIZE === "quick";
    const editor = await runEditorSuite(engine, quick ? 15 : 50, 60);
    const conv = await runConvergenceSuite(engine, quick ? 10 : 200, quick ? 300 : 500);
    const result = { editor: summarize(editor), convergence: summarize(conv), allProblems: [...editor.problems, ...conv.problems].slice(0, 300) };
    writeFileSync(`../results/criteria12-${engine.name}${process.env.YPM_PATCH ? "-patched" : ""}${quick ? "-quick" : ""}.json`, JSON.stringify(result, null, 1));
  });
}
