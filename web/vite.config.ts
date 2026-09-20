import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// COOP/COEP so SharedArrayBuffer (and therefore WASM threads) are available in
// dev, matching public/_headers in production.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    // The wasm-bindgen glue must not be pre-bundled: esbuild would break its
    // import.meta.url handling for the .wasm asset.
    exclude: ["zenvelope-core", "@zenvelope/core"],
    esbuildOptions: { target: "esnext" },
  },
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
