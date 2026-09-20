// M3 spike: build the Orchard/Ironwood post-NU6.3 proving key and prove one 2-action
// Ironwood bundle, in a single-threaded browser wasm build, and measure it.
//
//   npx playwright test --config playwright.config.mjs
//
// Env:
//   SPIKE_PKGS=pkg-default,pkg-opt   which built packages to exercise
//   SPIKE_RATES=1,4                  CDP CPU throttling rates
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKGS = (process.env.SPIKE_PKGS ?? "pkg-default,pkg-opt").split(",");
const RATES = (process.env.SPIKE_RATES ?? "1,4").split(",").map(Number);

const MB = (b) => (b / 1024 / 1024).toFixed(1);

for (const pkg of PKGS) {
  for (const rate of RATES) {
    test(`${pkg} @ ${rate}x CPU`, async ({ page }) => {
      test.skip(!existsSync(`${HERE}${pkg}`), `${pkg} not built`);

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });

      page.on("console", (m) => console.log(`  [console] ${m.text()}`));
      page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

      await page.goto(`/index.html?pkg=${pkg}`);
      await page.waitForFunction(() => window.spikeReady === true);
      expect(await page.evaluate(() => window.spikeError)).toBeNull();

      const memAfterLoad = await page.evaluate(() => window.spike.mem_bytes());
      const pkMs = await page.evaluate(() => window.spike.build_pk());
      const memAfterPk = await page.evaluate(() => window.spike.mem_bytes());
      const vkMs = await page.evaluate(() => window.spike.build_vk());
      const memAfterVk = await page.evaluate(() => window.spike.mem_bytes());
      const result = JSON.parse(await page.evaluate(() => window.spike.prove_dummy()));
      const memPeak = await page.evaluate(() => window.spike.mem_bytes());
      const jsMem = await page.evaluate(() =>
        performance.memory
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
              jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            }
          : null,
      );

      expect(result.verified).toBe(true);
      expect(result.actions).toBe(2);

      console.log(
        [
          ``,
          `=== ${pkg} @ ${rate}x CPU =============================`,
          `  pk build      : ${pkMs.toFixed(0)} ms`,
          `  vk build      : ${vkMs.toFixed(0)} ms`,
          `  bundle build  : ${result.build_ms.toFixed(0)} ms`,
          `  proof         : ${result.proof_ms.toFixed(0)} ms  (${result.actions} actions, ${result.proof_bytes} proof bytes)`,
          `  verify        : ${result.verify_ms.toFixed(0)} ms  (verified=${result.verified})`,
          `  wasm memory   : load ${MB(memAfterLoad)} MB -> pk ${MB(memAfterPk)} MB -> vk ${MB(memAfterVk)} MB -> proof ${MB(result.mem_after_proof)} MB -> peak ${MB(memPeak)} MB (${memPeak} bytes)`,
          `  over 1GB/2GB/4GB: ${memPeak > 2 ** 30}/${memPeak > 2 ** 31}/${memPeak > 2 ** 32}`,
          `  performance.memory: ${jsMem ? `used ${MB(jsMem.usedJSHeapSize)} MB, total ${MB(jsMem.totalJSHeapSize)} MB, limit ${MB(jsMem.jsHeapSizeLimit)} MB` : "unavailable"}`,
          `=====================================================`,
        ].join("\n"),
      );
    });
  }
}
