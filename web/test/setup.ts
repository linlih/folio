// jsdom has no layout. ProseMirror only needs these to not throw when it
// scrolls the selection into view.
const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
Element.prototype.getClientRects = emptyRects;
document.elementFromPoint = () => null;

// The editor binding reports dropped content and failed loads with
// console.error from inside timers, where a thrown error would not reach the
// test. Any such report fails the test.
import { afterEach, beforeEach, expect, vi } from "vitest";
import { initI18n } from "../src/i18n";

// UI strings as in the app (placeholders, popup labels).
await initI18n("en");

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
// The binding logs this when it cannot map a selection to a Loro cursor
// (for undo's cursor restore) right after content was replaced; it loses no
// content.
const BENIGN = ["Cannot find the loroNode"];

afterEach(() => {
  vi.restoreAllMocks();
  expect(errors.map((e) => e.map(String).join(" ")).filter((m) => !BENIGN.includes(m))).toEqual([]);
});
