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

/** The sync error in the interface's language; the host's own wording
 *  only for errors without a kind of their own. */
export function errorText(t: TFunction, status: Pick<SyncStatus, "error" | "errorKind">): string {
  switch (status.errorKind) {
    case "network":
      return t("sync.errorNetwork");
    case "unauthorized":
      return t("sync.errorUnauthorized");
    case "removed":
      return t("sync.errorRemoved");
    default:
      return status.error ?? "";
  }
}
