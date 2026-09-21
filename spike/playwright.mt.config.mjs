import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.SPIKE_MT_PORT ?? 5601);

export default defineConfig({
  testDir: ".",
  testMatch: /spike-mt\.spec\.mjs/,
  fullyParallel: false,
  // One at a time: the whole measurement is "how long does this take on this machine",
  // so nothing else may be using the cores.
  workers: 1,
  timeout: 30 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
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
    command: `node server-mt.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index-mt.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
