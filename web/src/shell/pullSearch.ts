// Pulling the journal down from its top opens search (phones), as in
// iOS's Notes and Mail; the search button in the top bar does the same.

import { useEffect, type RefObject } from "react";
import i18n from "../i18n";
import { useShell } from "./tabs";

/** How far to pull (px) before letting go opens search. */
const PULL = 64;

/** While pulled, `hint` (an element over the page's top) grows and says
 *  whether letting go will open search. */
export function usePullToSearch(page: RefObject<HTMLElement | null>, hint: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const view = page.current?.closest<HTMLElement>(".view");
    const el = hint.current;
    if (!enabled || !view || !el) return;
    let start: number | null = null;
    let pulled = 0;
    const show = (px: number) => {
      pulled = px;
      el.style.height = `${px}px`;
      el.dataset.ready = String(px >= PULL);
      el.querySelector("span")!.textContent = i18n.t(px >= PULL ? "phone.releaseSearch" : "phone.pullSearch");
    };
    const down = (e: TouchEvent) => {
      // Not while writing (the keyboard is up) or from the very top already scrolled.
      start = e.touches.length === 1 && view.scrollTop <= 0 && !document.body.classList.contains("phone-typing") ? e.touches[0].clientY : null;
    };
    const move = (e: TouchEvent) => {
      if (start === null) return;
      const dy = e.touches[0].clientY - start;
      if (dy <= 0 || view.scrollTop > 0) {
        if (pulled) show(0);
        return;
      }
      // Resistance: the hint grows slower than the finger moves.
      show(Math.min(PULL * 1.5, dy * 0.5));
    };
    const up = () => {
      if (start !== null && pulled >= PULL) useShell.getState().setSearchOpen(true);
      start = null;
      if (pulled) show(0);
    };
    view.addEventListener("touchstart", down, { passive: true });
    view.addEventListener("touchmove", move, { passive: true });
    view.addEventListener("touchend", up);
    view.addEventListener("touchcancel", up);
    return () => {
      view.removeEventListener("touchstart", down);
      view.removeEventListener("touchmove", move);
      view.removeEventListener("touchend", up);
      view.removeEventListener("touchcancel", up);
    };
  }, [page, hint, enabled]);
}
