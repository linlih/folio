import { afterEach, describe, expect, it, vi } from "vitest";
import { backend } from "../src/platform";
import { isNewer, SKIPPED_SETTING, useUpdates } from "../src/update/updates";

describe("updates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useUpdates.setState({ status: "idle", found: null, prompt: false, error: null });
  });

  it("compares versions by number, releases after their pre-releases", () => {
    expect(isNewer("0.10.0", "0.9.3")).toBe(true);
    expect(isNewer("v1.2.0", "1.2.0")).toBe(false);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true);
    expect(isNewer("1.0.0-beta.10", "1.0.0-beta.9")).toBe(true);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });

  it("says a browser cannot update", async () => {
    await useUpdates.getState().check();
    expect(useUpdates.getState().status).toBe("unsupported");
  });

  it("on Android, offers the newer release's APK, and keeps a skipped one quiet", async () => {
    // The platform is read once per session; the memory backend says "web",
    // so this case stands in for the Android app.
    const b = backend as unknown as Record<string, unknown>;
    const kind = b.kind;
    b.kind = "tauri";
    vi.spyOn(backend, "appInfo").mockResolvedValue({ version: "0.1.0", dataDir: "", frontendPeer: "1", apiPeer: "2", platform: "android" });
    vi.spyOn(backend, "latestRelease").mockResolvedValue({ version: "0.2.0", notes: "新功能", date: null, apk: "https://github.com/linlih/folio/releases/latest/download/folio-android-arm64.apk" });
    const opened = vi.spyOn(backend, "openReleaseDownload").mockResolvedValue();
    const { useUpdates: fresh } = await vi.importActual<typeof import("../src/update/updates")>("../src/update/updates?android");
    try {
      await fresh.getState().check({ silent: true });
      expect(fresh.getState()).toMatchObject({ status: "available", prompt: true, found: { version: "0.2.0", how: "download" } });
      await fresh.getState().install();
      expect(opened).toHaveBeenCalledWith(expect.stringContaining("folio-android-arm64.apk"));
      await fresh.getState().skip();
      expect(await backend.getLocalSetting(SKIPPED_SETTING)).toEqual(["0.2.0"]);
      fresh.setState({ status: "idle", prompt: false });
      await fresh.getState().check({ silent: true });
      expect(fresh.getState()).toMatchObject({ status: "available", prompt: false });
    } finally {
      b.kind = kind;
    }
  });
});
