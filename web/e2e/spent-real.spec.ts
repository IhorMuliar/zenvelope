/**
 * Spent detection, end to end, on the real core and mainnet.
 *
 *   ./scripts/build-core.sh && cd web && npm run build
 *   ZENV_FIXTURE_DIR=/path/holding/M1-FUND.md+M3-DEST.md \
 *   ZENVELOPE_E2E_PORT=4261 npx playwright test e2e/spent-real.spec.ts
 *
 * (or ZENV_SWEPT_FRAGMENT / ZENV_FEE_FRAGMENT directly; see e2e/fixtures.ts). Both
 * fragments are the money, so they are read at run time, never committed and never
 * printed, and each test skips without its fragment.
 *
 * What it proves:
 *   - the day-one M1 envelope, funded at block 3,490,472 and swept in ba0f91cf… at
 *     block 3,491,056, opens to "This envelope was already opened": the spend's
 *     block, its txid and an explorer link, and no amount and no send-on controls
 *   - the fee envelope, unspent, still opens normally with 0.0003 ZEC and the
 *     send-on flow, and nothing on it says anything was spent
 *
 * It NEVER broadcasts: the page is loaded with `?dry=1`, and neither test gets as
 * far as a sweep anyway.
 *
 * `ZENV_TIMING_RUNS=3` repeats the fee-envelope open and prints each wall time, tap
 * to amount, which is how the cost of the nullifier check was measured (see
 * web/docs/M2-VERIFICATION.md, "Spent detection").
 */

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feeEnvelopeFragment, sweptM1Fragment } from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

const SWEPT = sweptM1Fragment();
const FEE = feeEnvelopeFragment();
const RUNS = Math.max(1, Number(process.env.ZENV_TIMING_RUNS ?? 1));

const M1_SPEND = {
  txid: "ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad",
  height: "3,491,056",
};

/** Loads the open page on the real core and taps Open. Returns the tap time. */
async function openOnRealCore(page: Page, fragment: string): Promise<number> {
  const secret = fragment.split(".")[0];
  // A fresh document every time: going from /e#x to /e#x is only a hash change,
  // and the page reads the fragment once, at load.
  await page.goto("about:blank");
  await page.goto(`/e?dry=1#${fragment}`);
  await expect(page.getByTestId("open-envelope")).toBeVisible({ timeout: 60_000 });
  // The real wasm, not the MOCK.
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  // H1 still holds: the secret left the URL bar before anything else happened.
  expect(page.url()).not.toContain(secret);
  const t0 = Date.now();
  await page.getByTestId("open-envelope").click();
  return t0;
}

test.describe("spent detection on mainnet", () => {
  test.setTimeout(300_000);

  test("the swept M1 envelope says it was already opened", async ({ page }) => {
    test.skip(!SWEPT, "no M1 fragment: set ZENV_SWEPT_FRAGMENT or ZENV_FIXTURE_DIR");
    const t0 = await openOnRealCore(page, SWEPT!);

    await expect(page.getByTestId("already-opened")).toBeVisible({ timeout: 180_000 });
    const seconds = (Date.now() - t0) / 1000;
    console.log(`M1 envelope: already-opened screen in ${seconds.toFixed(1)} s`);

    await expect(
      page.getByRole("heading", { name: "This envelope was already opened" }),
    ).toBeVisible();
    await expect(page.getByTestId("spent-when")).toContainText(`block ${M1_SPEND.height}`);
    await expect(page.getByTestId("spent-when")).toContainText("2026");
    await expect(page.getByTestId("spent-txid")).toHaveText(/^ba0f91cf…[0-9a-f]{8}$/);
    await expect(page.getByTestId("spent-explorer")).toHaveAttribute(
      "href",
      new RegExp(`${M1_SPEND.txid}$`),
    );
    await expect(page.getByTestId("spent-received")).toHaveText("It held 0.0013 ZEC.");

    // Nothing to send, so nothing offers to send it.
    await expect(page.getByTestId("amount")).toHaveCount(0);
    await expect(page.getByTestId("dest-address")).toHaveCount(0);
    await expect(page.getByTestId("dest-wallet")).toHaveCount(0);
    await expect(page.getByTestId("dest-solana")).toHaveCount(0);
    await expect(page.getByTestId("send-it-on")).toHaveCount(0);
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "spent-already-opened-real.png"), fullPage: true });
  });

  test("the unspent fee envelope still opens with 0.0003 ZEC", async ({ page }) => {
    test.skip(!FEE, "no fee-envelope fragment: set ZENV_FEE_FRAGMENT or ZENV_FIXTURE_DIR");
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const t0 = await openOnRealCore(page, FEE!);
      await expect(page.getByTestId("amount")).toHaveText("0.0003 ZEC", { timeout: 180_000 });
      times.push((Date.now() - t0) / 1000);

      await expect(page.getByTestId("already-opened")).toHaveCount(0);
      await expect(page.getByTestId("spent-partial")).toHaveCount(0);
      await expect(page.getByTestId("dest-address")).toBeVisible();
    }
    console.log(
      `fee envelope open, tap to amount: ${times.map((t) => `${t.toFixed(1)} s`).join(", ")}`,
    );
  });
});
