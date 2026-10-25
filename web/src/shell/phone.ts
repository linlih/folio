import { useSyncExternalStore } from "react";

/** The phone layout (§0.2): one column, a bar at the top, the four
 *  entries at the bottom; no sidebar, tabs or split view. */
export const PHONE_QUERY = "(max-width: 720px)";
/** A finger, not a mouse: no hover, so nothing may appear only on hover,
 *  and long-press stands in for the right click. */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

const media = (query: string) => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null);

function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const m = media(query);
      m?.addEventListener("change", onChange);
      return () => m?.removeEventListener("change", onChange);
    },
    () => media(query)?.matches ?? false,
  );
}

export const usePhone = () => useMedia(PHONE_QUERY);
export const useTouch = () => useMedia(TOUCH_QUERY);
export const isTouch = () => media(TOUCH_QUERY)?.matches ?? false;
