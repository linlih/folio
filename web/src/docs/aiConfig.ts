// The assistant's settings shared by the workspace's devices (design/ai.md
// "设置同步"): the providers (not which one a device uses), how changes to
// notes are made, and each provider's API key sealed with the sync
// workspace key by the host, which alone can open it. Kept in the
// workspace document's `ai` map, which versions before it leave alone.

import { LoroMap, type LoroDoc } from "loro-crdt";
import type { AiProtocol } from "../ai/types";

const AI = "ai";
/** Origin of these edits: not undoable from a card. */
export const AI_ORIGIN = "meta:ai";

export interface SharedProvider {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  effort?: string;
}

export interface SharedAiConfig {
  /** In the order added. */
  providers: SharedProvider[];
  /** Every provider ever added, removed ones too (not to be added back). */
  known: Set<string>;
  writes: "ask" | "auto" | null;
  /** Sealed keys by provider. */
  keys: Record<string, string>;
}

const str = (m: LoroMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : "");

// Mergeable, so two devices writing their first provider or key at once
// both keep theirs (§4.5 rule 2).
const providersMap = (ws: LoroDoc) => ws.getMap(AI).ensureMergeableMap("providers");
const keysMap = (ws: LoroDoc) => ws.getMap(AI).ensureMergeableMap("keys");

export function readAiConfig(ws: LoroDoc): SharedAiConfig {
  const root = ws.getMap(AI);
  const providers: (SharedProvider & { at: number })[] = [];
  const known = new Set<string>();
  const list = root.get("providers");
  if (list instanceof LoroMap) {
    for (const id of list.keys()) {
      const m = list.get(id);
      if (!(m instanceof LoroMap)) continue;
      known.add(id);
      if (typeof m.get("deleted_at") === "number") continue;
      const protocol = str(m, "protocol") === "anthropic" ? "anthropic" : "openai";
      const effort = str(m, "effort");
      providers.push({ id, name: str(m, "name"), protocol, baseUrl: str(m, "base_url"), model: str(m, "model"), ...(effort ? { effort } : {}), at: Number(m.get("created_at")) || 0 });
    }
  }
  providers.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const keys: Record<string, string> = {};
  const sealed = root.get("keys");
  if (sealed instanceof LoroMap) for (const id of sealed.keys()) if (typeof sealed.get(id) === "string") keys[id] = sealed.get(id) as string;
  const writes = root.get("writes");
  return { providers: providers.map(({ at: _, ...p }) => p), known, writes: writes === "ask" || writes === "auto" ? writes : null, keys };
}

/** Adds a provider or changes it; only the fields that changed are written. */
export function writeProvider(ws: LoroDoc, p: SharedProvider, now = Date.now()) {
  const all = providersMap(ws);
  const m = all.ensureMergeableMap(p.id);
  if (m.get("created_at") === undefined) m.set("created_at", now);
  const fields: [string, string][] = [["name", p.name], ["protocol", p.protocol], ["base_url", p.baseUrl], ["model", p.model], ["effort", p.effort ?? ""]];
  for (const [k, v] of fields) if (m.get(k) !== v) m.set(k, v);
  ws.commit({ origin: AI_ORIGIN });
}

/** Removes a provider on every device, and its key. */
export function deleteProvider(ws: LoroDoc, id: string, now = Date.now()) {
  const m = providersMap(ws).get(id);
  if (m instanceof LoroMap) m.set("deleted_at", now);
  keysMap(ws).delete(id);
  ws.commit({ origin: AI_ORIGIN });
}

export function setSharedWrites(ws: LoroDoc, writes: "ask" | "auto") {
  if (ws.getMap(AI).get("writes") === writes) return;
  ws.getMap(AI).set("writes", writes);
  ws.commit({ origin: AI_ORIGIN });
}

/** A provider's key as sealed by the host; null takes it away. */
export function setSealedKey(ws: LoroDoc, id: string, sealed: string | null) {
  const keys = keysMap(ws);
  if (sealed === null) keys.delete(id);
  else if (keys.get(id) !== sealed) keys.set(id, sealed);
  ws.commit({ origin: AI_ORIGIN });
}
