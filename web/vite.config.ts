/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  // Tauri loads the dev server on this port (src-tauri/tauri.conf.json devUrl).
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  build: { target: "es2022" },
  // loro-crdt ships wasm, which the dependency optimizer cannot pre-bundle.
  optimizeDeps: { exclude: ["loro-crdt"] },
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    // Known: undoing back past a new line, Loro's own deferred work (not a
    // callback of ours) fails looking up the tree root and throws outside any
    // test; contents and cursor come back right (test/cursor-mapping.test.ts).
    // Only that message is let through, so any other stray error still fails.
    onUnhandledError: (error) => !/TreeID\(2147483647@18446744073709551615\) not found/.test(error.message ?? ""),
  },
});
