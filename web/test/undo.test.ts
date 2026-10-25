import { describe, expect, it } from "vitest";
import { AppUndo } from "../src/docs/undo";

describe("app undo", () => {
  it("undoes and redoes groups in order", async () => {
    const stack = new AppUndo();
    const log: string[] = [];
    const group = (n: string) => ({ label: n, undo: async () => void log.push(`undo ${n}`), redo: async () => void log.push(`redo ${n}`) });
    stack.push(group("a"));
    stack.push(group("b"));
    expect(await stack.undo()).toBe(true);
    expect(await stack.undo()).toBe(true);
    expect(await stack.undo()).toBe(false);
    expect(await stack.redo()).toBe(true);
    expect(log).toEqual(["undo b", "undo a", "redo a"]);
  });

  it("a new action clears what could be redone", async () => {
    const stack = new AppUndo();
    const noop = { label: "x", undo: async () => {}, redo: async () => {} };
    stack.push(noop);
    await stack.undo();
    stack.push(noop);
    expect(await stack.redo()).toBe(false);
  });
});
