import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  // Tauri loads the dev server on this port (spike/tauri/src-tauri/tauri.conf.json).
  // The perf page loads the one-year card blobs from spike/results/blobs.
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname, "..")] } },
  define: { __RESULTS_DIR__: JSON.stringify(resolve(__dirname, "../results")) },
  build: { target: "esnext", reportCompressedSize: true },
  optimizeDeps: { exclude: ["loro-crdt"] },
});
