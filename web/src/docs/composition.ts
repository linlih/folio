// While an input method composes (pinyin waiting for its characters), the
// document must not change under it: when another device's edit redraws the
// line being composed, WebKit loses the composition, leaving the pinyin as
// text and putting the chosen characters beside it. Changes from elsewhere
// wait for the composition to end.

/** Longest wait: a composition whose end the page never saw (the window
 *  lost focus mid-word, say) holds nothing back for good. */
const MAX_WAIT_MS = 15_000;

let composing = false;
let waiting: (() => void)[] = [];
let tracking = false;

function release() {
  const run = waiting;
  waiting = [];
  for (const f of run) f();
}

/** Starts following compositions anywhere on the page. */
export function trackComposition() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("compositionstart", () => void (composing = true), true);
  document.addEventListener(
    "compositionend",
    () => {
      composing = false;
      // After the editor has read the committed text.
      setTimeout(() => composing || release(), 0);
    },
    true,
  );
}

/** Resolves now, or once the composition in progress is over. */
export function afterComposition(): Promise<void> {
  if (!composing) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      composing = false;
      release();
    }, MAX_WAIT_MS);
    waiting.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
