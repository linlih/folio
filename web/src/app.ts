// App-wide singletons: the document hub and the app-level undo stack.

import { isTauri } from "@tauri-apps/api/core";
import { createNotesApi, type NotesApi } from "./api";
import { cardsChanged } from "./card/actions";
import { DocHub } from "./docs/hub";
import { DOC_SAVED } from "./docs/persistence";
import { AppUndo } from "./docs/undo";
import i18n from "./i18n";
import { backend } from "./platform";
import { useShell } from "./shell/tabs";

/** How long a document no view shows stays open (DocHub). */
const CLOSE_DELAY_MS = 3000;

export const appUndo = new AppUndo();

let hub: DocHub | null = null;
let api: NotesApi | null = null;

/** The semantic API for commands, plugins and AI (api/index.ts). */
export function notes(): NotesApi {
  if (!api) throw new Error("documents are not started");
  return api;
}

export function docs(): DocHub {
  if (!hub) throw new Error("documents are not started");
  return hub;
}

function reportSaveError(e: unknown) {
  console.error("save failed", e);
  useShell.getState().setNotice(i18n.t("error.saveFailed", { message: String(e) }));
}

/** Creates the hub with this device's frontend peer id and makes sure
 *  pending edits are written when the window is hidden or closed (§5.1). */
export async function startDocs(): Promise<DocHub> {
  const info = await backend.appInfo();
  const h = new DocHub(backend, info.frontendPeer, reportSaveError, Date.now, CLOSE_DELAY_MS);
  hub = h;
  api = createNotesApi(h, backend, info.apiPeer);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void h.flushAll();
  });
  window.addEventListener("pagehide", () => void h.flushAll());
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // The window closes once the handler resolves.
    await getCurrentWindow().onCloseRequested(() => h.flushAll());
    // Another device's changes, applied by the host (§5.3): open editors
    // take them in; lists, titles and backlinks reload.
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string[]>("sync-applied", (e) => {
      void h.refresh(e.payload).then(() => {
        for (const id of e.payload) window.dispatchEvent(new CustomEvent(DOC_SAVED, { detail: { id } }));
        cardsChanged();
      }, reportSaveError);
    });
  }
  return h;
}
