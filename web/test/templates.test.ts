import { describe, expect, it } from "vitest";
import { readTemplates, setTemplate } from "../src/docs/workspace";
import { device, sync } from "./helpers";

describe("templates in the workspace document", () => {
  it("are listed in the order made, and unmarking takes one away", () => {
    const ws = device(1n);
    setTemplate(ws, "b", true, 20);
    setTemplate(ws, "a", true, 10);
    setTemplate(ws, "c", true, 30);
    expect(readTemplates(ws)).toEqual(["a", "b", "c"]);
    setTemplate(ws, "b", false, 40);
    expect(readTemplates(ws)).toEqual(["a", "c"]);
    // Marking again what already is one changes nothing.
    const before = ws.oplogVersion().toJSON().get(ws.peerIdStr);
    setTemplate(ws, "a", true, 50);
    expect(ws.oplogVersion().toJSON().get(ws.peerIdStr)).toBe(before);
  });

  it("sync between devices; the later change wins", () => {
    const a = device(1n);
    const b = device(2n);
    setTemplate(a, "t1", true, 1);
    sync(a, b);
    expect(readTemplates(b)).toEqual(["t1"]);
    setTemplate(b, "t1", false, 2);
    setTemplate(a, "t2", true, 3);
    sync(a, b);
    expect(readTemplates(a)).toEqual(readTemplates(b));
    expect(readTemplates(a)).toContain("t2");
  });
});
