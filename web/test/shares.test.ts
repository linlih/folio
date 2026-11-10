import { afterEach, describe, expect, it, vi } from "vitest";
import { backend } from "../src/platform";

// Shares are saved after the saved tabs are back; there are none here.
vi.mock("../src/shell/layout", async (orig) => ({ ...(await orig<object>()), layoutRestored: () => Promise.resolve() }));
const { receiveShares } = await import("../src/inbox/clip");

const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("receiving shares", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a share that comes just after the page last looked", async () => {
    // The phone holds what was shared until the page takes it. The page's
    // second look finds nothing, and a new share lands right after it.
    let held: string | null = "第一次分享的笔记";
    let looks = 0;
    let lookDone!: () => void;
    const secondLook = new Promise<void>((r) => (lookDone = r));
    let looking = false;
    vi.spyOn(backend, "takeShared").mockImplementation(async () => {
      looks++;
      const text = held;
      held = null;
      if (looks === 2) {
        looking = true;
        await secondLook;
      }
      return text;
    });
    const before = (await backend.inbox()).length;
    receiveShares();
    await until(() => looking);
    held = "第二次分享的笔记";
    document.dispatchEvent(new Event("visibilitychange"));
    lookDone();
    await until(async () => (await backend.inbox()).length === before + 2);
    const titles = (await backend.inbox()).map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(["第一次分享的笔记", "第二次分享的笔记"]));
  });
});
