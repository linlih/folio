import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // YPM_PATCH=1 swaps in y-prosemirror with a one-line fix for the
    // NodeSelection crash (patches/y-prosemirror), to see what remains.
    alias: process.env.YPM_PATCH ? { "y-prosemirror": resolve(__dirname, "patches/y-prosemirror/y-prosemirror.js") } : {},
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 3 * 60 * 60 * 1000, // the one-year growth bench is slow by nature
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
