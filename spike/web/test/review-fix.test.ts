// Candidate fixes for the review findings.
import { test } from "vitest";
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { createNodeFromLoroObj } from "loro-prosemirror";
import { getSchema } from "@tiptap/core";
import { baseExtensions } from "../src/editor/extensions";

const out = (s: string) => process.stdout.write(s + "\n");
const sync = (a: LoroDoc, b: LoroDoc) => {
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
};

test("A1 fix: mergeable child map", () => {
  const a = new LoroDoc(), b = new LoroDoc();
  a.getMap("meta").ensureMergeableMap("tags").set("from-a", 1);
  b.getMap("meta").ensureMergeableMap("tags").set("from-b", 1);
  a.commit(); b.commit();
  sync(a, b);
  out(`A1-fix tags: ${JSON.stringify(a.getMap("meta").toJSON())}`);
});

// The binding's root node: {nodeName, attributes, children}. If the root's
// attributes/children are mergeable, two devices that start the same journal
// offline write into one children list.
function startJournal(doc: LoroDoc, text: string, bid: string) {
  const root = doc.getMap("doc");
  root.set("nodeName", "doc");
  root.ensureMergeableMap("attributes");
  const children = root.ensureMergeableList("children");
  const p = children.insertContainer(children.length, new LoroMap());
  p.set("nodeName", "paragraph");
  p.setContainer("attributes", new LoroMap()).set("bid", bid);
  p.setContainer("children", new LoroList()).insertContainer(0, new LoroText()).insert(0, text);
  doc.commit();
}

test("A2 fix: journal root with mergeable children", () => {
  const a = new LoroDoc(), b = new LoroDoc();
  startJournal(a, "手机上写的", "pa");
  startJournal(b, "电脑上写的", "pb");
  sync(a, b);
  const schema = getSchema(baseExtensions(() => false));
  const node = createNodeFromLoroObj(schema, a.getMap("doc") as never, new Map());
  out(`A2-fix merged journal: ${JSON.stringify(node.textContent)} (blocks: ${node.childCount})`);
});

test("B fix: compact at the version every device has acknowledged", () => {
  const a = new LoroDoc(), b = new LoroDoc();
  a.getText("t").insert(0, "hello"); a.commit();
  sync(a, b);
  const acked = a.oplogFrontiers();          // last version both devices confirmed
  b.getText("t").insert(5, " from-offline-b"); b.commit();
  for (let i = 0; i < 50; i++) { a.getText("t").insert(0, "x"); a.commit(); }
  const shallow = a.export({ mode: "shallow-snapshot", frontiers: acked });
  const a2 = LoroDoc.fromSnapshot(shallow);
  a2.import(b.export({ mode: "update", from: new LoroDoc().oplogVersion() }));
  out(`B-fix import ok: "...${a2.getText("t").toString().slice(-25)}" (${shallow.byteLength} B)`);
});
