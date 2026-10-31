import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import type { SyncStatus } from "../bindings/commands";
import { backend } from "../platform";

/** This device's sync status, kept current by the host's `sync-status`
 *  events; null where sync is unsupported (web mode). */
export function useSyncStatus(): [SyncStatus | null | undefined, (s: SyncStatus) => void] {
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let gone = false;
    void backend.syncStatus().then((s) => !gone && setStatus(s), () => !gone && setStatus(null));
    if (backend.kind === "tauri") {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen<SyncStatus>("sync-status", (e) => setStatus(e.payload)))
        .then((u) => (gone ? u() : (unlisten = u)));
    }
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
  return [status, setStatus];
}

/** Minimum passphrase length; the host checks it too. */
export const MIN_PASSPHRASE = 8;

/** A sync failure in the interface's language, by its kind (the host's
 *  `kind` in src-tauri/src/sync.rs); null for a kind without wording here. */
function kindText(t: TFunction, kind: string | null): string | null {
  switch (kind) {
    case "network":
      return t("sync.errorNetwork");
    case "unauthorized":
      return t("sync.errorUnauthorized");
    case "removed":
      return t("sync.errorRemoved");
    case "key-missing":
      return t("sync.errorKeyMissing");
    case "wrong-passphrase":
      return t("sync.errorPassphrase");
    case "bad-code":
      return t("sync.errorCode");
    case "no-workspace":
      return t("sync.errorNoWorkspace");
    case "too-large":
      return t("sync.errorFileTooLarge");
    case "server-full":
      return t("sync.errorServerFull");
    case "bad-recovery-code":
      return t("sync.errorRecoveryFormat");
    case "wrong-recovery-code":
      return t("sync.errorRecoveryWrong");
    case "no-recovery-code":
      return t("sync.errorNoRecovery");
    case "old-server":
      return t("sync.errorOldServer");
    case "short-passphrase":
      return t("sync.passphraseShort", { n: MIN_PASSPHRASE });
    default:
      return null;
  }
}

/** The status line's error; the host's own wording only for errors
 *  without a kind of their own. */
export function errorText(t: TFunction, status: { error: string | null; errorKind: string | null }): string {
  return kindText(t, status.errorKind) ?? status.error ?? "";
}

/** A failed sync command ("[network] cannot reach…" from the host) in the
 *  interface's language; untagged or unknown ones as the host put them. */
export function commandErrorText(t: TFunction, e: unknown): string {
  const raw = String(e);
  const tag = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(raw);
  if (!tag) return raw;
  return kindText(t, tag[1]) ?? tag[2];
}
