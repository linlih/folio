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
  },
});
