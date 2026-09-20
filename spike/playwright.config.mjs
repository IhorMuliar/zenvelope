import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.SPIKE_PORT ?? 5599);

export default defineConfig({
  testDir: ".",
  testMatch: /spike\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  // A single-threaded wasm proof under 4x CPU throttling is slow by construction.
  timeout: 30 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    // --enable-precise-memory-info makes performance.memory report real numbers instead
    // of 50MB-quantized ones. SPIKE_MAX_MEM_PAGES caps wasm linear memory (V8 counts
    // 64KiB pages, so 32768 = 2 GB) to see whether the proof fits under a cap.
    launchOptions: {
      args: [
        "--enable-precise-memory-info",
        ...(process.env.SPIKE_MAX_MEM_PAGES
          ? [`--js-flags=--wasm-max-mem-pages=${process.env.SPIKE_MAX_MEM_PAGES}`]
          : []),
      ],
    },
  },
  webServer: {
    command: `node server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
