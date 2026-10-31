import { afterEach, describe, expect, it, vi } from "vitest";
import { backend } from "../src/platform";
import { isNewer, SKIPPED_SETTING, updateErrorKind, useUpdates } from "../src/update/updates";

// Updating saves what is typed first; no documents are open here.
vi.mock("../src/app", () => ({ docs: () => ({ flushAll: async () => {} }) }));

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

  it("says what went wrong in plain words", () => {
    // A release whose macOS build has not finished yet.
    expect(updateErrorKind('None of the fallback platforms `["darwin-aarch64-app", "darwin-aarch64"]` were found in the response `platforms` object')).toBe("notReady");
    expect(updateErrorKind("https://github.com/…/folio-android-arm64.apk: status code 404")).toBe("notReady");
    expect(updateErrorKind("error sending request for url (https://github.com/…/latest.json)")).toBe("network");
    expect(updateErrorKind("Could not fetch a valid release JSON from the remote")).toBe("network");
    expect(updateErrorKind("Error: the download stopped early (1000 of 52000000 bytes)")).toBe("interrupted");
    expect(updateErrorKind("The signature verification failed")).toBe("signature");
    expect(updateErrorKind("something else")).toBe("other");
  });

  it("says a browser cannot update", async () => {
    await useUpdates.getState().check();
    expect(useUpdates.getState().status).toBe("unsupported");
  });

  it("on Android, downloads the newer release's APK and opens the installer, and keeps a skipped version quiet", async () => {
    // The platform is read once per session; the memory backend says "web",
    // so this case stands in for the Android app.
    const b = backend as unknown as Record<string, unknown>;
    const kind = b.kind;
    b.kind = "tauri";
    vi.spyOn(backend, "appInfo").mockResolvedValue({ version: "0.1.0", dataDir: "", frontendPeer: "1", apiPeer: "2", storePeer: "3", platform: "android" });
    vi.spyOn(backend, "latestRelease").mockResolvedValue({ version: "0.2.0", notes: "新功能", date: null, apk: "https://github.com/linlih/folio/releases/download/v0.2.0/folio-android-arm64.apk" });
    const download = vi.spyOn(backend, "downloadUpdate").mockImplementation(async (_url, onProgress) => {
      onProgress(0.5);
      onProgress(1);
      return "/cache/updates/folio-update.apk";
    });
    // The first time, Android asks the user to allow installing apps.
    const installer = vi.spyOn(backend, "installUpdate").mockResolvedValueOnce(false).mockResolvedValue(true);
    const browser = vi.spyOn(backend, "openReleaseDownload").mockResolvedValue();
    const { useUpdates: fresh } = await vi.importActual<typeof import("../src/update/updates")>("../src/update/updates?android");
    try {
      await fresh.getState().check({ silent: true });
      expect(fresh.getState()).toMatchObject({ status: "available", prompt: true, found: { version: "0.2.0", how: "package" } });
      await fresh.getState().install();
      expect(download).toHaveBeenCalledWith(expect.stringContaining("v0.2.0/folio-android-arm64.apk"), expect.any(Function));
      expect(installer).toHaveBeenCalledWith("/cache/updates/folio-update.apk");
      expect(fresh.getState()).toMatchObject({ status: "ready", progress: 1, allowing: true });
      // Back from the system page: installing goes ahead, without downloading again.
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(installer).toHaveBeenCalledTimes(2));
      expect(download).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(fresh.getState().allowing).toBe(false));
      expect(browser).not.toHaveBeenCalled();

      fresh.setState({ status: "idle", prompt: false, apk: null });
      await fresh.getState().skip();
      expect(await backend.getLocalSetting(SKIPPED_SETTING)).toEqual(["0.2.0"]);
      await fresh.getState().check({ silent: true });
      expect(fresh.getState()).toMatchObject({ status: "available", prompt: false });
    } finally {
      b.kind = kind;
    }
  });

  it("on Android, a failed download offers the browser", async () => {
    const b = backend as unknown as Record<string, unknown>;
    const kind = b.kind;
    b.kind = "tauri";
    vi.spyOn(backend, "appInfo").mockResolvedValue({ version: "0.1.0", dataDir: "", frontendPeer: "1", apiPeer: "2", storePeer: "3", platform: "android" });
    vi.spyOn(backend, "latestRelease").mockResolvedValue({ version: "0.2.0", notes: "", date: null, apk: "https://github.com/linlih/folio/releases/download/v0.2.0/folio-android-arm64.apk" });
    vi.spyOn(backend, "downloadUpdate").mockRejectedValue(new Error("the download stopped early"));
    const installer = vi.spyOn(backend, "installUpdate").mockResolvedValue(true);
    const browser = vi.spyOn(backend, "openReleaseDownload").mockResolvedValue();
    const { useUpdates: fresh } = await vi.importActual<typeof import("../src/update/updates")>("../src/update/updates?android-fails");
    try {
      await fresh.getState().check();
      await fresh.getState().install();
      expect(fresh.getState()).toMatchObject({ status: "error", apk: null });
      expect(fresh.getState().error).toContain("stopped early");
      expect(installer).not.toHaveBeenCalled();
      await fresh.getState().openInBrowser();
      expect(browser).toHaveBeenCalledWith(expect.stringContaining("folio-android-arm64.apk"));
    } finally {
      b.kind = kind;
    }
  });
});
