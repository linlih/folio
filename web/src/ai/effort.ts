// Which models take a thinking level, and which levels (design/ai.md
// "思考程度"): sending one to a model that does not know it fails the
// turn, so the picker offers it only where the model is known to take it.

import type { AiProtocol } from "./types";

/** The levels `model` takes, lowest first; none when it takes no level.
 *  `known` is what the provider said (Anthropic's Models API); without it
 *  the model's name decides. */
export function effortLevels(protocol: AiProtocol, model: string, known?: string[]): string[] {
  if (known) return known;
  // A router's id may carry the maker first (openai/gpt-5).
  const id = model.toLowerCase().split("/").pop() ?? "";
  if (protocol === "anthropic") {
    const v = id.match(/^claude-(?:[a-z]+-)?(\d+)(?:[-.](\d+))?/);
    if (!v) return [];
    const [major, minor] = [Number(v[1]), Number(v[2] ?? 0)];
    // Claude 5 on take every level; Opus 4.5 and the 4.6 models all but xhigh.
    if (major >= 5) return ["low", "medium", "high", "xhigh", "max"];
    if (major === 4 && (minor >= 6 || (minor === 5 && id.includes("opus")))) return ["low", "medium", "high", "max"];
    return [];
  }
  // OpenAI's reasoning models; other OpenAI-compatible models refuse or ignore reasoning_effort.
  return /^(o\d|gpt-5|gpt-oss)/.test(id) ? ["low", "medium", "high"] : [];
}

/** The level to send with a turn: the provider's, where the model takes it. */
export const turnEffort = (protocol: AiProtocol, model: string, effort?: string, known?: string[]) => (effort && effortLevels(protocol, model, known).includes(effort) ? effort : "");
