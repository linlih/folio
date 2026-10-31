import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { backend } from "../platform";
import { goBackFrom } from "./PhoneBars";
import { PHONE_QUERY } from "./phone";
import { focusedPane, useShell } from "./tabs";

/** What is open over the pages: menus and popovers, the image viewer,
 *  search, quick capture and dialogs. Each closes on Escape. */
const OVERLAY = ".popup, .image-viewer, [role='dialog']";

/** Android's Back (button or edge swipe) does what the page's own Back
 *  would, one step at a time: closes what is open over the page, then goes
 *  back to the page this one was opened from (or up a topic in the card
 *  library). Only on a page of the bottom bar does it leave, to the
 *  background as Home would, so coming back finds the app as it was.
 *  Without this the system closes the app at the first Back. */
export function handleAndroidBack() {
  if (!isTauri() || !/android/i.test(navigator.userAgent)) return;
  void onBackButtonPress(() => {
    // A section of the settings: back to their list.
    const settingsBack = document.querySelector<HTMLElement>(".settings-back");
    if (settingsBack) return settingsBack.click();
    if (document.querySelector(OVERLAY)) {
      const at = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      at.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    const s = useShell.getState();
    if (s.dialog) return s.setDialog(null);
    // Tabs (a tablet) are closed by hand, not by Back.
    const pane = focusedPane(s);
    if (pane && matchMedia(PHONE_QUERY).matches && goBackFrom(pane)) return;
    void backend.toBackground();
  }).catch(() => {});
}
