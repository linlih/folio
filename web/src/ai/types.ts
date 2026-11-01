// The assistant's conversation as the host takes it (crates/folio-ai): the
// same for every provider.

import type { WriteRecord } from "./writes";

export type AiProtocol = "anthropic" | "openai";

export type AiPart =
  | { type: "text"; text: string }
  /** `invalid`: the arguments as sent, when they were not JSON. */
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; invalid?: string };

export interface AiToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type AiMessage =
  | { role: "user"; text: string }
  /** `raw`: the provider's own content, sent back as it was. */
  | { role: "assistant"; parts: AiPart[]; raw?: { protocol: AiProtocol; content: unknown } }
  /** `writes`: the write tool calls among them, by call id (ai/writes.ts);
   *  kept for the conversation, not sent to the model. */
  | { role: "tools"; results: AiToolResult[]; writes?: Record<string, WriteRecord> };

export interface AiTool {
  name: string;
  description: string;
  schema: unknown;
}

export type AiEvent = { type: "text"; text: string } | { type: "tool"; id: string; name: string };

export type AiStop = "end" | "toolUse" | "maxTokens" | "refusal" | "cancelled" | { other: string };

export interface AiReply {
  parts: AiPart[];
  raw: { protocol: AiProtocol; content: unknown } | null;
  stop: AiStop;
  inputTokens: number;
  outputTokens: number;
}

export interface AiTurnRequest {
  /** Names the turn, to stop it. */
  turn: string;
  provider: string;
  system: string;
  messages: AiMessage[];
  tools: AiTool[];
}
