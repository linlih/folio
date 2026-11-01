// The assistant's settings (design/ai.md "模型", "设置同步"): the providers
// the user added and how changes to notes are made, shared by the
// workspace's devices through the workspace document (docs/aiConfig.ts);
// which provider chats use is this device's. The host reads the providers
// from the local setting mirrored here. API keys are kept by the host
// (backend.aiSetKey) and never come back here; each goes to the other
// devices sealed with the sync workspace key, which only the host has.

import { create } from "zustand";
import { deleteProvider, readAiConfig, setSealedKey, setSharedWrites, writeProvider, type SharedProvider } from "../docs/aiConfig";
import { uuidv7 } from "../docs/ids";
import { workspaceDoc } from "../docs/topics";
import { backend } from "../platform";
import type { AiProtocol } from "./types";

export interface AiProvider {
  id: string;
  name: string;
  protocol: AiProtocol;
  /** Up to the version, as the provider documents it. */
  baseUrl: string;
  model: string;
  /** How hard it thinks; empty for the model's default. */
  effort?: string;
}

/** How the assistant's changes to notes are made (design/ai.md "写入"). */
export type WriteMode = "ask" | "auto";

export interface AiSettings {
  providers: AiProvider[];
  current: string | null;
  writes: WriteMode;
}

/** Read by the host too (src-tauri/src/ai.rs), for the providers. Before
 *  the settings synced it was where they were kept; `shared` marks that
 *  this device's have been put in the workspace document. */
const SETTING = "ai.providers";

export interface Preset {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  effort?: string;
  /** Whether it works without a key (a local server). */
  keyless?: boolean;
}

