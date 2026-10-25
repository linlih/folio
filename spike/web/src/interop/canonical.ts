// Engine-independent JSON, same rules as spike/rust/src/canonical.rs:
// elements are {type, attrs (nulls dropped, keys sorted), content}; text runs
// are {text, marks: sorted names}; adjacent runs with equal marks are merged.
import type { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { LoroMap as LoroMapClass, LoroText as LoroTextClass } from "loro-crdt";
import * as Y from "yjs";

type J = Record<string, unknown>;

function element(type: string, attrs: Record<string, unknown>, content: J[]): J {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(attrs).sort()) if (attrs[k] !== null && attrs[k] !== undefined) sorted[k] = attrs[k];
  return { type, attrs: sorted, content: mergeText(content) };
}

function text(s: string, marks: string[]): J {
  return { text: s, marks: [...new Set(marks)].sort() };
}

function mergeText(content: J[]): J[] {
  const out: J[] = [];
  for (const v of content) {
    const last = out[out.length - 1];
    if (last && "text" in last && "text" in v && JSON.stringify(last.marks) === JSON.stringify(v.marks)) {
      last.text = (last.text as string) + (v.text as string);
      continue;
    }
    if ("text" in v && v.text === "") continue;
    out.push({ ...v });
  }
  return out;
}

function loroNode(map: LoroMap): J {
  const name = map.get("nodeName") as string;
  const attrsC = map.get("attributes") as LoroMap | undefined;
  const attrs = (attrsC?.toJSON() ?? {}) as Record<string, unknown>;
  const kids = map.get("children") as LoroList | undefined;
  const content: J[] = [];
  for (const child of kids?.toArray() ?? []) {
    if (child instanceof LoroMapClass) content.push(loroNode(child as LoroMap));
    else if (child instanceof LoroTextClass) content.push(...loroText(child as LoroText));
  }
  return element(name, attrs, content);
}

function loroText(t: LoroText): J[] {
  return t.toDelta().flatMap((d) => {
    if (typeof d.insert !== "string") return [];
    const marks = Object.entries(d.attributes ?? {}).filter(([, v]) => v !== null).map(([k]) => k);
    return [text(d.insert, marks)];
  });
}

export function loroCard(doc: LoroDoc): J | null {
  const root = doc.getMap("doc");
  if (root.size === 0) return null;
  return loroNode(root as unknown as LoroMap);
}

function yChildren(parent: Y.XmlFragment | Y.XmlElement): J[] {
  const out: J[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      out.push(element(child.nodeName, child.getAttributes() as Record<string, unknown>, yChildren(child)));
    } else if (child instanceof Y.XmlText) {
      for (const d of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof d.insert !== "string") continue;
        const marks = Object.entries(d.attributes ?? {}).filter(([, v]) => v !== null).map(([k]) => k);
        out.push(text(d.insert, marks));
      }
    }
  }
  return out;
}

export function yjsCard(doc: Y.Doc): J | null {
  const frag = doc.getXmlFragment("prosemirror");
  if (frag.length === 0) return null;
  return element("doc", {}, yChildren(frag));
}
