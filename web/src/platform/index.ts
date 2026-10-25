import { isTauri } from "@tauri-apps/api/core";
import type { Backend } from "./backend";
import { memoryBackend } from "./memory";
import { tauriBackend } from "./tauri";

export type { Backend } from "./backend";

export const backend: Backend = isTauri() ? tauriBackend() : memoryBackend();