/** Common providers, to start from; the model can be changed. */
export const PRESETS: Preset[] = [
  { id: "claude", name: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5-5", effort: "medium" },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "qwen", name: "通义千问", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "" },
  { id: "kimi", name: "Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "" },
  { id: "ollama", name: "Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "", keyless: true },
  { id: "custom", name: "", protocol: "openai", baseUrl: "", model: "" },
];

type Stored = Partial<AiSettings> & { shared?: boolean };

export const useAiSettings = create<AiSettings & { loaded: boolean; keys: string[] }>(() => ({ providers: [], current: null, writes: "ask", loaded: false, keys: [] }));

/** One change at a time: keys are sealed and opened in order with the
 *  settings that name them. */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T,>(f: () => Promise<T>): Promise<T> => {
  const run = queue.then(f, f);
  queue = run.catch(() => {});
  return run;
};

const sameProvider = (a: SharedProvider, b: SharedProvider) => a.protocol === b.protocol && a.baseUrl.replace(/\/+$/, "") === b.baseUrl.replace(/\/+$/, "") && a.model === b.model;

/** Puts this device's settings from before they synced into the workspace
 *  document, once: a provider another device already added is the same
 *  one, and its key here is kept under that one. */
async function shareLocal(stored: Stored) {
  const ws = (await workspaceDoc()).doc;
  const shared = readAiConfig(ws);
  const providers = Array.isArray(stored.providers) ? stored.providers : [];
  let current = stored.current ?? null;
  for (const p of providers) {
    if (shared.known.has(p.id)) continue;
    const same = shared.providers.find((s) => sameProvider(s, p));
    if (same) {
      await backend.aiMoveKey(p.id, same.id).catch(() => {});
      if (current === p.id) current = same.id;
    } else {
      writeProvider(ws, { id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, ...(p.effort ? { effort: p.effort } : {}) });
    }
  }
  if (shared.writes === null && stored.writes) setSharedWrites(ws, stored.writes);
  return current;
}

/** The settings as the workspace document has them now, with this
 *  device's choice of provider; written where the host reads them. */
async function apply(current?: string | null) {
  const ws = (await workspaceDoc()).doc;
  const shared = readAiConfig(ws);
  const want = current === undefined ? useAiSettings.getState().current : current;
  const providers: AiProvider[] = shared.providers;
  const chosen = providers.some((p) => p.id === want) ? want! : (providers[0]?.id ?? null);
  const value: AiSettings & { shared: true } = { providers, current: chosen, writes: shared.writes ?? "ask", shared: true };
  useAiSettings.setState({ providers, current: chosen, writes: value.writes });
  await backend.setLocalSetting(SETTING, value);
}

/** Brings this device's keys in line with the shared ones: a key another
 *  device sent (or changed) is kept here, a key only here is sent, and the
 *  key of a provider removed elsewhere is forgotten. */
async function reconcileKeys() {
  const ws = (await workspaceDoc()).doc;
  const shared = readAiConfig(ws);
  const here = await backend.aiKeys().catch(() => []);
  const ids = new Set(shared.providers.map((p) => p.id));
  for (const p of shared.providers) {
    const sealed = shared.keys[p.id];
    const mine = here.find((k) => k.provider === p.id);
    if (sealed && mine?.synced !== sealed) {
      await backend.aiOpenKey(p.id, sealed).catch((e) => {
        // Without sync here, keys come only from what is typed here.
        if (!String(e).includes("no-sync")) console.warn("cannot open a synced key", e);
      });
    } else if (!sealed && mine) {
      const out = await backend.aiSealKey(p.id).catch(() => null);
      if (out) setSealedKey(ws, p.id, out);
    }
  }
  for (const k of here) if (!ids.has(k.provider) && shared.known.has(k.provider)) await backend.aiSetKey(k.provider, "").catch(() => {});
  useAiSettings.setState({ keys: (await backend.aiKeys().catch(() => [])).map((k) => k.provider) });
}

let watching = false;

export function loadAiSettings() {
  return serial(async () => {
    const stored = await backend.getLocalSetting<Stored>(SETTING).catch(() => null);
    let current = stored?.current ?? null;
    if (stored && !stored.shared) current = await shareLocal(stored);
    await apply(current);
    await reconcileKeys();
    useAiSettings.setState({ loaded: true });
    if (watching) return;
    watching = true;
    // Changes from other devices (and from here, which settle at once).
    const h = await workspaceDoc();
    let pending: ReturnType<typeof setTimeout> | undefined;
    h.doc.subscribe(() => {
      clearTimeout(pending);
      pending = setTimeout(() => void serial(async () => (await apply(), await reconcileKeys())), 300);
    });
  });
}

/** Adds or changes a provider; `key` null leaves its key as it is, "" removes it. */
export function saveProvider(p: Omit<AiProvider, "id"> & { id?: string }, key: string | null): Promise<string> {
  return serial(async () => {
    const ws = (await workspaceDoc()).doc;
    const id = p.id ?? uuidv7();
    const effort = p.effort?.trim();
    writeProvider(ws, { id, name: p.name.trim() || p.model.trim() || p.baseUrl.trim(), protocol: p.protocol, baseUrl: p.baseUrl.trim(), model: p.model.trim(), ...(effort ? { effort } : {}) });
    if (key !== null) {
      await backend.aiSetKey(id, key);
      setSealedKey(ws, id, key.trim() ? await backend.aiSealKey(id).catch(() => null) : null);
      useAiSettings.setState({ keys: (await backend.aiKeys()).map((k) => k.provider) });
    }
    await apply(useAiSettings.getState().current ?? id);
    return id;
  });
}

export function removeProvider(id: string) {
  return serial(async () => {
    deleteProvider((await workspaceDoc()).doc, id);
    await backend.aiSetKey(id, "").catch(() => {});
    await apply();
    useAiSettings.setState({ keys: (await backend.aiKeys().catch(() => [])).map((k) => k.provider) });
  });
}

/** This device's choice of provider. */
export const chooseProvider = (id: string) => serial(() => apply(id));

export const setWriteMode = (writes: WriteMode) =>
  serial(async () => {
    setSharedWrites((await workspaceDoc()).doc, writes);
    await apply();
  });

export function currentProvider(): AiProvider | null {
  const { providers, current } = useAiSettings.getState();
  return providers.find((p) => p.id === current) ?? null;
}
