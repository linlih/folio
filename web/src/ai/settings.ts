// The assistant's settings on this device (design/ai.md "模型"): the
// providers the user added and which one chats use. Their API keys are kept
// by the host (backend.aiSetKey) and never come back here.

import { create } from "zustand";
import { uuidv7 } from "../docs/ids";
import { backend } from "../platform";
import type { AiProtocol } from "./types";

export interface AiProvider {
  id: string;
  name: string;
  protocol: AiProtocol;
  /** Up to the version, as the provider documents it. */
  baseUrl: string;
  model: string;
  /** Anthropic's effort; empty for the model's default. */
  effort?: string;
}

/** How the assistant's changes to notes are made (design/ai.md "写入"). */
export type WriteMode = "ask" | "auto";

export interface AiSettings {
  providers: AiProvider[];
  current: string | null;
  writes: WriteMode;
}

/** Read by the host too (src-tauri/src/ai.rs), for the providers. */
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

const EMPTY: AiSettings = { providers: [], current: null, writes: "ask" };

export const useAiSettings = create<AiSettings & { loaded: boolean; keys: string[] }>(() => ({ ...EMPTY, loaded: false, keys: [] }));

export async function loadAiSettings() {
  const [stored, keys] = await Promise.all([backend.getLocalSetting<Partial<AiSettings>>(SETTING).catch(() => null), backend.aiKeys().catch(() => [])]);
  const providers = Array.isArray(stored?.providers) ? stored.providers : [];
  const current = providers.some((p) => p.id === stored?.current) ? stored!.current! : (providers[0]?.id ?? null);
  useAiSettings.setState({ providers, current, writes: stored?.writes === "auto" ? "auto" : "ask", keys, loaded: true });
}

async function save(next: Partial<AiSettings>) {
  const s = { ...useAiSettings.getState(), ...next };
  const value: AiSettings = { providers: s.providers, current: s.current, writes: s.writes };
  useAiSettings.setState(value);
  await backend.setLocalSetting(SETTING, value);
}

export async function saveProvider(p: Omit<AiProvider, "id"> & { id?: string }, key: string | null): Promise<string> {
  const { providers, current } = useAiSettings.getState();
  const id = p.id ?? uuidv7();
  const provider: AiProvider = { ...p, id, name: p.name.trim() || p.model || p.baseUrl, baseUrl: p.baseUrl.trim(), model: p.model.trim() };
  const list = providers.some((x) => x.id === id) ? providers.map((x) => (x.id === id ? provider : x)) : [...providers, provider];
  await save({ providers: list, current: current ?? id });
  if (key !== null) {
    await backend.aiSetKey(id, key);
    useAiSettings.setState({ keys: await backend.aiKeys() });
  }
  return id;
}

export async function removeProvider(id: string) {
  const { providers, current } = useAiSettings.getState();
  const list = providers.filter((p) => p.id !== id);
  await backend.aiSetKey(id, "").catch(() => {});
  await save({ providers: list, current: current === id ? (list[0]?.id ?? null) : current });
  useAiSettings.setState({ keys: await backend.aiKeys().catch(() => []) });
}

export const chooseProvider = (id: string) => save({ current: id });
export const setWriteMode = (writes: WriteMode) => save({ writes });

export function currentProvider(): AiProvider | null {
  const { providers, current } = useAiSettings.getState();
  return providers.find((p) => p.id === current) ?? null;
}
