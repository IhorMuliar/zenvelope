/**
 * Spent detection, the screens, on the MOCK core.
 *
 *   npm run build && npx playwright test e2e/spent-mock.spec.ts   # with no wasm build
 *
 * The mock reads no chain, so a link opts into a spent envelope with the marker
 * documented in src/core/mock.ts: a secret starting `spentAll` has its one note
 * already swept, `spentOne` has one of two notes swept. The spend facts are the
 * real M1 sweep's (ba0f91cf… at block 3,491,056). Skipped when a real wasm build is
 * present, like every other MOCK group; e2e/spent-real.spec.ts is the mainnet run.
 */

import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

/** Any 43 base64url characters; the first eight are the mock's marker. */
const TAIL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".slice(8);
const SPENT_ALL = `spentAll${TAIL}`;
const SPENT_ONE = `spentOne${TAIL}`;
const SPEND_TXID = "ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad";

describeOnMock("spent detection: the screens", () => {
  test("an envelope swept before shows as already opened, with nothing to send", async ({
    page,
  }) => {
    await page.goto(`/e#${SPENT_ALL}.3490437`);
    await expect(page.getByTestId("mock-badge")).toBeVisible();
    await page.getByTestId("open-envelope").click();

    await expect(page.getByTestId("already-opened")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This envelope was already opened" }),
    ).toBeVisible();
    await expect(page.getByTestId("spent-when")).toHaveText(
      "Opened in block 3,491,056, on 21 September 2026.",
    );
    await expect(page.getByTestId("spent-txid")).toHaveText("ba0f91cf…60fa2aad");
    await expect(page.getByTestId("spent-explorer")).toHaveAttribute(
      "href",
      `https://mainnet.zcashexplorer.app/transactions/${SPEND_TXID}`,
    );
    await expect(page.getByTestId("spent-received")).toHaveText("It held 0.0013 ZEC.");

    // No amount to reveal and no send-on controls of any kind.
    await expect(page.getByTestId("amount")).toHaveCount(0);
    await expect(page.getByTestId("dest-address")).toHaveCount(0);
    await expect(page.getByTestId("dest-wallet")).toHaveCount(0);
    await expect(page.getByTestId("dest-solana")).toHaveCount(0);
    await expect(page.getByTestId("send-it-on")).toHaveCount(0);
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "spent-already-opened-mock.png"), fullPage: true });
  });

  test("a partly swept envelope opens with what is left and a line about the rest", async ({
    page,
  }) => {
    await page.goto(`/e#${SPENT_ONE}.3490437`);
    await page.getByTestId("open-envelope").click();

    await expect(page.getByTestId("amount")).toHaveText("0.0003 ZEC");
    await expect(page.getByTestId("spent-partial")).toHaveText(
      "Another 0.0013 ZEC was sent to this envelope and has already been moved on. It is not counted above.",
    );
    await expect(page.getByTestId("already-opened")).toHaveCount(0);
    // One note left: the single-note details. At 0.0003 ZEC it is under the
    // service-fee floor, so the page says so instead of offering to send it on.
    await expect(page.getByTestId("height")).toHaveText("3,491,056");
    await expect(page.getByTestId("too-small")).toBeVisible();
    await expect(page.getByTestId("dest-address")).toHaveCount(0);
  });

  test("an unspent envelope says nothing about spends", async ({ page }) => {
    await page.goto(`/e#AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.3490437`);
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
    await expect(page.getByTestId("spent-partial")).toHaveCount(0);
    await expect(page.getByTestId("already-opened")).toHaveCount(0);
  });
});
