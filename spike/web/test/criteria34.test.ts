// Criteria 3 and 4 in jsdom (Node). Real-WebView numbers come from the bench page.
//   BENCH=perf|growth ENGINE=loro|yjs [DAYS=365]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import { loroEngine } from "../src/engines/loro";
import { yjsEngine } from "../src/engines/yjs";
import type { Engine } from "../src/engines/types";
import { benchGrowth, benchKeystrokes, benchOpen, buildCardSnapshot } from "../src/bench/bench";

const OUT = resolve(__dirname, "../../results");
const engines: Engine[] = process.env.ENGINE === "yjs" ? [yjsEngine] : process.env.ENGINE === "loro" ? [loroEngine] : [loroEngine, yjsEngine];
const which = process.env.BENCH ?? "perf";

for (const engine of engines) {
  test.runIf(which === "perf")(`perf ${engine.name}`, async () => {
    const { snapshot, chars } = await buildCardSnapshot(engine);
    const open = await benchOpen(engine, snapshot, 30);
    const keys = await benchKeystrokes(engine, snapshot, 1000);
    const result = { env: "jsdom/node", engine: engine.name, cardChars: chars, snapshotBytes: snapshot.byteLength, ...open, ...keys };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/perf-jsdom-${engine.name}.json`, JSON.stringify(result, null, 1));
  });

  test.runIf(which === "growth")(`growth ${engine.name}`, async () => {
    const days = Number(process.env.DAYS ?? 365);
    const { blobs, ...result } = await benchGrowth(engine, days, 550, (m) => appendFileSync(`${OUT}/growth-progress.log`, m + "\n"));
    mkdirSync(`${OUT}/blobs`, { recursive: true });
    writeFileSync(`${OUT}/blobs/growth-${engine.name}.snapshot`, blobs.snapshot);
    writeFileSync(`${OUT}/blobs/growth-${engine.name}.compact`, blobs.compact);
    writeFileSync(`${OUT}/growth-${engine.name}${days === 365 ? "" : `-${days}d`}.json`, JSON.stringify({ engine: engine.name, days, ...result }, null, 1));
  });
}
