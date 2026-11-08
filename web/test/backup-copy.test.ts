import { describe, expect, it } from "vitest";
import type { BackupCopyStatus, SyncStatus } from "../src/bindings/commands";
import { copyStatusLines, offsiteLines } from "../src/backup/BackupCopy";

// Keys and values instead of translated text.
const t = (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key);
const when = (ms: number) => `@${ms}`;
const base: BackupCopyStatus = {
  path: "/Volumes/Drive",
  copyPath: "/Volumes/Drive/Folio Backup",
  available: true,
  owner: "ours",
  encrypted: false,
  locked: false,
  sameDisk: false,
  running: false,
  lastOk: null,
  lastError: null,
  lastErrorAt: null,
  skippedFiles: 0,
  size: null,
};
const keys = (s: Partial<BackupCopyStatus>) => copyStatusLines({ ...base, ...s }, t, when).map((l) => (l.warn ? "!" : "") + l.text.split(" ")[0]);

describe("the backup copy's status lines", () => {
  it("say nothing when no copy is made", () => {
    expect(keys({ path: null })).toEqual([]);
  });

  it("tell how the last copy went", () => {
    expect(keys({})).toEqual(["backup.copy.never"]);
    expect(keys({ lastOk: 5 })).toEqual(["backup.copy.doneAt"]);
    const done = copyStatusLines({ ...base, lastOk: 5, size: { backups: 14, files: 3, bytes: 3 << 20 } }, t, when);
    expect(done[0].text).toContain('"backups":14');
    expect(done[0].text).toContain('"size":"3.0 MB"');
    expect(keys({ running: true, lastOk: 5 })).toEqual(["backup.copy.running"]);
    const big = copyStatusLines({ ...base, lastOk: 5, size: { backups: 14, files: 300, bytes: 1.2 * 2 ** 30 } }, t, when);
    expect(big[0].text).toContain('"size":"1.2 GB"');
  });

  it("warn about a missing drive without hiding when it last worked", () => {
    expect(keys({ available: false, lastOk: 5, lastError: "unavailable" })).toEqual(["!backup.copy.unavailable", "backup.copy.doneAt"]);
    // Never "not copied yet" for a drive that is not there to copy to.
    expect(keys({ available: false })).toEqual(["!backup.copy.unavailable"]);
  });

  it("refuse another library's folder, and show real failures", () => {
    expect(keys({ owner: "other" })).toEqual(["!backup.copy.foreign"]);
    expect(keys({ lastError: "disk full", lastOk: 5 })).toEqual(["!backup.copy.failed", "backup.copy.doneAt"]);
  });

  it("keep standing warnings: damaged files, the same disk", () => {
    expect(keys({ lastOk: 5, skippedFiles: 2, sameDisk: true })).toEqual(["backup.copy.doneAt", "!backup.copy.skipped", "!backup.copy.sameDisk"]);
  });

  it("ask for the passphrase of a copy this computer has no key for", () => {
    expect(keys({ encrypted: true, locked: true, lastError: "locked" })).toEqual(["!backup.copy.locked"]);
    expect(keys({ encrypted: true, locked: true, lastOk: 5 })).toEqual(["!backup.copy.locked", "backup.copy.doneAt"]);
    expect(keys({ lastError: "mode", lastOk: 5 })).toEqual(["!backup.copy.mode", "backup.copy.doneAt"]);
  });
});

describe("the copies off this computer", () => {
  const sync = { enabled: true, lastSync: 9, pending: 0, filesUp: 0, error: null } as SyncStatus;
  const off = (s: SyncStatus | null | undefined, c: Partial<BackupCopyStatus> | null) =>
    offsiteLines(s, c && { ...base, ...c }, t, when).map((l) => (l.warn ? "!" : "") + l.text.split(" ")[0]);

  it("count the sync server as one", () => {
    expect(off(sync, null)).toEqual(["backup.offsite.sync", "backup.offsite.syncNote"]);
    expect(off({ ...sync, pending: 3 }, null)).toEqual(["backup.offsite.sync", "backup.offsite.syncPending", "backup.offsite.syncNote"]);
    expect(off({ ...sync, lastSync: null }, null)[0]).toBe("!backup.offsite.syncNever");
    expect(off({ ...sync, error: "offline" }, null)[0]).toBe("!backup.offsite.syncFailing");
  });

  it("warn when there is none", () => {
    expect(off(null, null)).toEqual(["!backup.offsite.none"]);
    expect(off({ ...sync, enabled: false }, { path: null })).toEqual(["!backup.offsite.none"]);
    // Another library's folder is no copy of this one.
    expect(off(null, { owner: "other" })).toEqual(["!backup.offsite.none"]);
    expect(off(null, {})).toEqual([]);
    // Not known yet: say nothing rather than warn wrongly.
    expect(off(undefined, null)).toEqual([]);
  });
});
