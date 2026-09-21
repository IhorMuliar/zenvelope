/**
 * M4: the core runs in a worker, and on this machine it runs threaded.
 *
 * No secrets, no network and no proving: this is the loader's own proof, and it runs in
 * any checkout that has a wasm build. What it pins down is the part that is easy to get
 * silently wrong — that the page picked the *threaded* package, that rayon really has a
 * pool, and that the page's own main thread is holding no wasm at all.
 *
 *   npm run e2e -- e2e/m4-worker.spec.ts
 */

import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const THREADED_CORE = existsSync(resolve(HERE, "../src/wasm/core-mt/zenvelope_core.js"));

/** A link with no money in it: derivation is pure, so any 43 base64url chars will do. */
const SECRET = "A".repeat(43);

test.describe("M4: the core worker", () => {
  test.skip(!REAL_CORE, "no wasm build under src/wasm/core; run ./scripts/build-core.sh");

  test("the page is cross-origin isolated, which is what threads need", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  });

  test("a spawned core worker answers, and says which package it loaded", async ({ page }) => {
    await page.goto(`/e#${SECRET}`);
    // The sealed screen is only reached once the worker has answered parse_fragment and
    // derive, so getting here at all means the RPC round trip works.
    await expect(page.getByTestId("open-envelope")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("mock-badge")).toHaveCount(0);

    const note = await page.getByTestId("proving-note").innerText();
    console.log(`M4 footer: ${note}`);
    expect(note).toMatch(/^proving: \d+ threads?$/);

    if (THREADED_CORE) {
      // Playwright's chromium on a multi-core host: the threaded package must win.
      expect(note, "the threaded package should have been chosen").toBe("proving: 4 threads");
    }
  });

  test("the page's own main thread never instantiates a core", async ({ page }) => {
    await page.goto(`/e#${SECRET}`);
    await expect(page.getByTestId("open-envelope")).toBeVisible({ timeout: 120_000 });

    // Nothing on window: the wasm module, its exports and its memory all live in the
    // worker, which is the whole point — a proof cannot block what it does not run on.
    const leaked = await page.evaluate(() =>
      ["sweep_envelope", "warm_proving_key", "wasm", "__wbindgen_start"].filter(
        (k) => k in (window as unknown as Record<string, unknown>),
      ),
    );
    expect(leaked).toEqual([]);
  });

  test("a link with no fragment still fails cleanly through the worker", async ({ page }) => {
    await page.goto("/e");
    await expect(page.getByTestId("open-error")).toBeVisible();
  });
});
