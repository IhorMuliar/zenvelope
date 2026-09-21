// M4 spike: the same Ironwood proving-key build and 2-action bundle proof as
// spike.spec.mjs, but from a wasm built with atomics + a wasm-bindgen-rayon thread pool.
//
//   npx playwright test --config playwright.mt.config.mjs
//
// Env:
//   SPIKE_MT_THREADS=1,4,0   thread counts to ask initThreadPool for (0 = never call it)
//   SPIKE_RATES=1,4          CDP CPU throttling rates
//   SPIKE_MT_PKG=pkg-mt      which built package to load
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { test, expect } from "@playwright/test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = process.env.SPIKE_MT_PKG ?? "pkg-mt";
const HW = cpus().length;
const THREADS = (process.env.SPIKE_MT_THREADS ?? `1,4,${HW}`)
  .split(",")
  .map((t) => (t.trim() === "hw" ? HW : Number(t)));
const RATES = (process.env.SPIKE_RATES ?? "1,4").split(",").map(Number);

const MB = (b) => (b / 1024 / 1024).toFixed(1);

/** Drives one page through load -> pool -> pk -> vk -> proof and prints the row. */
async function run(page, { threads, rate, path, label }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });

  page.on("console", (m) => console.log(`  [console] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.goto(`${path}?pkg=${PKG}&threads=${threads}`);
  await page.waitForFunction(() => window.spikeReady === true, null, {
    timeout: 120_000,
  });

  const env = await page.evaluate(() => ({
    coi: window.spikeCOI,
    sab: window.spikeSAB,
    hw: window.spikeHW,
    stage: window.spikeStage,
    error: window.spikeError,
    poolMs: window.spikePoolMs,
    threads: window.spikeThreads,
  }));
  return { env, cdp };
}

for (const threads of THREADS) {
  for (const rate of RATES) {
    test(`${PKG} ${threads} threads @ ${rate}x CPU`, async ({ page }) => {
      test.skip(!existsSync(`${HERE}${PKG}`), `${PKG} not built`);

      const { env } = await run(page, { threads, rate, path: "/index-mt.html" });
      expect(env.error, `page failed at stage ${env.stage}: ${env.error}`).toBeNull();
      expect(env.coi, "page must be cross-origin isolated").toBe(true);
      expect(env.threads).toBe(threads);

      const memAfterLoad = await page.evaluate(() => window.spike.mem_bytes());
      const pkMs = await page.evaluate(() => window.spike.build_pk());
      const memAfterPk = await page.evaluate(() => window.spike.mem_bytes());
      const vkMs = await page.evaluate(() => window.spike.build_vk());
      const memAfterVk = await page.evaluate(() => window.spike.mem_bytes());
      const result = JSON.parse(await page.evaluate(() => window.spike.prove_dummy()));
      const memPeak = await page.evaluate(() => window.spike.mem_bytes());

      expect(result.verified).toBe(true);
      expect(result.actions).toBe(2);

      console.log(
        [
          ``,
          `=== ${PKG} ${threads} threads @ ${rate}x CPU ====================`,
          `  crossOriginIsolated: ${env.coi}  SharedArrayBuffer: ${env.sab}  hardwareConcurrency: ${env.hw}`,
          `  pool spawn    : ${env.poolMs === null ? "n/a" : `${env.poolMs.toFixed(0)} ms`}  (rayon reports ${env.threads} threads)`,
          `  pk build      : ${pkMs.toFixed(0)} ms`,
          `  vk build      : ${vkMs.toFixed(0)} ms`,
          `  bundle build  : ${result.build_ms.toFixed(0)} ms`,
          `  proof         : ${result.proof_ms.toFixed(0)} ms  (${result.actions} actions, ${result.proof_bytes} proof bytes)`,
          `  verify        : ${result.verify_ms.toFixed(0)} ms  (verified=${result.verified})`,
          `  wasm memory   : load ${MB(memAfterLoad)} -> pk ${MB(memAfterPk)} -> vk ${MB(memAfterVk)} -> proof ${MB(result.mem_after_proof)} -> peak ${MB(memPeak)} MB (${memPeak} bytes)`,
          `  TSV\t${PKG}\t${threads}\t${rate}\t${pkMs.toFixed(0)}\t${vkMs.toFixed(0)}\t${result.proof_ms.toFixed(0)}\t${memPeak}`,
          `=====================================================`,
        ].join("\n"),
      );
    });
  }
}

// The interesting negative: the identical wasm on a page with no COOP/COEP, i.e. what a
// Safari user (or any browser behind a host that will not send the headers) gets.
test(`${PKG} on a page that is NOT cross-origin isolated`, async ({ page }) => {
  test.skip(!existsSync(`${HERE}${PKG}`), `${PKG} not built`);

  const { env } = await run(page, { threads: 4, rate: 1, path: "/plain/index-mt.html" });

  console.log(
    [
      ``,
      `=== ${PKG} WITHOUT COOP/COEP =========================`,
      `  crossOriginIsolated: ${env.coi}  SharedArrayBuffer: ${env.sab}`,
      `  stage reached      : ${env.stage}`,
      `  error              : ${env.error ?? "(none)"}`,
      `  rayon threads      : ${env.threads}`,
      `=====================================================`,
    ].join("\n"),
  );

  expect(env.coi).toBe(false);
});
