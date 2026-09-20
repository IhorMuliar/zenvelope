import { defineConfig } from "@playwright/test";

/**
 * The M1 end-to-end proof runs against the production build served by `vite preview`,
 * because that is the build where the .wasm is a real emitted asset and where the
 * COOP/COEP headers are the ones production sends.
 */
const PORT = Number(process.env.ZENVELOPE_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
