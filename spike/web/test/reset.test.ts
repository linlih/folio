// How small can a one-year card get? Loro state-only export, and a "history
// reset": the same content written into a brand-new document.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import { getSchema } from "@tiptap/core";
import { LoroDoc } from "loro-crdt";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { baseExtensions } from "../src/editor/extensions";
import { loroEngine } from "../src/engines/loro";
import { createReplica, tick } from "../src/harness/runner";

const DIR = resolve(__dirname, "../../results");

test("one-year card: compaction options", async () => {
  const schema = getSchema(baseExtensions(() => false));
  const out: Record<string, number> = {};

  const ysnap = new Uint8Array(readFileSync(`${DIR}/blobs/growth-yjs.snapshot`));
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, ysnap);
  const json = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment("prosemirror"), schema).toJSON();
  out.yjsSnapshot = ysnap.byteLength;
  out.yjsReset = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json)).byteLength;

  const lsnap = new Uint8Array(readFileSync(`${DIR}/blobs/growth-loro.snapshot`));
  const ldoc = LoroDoc.fromSnapshot(lsnap);
  out.loroSnapshot = lsnap.byteLength;
  out.loroShallow = ldoc.export({ mode: "shallow-snapshot", frontiers: ldoc.oplogFrontiers() }).byteLength;
  // Reset for Loro: let the binding write the same content into a new doc.
  const r = await createReplica(loroEngine);
  r.editor.commands.setContent(json);
  await tick();
  out.loroReset = r.peer.snapshot().byteLength;
  r.editor.destroy();

  for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}: ${v}\n`);
  writeFileSync(`${DIR}/growth-compaction.json`, JSON.stringify(out, null, 1));
});
