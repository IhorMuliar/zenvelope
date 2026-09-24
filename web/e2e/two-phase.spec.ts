/**
 * Two-phase open, the screens, on the MOCK core.
 *
 *   npm run build && npx playwright test e2e/two-phase.spec.ts   # with no wasm build
 *
 * A final link carries the block the note sits in, so the core reveals the note
 * after reading that one block and then walks to the tip checking only for its
 * spend. The mock does the same when the link's birthday is its note's height
 * (3,490,472). Skipped when a real wasm build is present, like every other MOCK
 * group; e2e/two-phase-real.spec.ts is the mainnet run.
 */

import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const NOTE_HEIGHT = 3490472;

describeOnMock("two-phase open: reveal first, then verify", () => {
  test("a final link shows the amount at once and unlocks sending after the check", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/e#${SECRET}.${NOTE_HEIGHT}`);
    await expect(page.getByTestId("mock-badge")).toBeVisible();
    const t0 = Date.now();
    await page.getByTestId("open-envelope").click();

    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC", { timeout: 2000 });
    const revealMs = Date.now() - t0;
    expect(revealMs).toBeLessThan(2000);

    // Checking: the line under the amount, and no way to send yet.
    await expect(page.getByTestId("spend-check")).toContainText("Checking it hasn't been opened…");
    await expect(page.getByTestId("spend-check")).toContainText(/block [\d,]+ of [\d,]+/);
    await expect(page.getByTestId("send-on-disabled")).toBeDisabled();
    await expect(page.getByTestId("dest-address")).toHaveCount(0);
    await expect(page.getByTestId("memo")).toHaveText("Zenvelope M1");
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "two-phase-checking-mock.png"), fullPage: true });

    // The walk ends: the check line goes, the send-on flow arrives.
    await expect(page.getByTestId("dest-address")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("spend-check")).toHaveCount(0);
    await expect(page.getByTestId("send-on-waiting")).toHaveCount(0);
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
    expect(errors).toEqual([]);
  });

  test("a final link to a swept envelope reveals, then switches to already opened", async ({
    page,
  }) => {
    await page.goto(`/e#spentAll${SECRET.slice(8)}.${NOTE_HEIGHT}`);
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC", { timeout: 2000 });
    await expect(page.getByTestId("send-on-disabled")).toBeDisabled();
    await expect(page.getByTestId("already-opened")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("amount")).toHaveCount(0);
    await expect(page.getByTestId("dest-address")).toHaveCount(0);
  });

  test("an original link keeps the one-phase scan", async ({ page }) => {
    await page.goto(`/e#${SECRET}.3490437`);
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("scanning")).toBeVisible();
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC", { timeout: 10_000 });
    await expect(page.getByTestId("spend-check")).toHaveCount(0);
    await expect(page.getByTestId("dest-address")).toBeVisible();
  });
});
