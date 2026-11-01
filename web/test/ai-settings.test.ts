// The assistant's settings shared by the workspace's devices (design/ai.md
// "设置同步"): providers and the write mode in the workspace document, keys
// sealed by the host.
import { beforeAll, describe, expect, it } from "vitest";
import { startDocs } from "../src/app";
import { loadAiSettings, removeProvider, saveProvider, useAiSettings } from "../src/ai/settings";
import { deleteProvider, readAiConfig, setSealedKey, setSharedWrites, writeProvider } from "../src/docs/aiConfig";
import { workspaceDoc } from "../src/docs/topics";
import { backend } from "../src/platform";
import { device, sync } from "./helpers";

const claude = { id: "p1", name: "Claude", protocol: "anthropic" as const, baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5-5", effort: "medium" };

describe("AI settings in the workspace document", () => {
  it("sync between devices, both first providers kept, a removal everywhere", () => {
    const a = device(1n);
    const b = device(2n);
    // Each device adds its first provider before they have synced.
    writeProvider(a, claude, 1);
    writeProvider(b, { id: "p2", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }, 2);
    setSealedKey(a, "p1", "sealed-a");
    setSealedKey(b, "p2", "sealed-b");
    setSharedWrites(b, "auto");
    sync(a, b);
    const shared = readAiConfig(a);
    expect(shared.providers.map((p) => p.name)).toEqual(["Claude", "DeepSeek"]);
    expect(shared.keys).toEqual({ p1: "sealed-a", p2: "sealed-b" });
    expect(shared.writes).toBe("auto");
    expect(readAiConfig(b)).toEqual(shared);
    // The thinking level changed on one device, the provider removed on the other.
    writeProvider(a, { ...claude, effort: "high" }, 3);
    deleteProvider(b, "p2", 4);
    sync(a, b);
    expect(readAiConfig(b).providers).toEqual([{ ...claude, effort: "high" }]);
    expect(readAiConfig(b).keys).toEqual({ p1: "sealed-a" });
    expect(readAiConfig(b).known.has("p2")).toBe(true);
  });
});

describe("AI settings on a device", () => {
  const until = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await cond()).toBe(true);
  };

  beforeAll(async () => {
    await startDocs();
    // Another device already shared Claude, before this one updated.
    const ws = (await workspaceDoc()).doc;
    writeProvider(ws, claude, 1);
    // This device's settings from before they synced: the same Claude under
    // its own id, with its key, and a provider only it has.
    await backend.setLocalSetting("ai.providers", {
      providers: [
        { ...claude, id: "mine" },
        { id: "kimi", name: "Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2" },
      ],
      current: "mine",
      writes: "auto",
    });
    await backend.aiSetKey("mine", "sk-claude");
    await backend.aiSetKey("kimi", "sk-kimi");
    await loadAiSettings();
  });

  it("shares this device's earlier settings once, the same provider made one", async () => {
    const s = useAiSettings.getState();
    expect(s.providers.map((p) => p.id)).toEqual(["p1", "kimi"]);
    expect(s.current).toBe("p1");
    expect(s.writes).toBe("auto");
    // The key moved to the shared provider, and both keys were sent sealed.
    const shared = readAiConfig((await workspaceDoc()).doc);
    expect(Object.keys(shared.keys).sort()).toEqual(["kimi", "p1"]);
    expect(shared.keys.p1).toMatch(/^sealed:p1:sk-claude:/);
    // Where the host reads them.
    const mirror = await backend.getLocalSetting<{ providers: { id: string }[]; shared: boolean }>("ai.providers");
    expect(mirror?.shared).toBe(true);
    expect(mirror?.providers.map((p) => p.id)).toEqual(["p1", "kimi"]);
  });

  it("keeps a key another device changed, and forgets the key of a provider removed there", async () => {
    const ws = (await workspaceDoc()).doc;
    setSealedKey(ws, "p1", "sealed:p1:sk-new:9");
    deleteProvider(ws, "kimi");
    await until(async () => {
      const keys = await backend.aiKeys();
      return keys.length === 1 && keys[0].synced === "sealed:p1:sk-new:9";
    });
    expect(useAiSettings.getState().providers.map((p) => p.id)).toEqual(["p1"]);
  });

  it("sends a key typed here, and takes it away with its provider", async () => {
    const id = await saveProvider({ name: "Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen3" }, "local-key");
    const ws = (await workspaceDoc()).doc;
    expect(readAiConfig(ws).keys[id]).toMatch(new RegExp(`^sealed:${id}:local-key:`));
    await saveProvider({ ...useAiSettings.getState().providers.find((p) => p.id === id)!, effort: "low" }, null);
    expect(readAiConfig(ws).keys[id]).toMatch(/local-key/);
    await removeProvider(id);
    expect(readAiConfig(ws).keys[id]).toBeUndefined();
    expect((await backend.aiKeys()).map((k) => k.provider)).not.toContain(id);
  });
});
