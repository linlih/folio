import { create } from "zustand";
import { docs } from "../app";
import { backend } from "../platform";

/** Updates from the project's GitHub Releases (design/ARCHITECTURE.md §7.3).
 *  On the desktop the updater plugin downloads, checks the signature and
 *  installs; on Android the app only learns of a new version and opens its
 *  APK; iOS updates come from the App Store. */

export const AUTO_SETTING = "update.auto";
export const LAST_CHECK_SETTING = "update.lastCheck";
export const SKIPPED_SETTING = "update.skipped";
const DAY = 24 * 60 * 60 * 1000;
/** After start-up, so checking never slows opening the app. */
const FIRST_CHECK_DELAY = 8000;

/** Whether `candidate` is a later version than `current` (1.10.0 > 1.9.3;
 *  a release beats its pre-releases, 1.0.0 > 1.0.0-beta.2). */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

export interface FoundUpdate {
  version: string;
  notes: string;
  date: string | null;
  /** "install": the app installs it itself; "download": the system does
   *  (Android opens the APK from `url`). */
  how: "install" | "download";
  url?: string;
}

export type UpdateStatus = "idle" | "unsupported" | "checking" | "uptodate" | "available" | "downloading" | "restarting" | "error";

interface UpdateState {
  status: UpdateStatus;
  found: FoundUpdate | null;
  /** 0–1 while downloading, when the size is known. */
  progress: number | null;
  error: string | null;
  /** The prompt is up (a quiet check of a skipped version keeps it down). */
  prompt: boolean;
  check(opts?: { silent?: boolean }): Promise<void>;
  install(): Promise<void>;
  later(): void;
  skip(): Promise<void>;
}

type Pending = { downloadAndInstall(onEvent: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void> };
/** The desktop updater's handle on the found release. */
let pending: Pending | null = null;

let platform: Promise<string> | null = null;
const currentPlatform = () => (platform ??= backend.appInfo().then((i) => i.platform, () => "web"));
const DESKTOP = new Set(["macos", "windows", "linux"]);

async function skipped(): Promise<string[]> {
  const v = await backend.getLocalSetting<string[]>(SKIPPED_SETTING).catch(() => null);
  return Array.isArray(v) ? v : [];
}

export const useUpdates = create<UpdateState>((set, get) => ({
  status: "idle",
  found: null,
  progress: null,
  error: null,
  prompt: false,

  async check({ silent = false } = {}) {
    if (get().status === "checking" || get().status === "downloading") return;
    const where = await currentPlatform();
    if (backend.kind !== "tauri" || !(DESKTOP.has(where) || where === "android")) {
      set({ status: "unsupported" });
      return;
    }
    set({ status: "checking", error: null });
    try {
      let found: FoundUpdate | null = null;
      if (DESKTOP.has(where)) {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        pending = update;
        if (update) found = { version: update.version, notes: update.body ?? "", date: update.date ?? null, how: "install" };
      } else {
        const [latest, info] = await Promise.all([backend.latestRelease(), backend.appInfo()]);
        if (isNewer(latest.version, info.version)) found = { version: latest.version, notes: latest.notes, date: latest.date, how: "download", url: latest.apk };
      }
      void backend.setLocalSetting(LAST_CHECK_SETTING, Date.now()).catch(() => {});
      // A version the user chose to skip is not offered again unasked.
      const quiet = silent && found !== null && (await skipped()).includes(found.version);
      set({ status: found ? "available" : "uptodate", found, prompt: found !== null && !quiet });
    } catch (e) {
      console.warn("update check failed", e);
      // A quiet check that fails (offline) says nothing.
      set({ status: silent ? "idle" : "error", error: String(e) });
    }
  },

  async install() {
    const { found } = get();
    if (!found) return;
    if (found.how === "download") {
      if (found.url) await backend.openReleaseDownload(found.url);
      set({ prompt: false });
      return;
    }
    if (!pending) return;
    set({ status: "downloading", progress: null, error: null });
    try {
      // Everything typed is saved before the app goes away (Windows quits
      // it to run the installer).
      await docs().flushAll();
      let total = 0;
      let got = 0;
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data?.contentLength ?? 0;
        if (e.event === "Progress") {
          got += e.data?.chunkLength ?? 0;
          if (total > 0) set({ progress: Math.min(1, got / total) });
        }
      });
      set({ status: "restarting" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },

  later() {
    set({ prompt: false });
  },

  async skip() {
    const { found } = get();
    set({ prompt: false });
    if (found) await backend.setLocalSetting(SKIPPED_SETTING, [...(await skipped()), found.version]).catch(() => {});
  },
}));

/** Checks quietly once a day: soon after start-up, then hourly whether a
 *  day has passed. Off when the user turned automatic checks off. */
export function startUpdateChecks(): () => void {
  if (backend.kind !== "tauri") return () => {};
  const due = async () => {
    if ((await backend.getLocalSetting<boolean>(AUTO_SETTING).catch(() => null)) === false) return;
    const last = await backend.getLocalSetting<number>(LAST_CHECK_SETTING).catch(() => null);
    if (typeof last === "number" && Date.now() - last < DAY) return;
    await useUpdates.getState().check({ silent: true });
  };
  const first = setTimeout(() => void due(), FIRST_CHECK_DELAY);
  const hourly = setInterval(() => void due(), 60 * 60 * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
