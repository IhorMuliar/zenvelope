/**
 * M2 end-to-end proof: opening an envelope.
 *
 *   npm run e2e                                   # the screen flow, on the MOCK core
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' npm run e2e   # and the real mainnet envelope
 *
 * Two groups, and only one of them can be meaningful in a given checkout.
 *
 * 1. The MOCK group proves the screen flow without a network or a wasm build: the MOCK
 *    simulates a four-second scan and hands back one note of 130000 zatoshi with the
 *    memo "Zenvelope M1". It is skipped when a real wasm build is present, because then
 *    the page is on the real core and its made-up secret would scan mainnet for nothing.
 *
 * 2. The real group drives the same page on the real core against the funded M1
 *    envelope. The fragment is the money, so it is never committed and never printed:
 *    it comes from ZENV_M1_FRAGMENT at run time, and the group skips without it.
 *
 * What the MOCK group proves:
 *   - /e#<fragment> shows the sealed envelope, with the sender's message hidden
 *   - tapping "Open envelope" shows scan progress driven by on_progress
 *   - the amount reads 0.0013 ZEC and the memo is shown as the sender's message
 *   - the fiat equivalent is behind a tap and never a price request
 *   - the M3 destination cards are live, with the Solana rail still disabled
 *   - no link on the page carries the secret fragment onward
 *   - a link with no fragment gets a friendly error and never scans
 */

import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

/** Any valid secret: 43 base64url chars, plus a birthday height. */
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FRAGMENT = `${SECRET}.3490437`;

/** A real wasm build puts the page on the real core, and the MOCK group off. */
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

describeOnMock("M2: opening an envelope", () => {
  test("seals, scans, and unwraps", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.goto(`/e#${FRAGMENT}`);

    // 1. Sealed: an envelope, one button, and no amount or message yet.
    await expect(page.getByRole("heading", { name: "You have an envelope" })).toBeVisible();
    await expect(page.getByTestId("envelope")).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("open-fineprint")).toHaveText(
      "Opening scans the Zcash chain from your browser. Nothing leaves this page.",
    );
    await expect(page.getByText("Zenvelope M1")).toHaveCount(0);
    await expect(page.getByTestId("amount")).toHaveCount(0);
    // The MOCK core must be loudly badged.
    await expect(page.getByTestId("mock-badge")).toBeVisible();

    // 2. Progress, driven by on_progress.
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("scanning")).toBeVisible();
    await expect(page.getByTestId("scan-bar")).toBeVisible();
    await expect(page.getByTestId("scan-progress")).toHaveText(/Starting the scan|^block /);
    await expect(page.getByTestId("scan-progress")).toHaveText(/^block [\d,]+ of [\d,]+$/);

    // 3. Found: the amount, then the sender's message.
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
    await expect(page.getByTestId("memo")).toHaveText("Zenvelope M1");
    await expect(page.getByTestId("envelope")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("pool")).toHaveText("shielded (Ironwood)");
    await expect(page.getByTestId("height")).toHaveText("3,490,472");
    await expect(page.getByTestId("txid")).toHaveText(/^[0-9a-f]{8}…[0-9a-f]{8}$/);

    // All three destination cards are live from M5. The shielded flows are
    // proved in m3-open.spec.ts and the Solana exit in m5-solana.spec.ts; here
    // it is only that the third one still leads with what it costs you.
    await expect(page.getByTestId("dest-address")).toBeEnabled();
    await expect(page.getByTestId("dest-wallet")).toBeEnabled();
    await expect(page.getByTestId("dest-solana")).toBeEnabled();
    await expect(page.getByTestId("dest-solana")).toContainText("leaves the shielded pool");

    // The amount slides in on a delay: wait for the unwrap to settle, so the
    // screenshot is of the finished screen and not of a frame mid-animation.
    await expect(page.getByTestId("amount")).toHaveCSS("opacity", "1");
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m2-open.png"), fullPage: true });

    // The fiat equivalent is behind a tap, and it is not a price request.
    await expect(page.getByTestId("fiat-answer")).toHaveCount(0);
    await page.getByTestId("fiat").click();
    await expect(page.getByTestId("fiat-answer")).toContainText("0.0013 ZEC");

    // Drainer copy is banned product-wide.
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");

    // The secret goes nowhere: not into a link, not into a request.
    const hrefs = await page.locator("a[href]").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    for (const href of hrefs) expect(href).not.toContain(SECRET);
    for (const url of requests) expect(url).not.toContain(SECRET);
  });

  test("shows a friendly error and never scans without a fragment", async ({ page }) => {
    await page.goto("/e");
    await expect(page.getByRole("heading", { name: "We could not read this link" })).toBeVisible();
    await expect(page.getByTestId("open-error")).toContainText("This link has no envelope in it");
    await expect(page.getByTestId("open-envelope")).toHaveCount(0);
    await expect(page.getByTestId("scan-bar")).toHaveCount(0);
    await expect(page.getByTestId("envelope")).toHaveCount(0);
  });

  test("unwraps with animations off when motion is reduced", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/e#${FRAGMENT}`);
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
    const animations = await page
      .getByTestId("envelope")
      .evaluate((el) => el.getAnimations({ subtree: true }).length);
    expect(animations).toBe(0);
  });
});

/**
 * The note the zcash-devtool oracle sees for the funded M1 envelope. See M1-FUND.md
 * (private, gitignored). The memo is absent: M1 was funded from a ZIP-321 `message=`,
 * which the sending wallet keeps as a local label and never writes into the note. That
 * finding is what moved the create flow to `memo=`.
 */
const M1 = {
  amount: "0.0013 ZEC",
  pool: "shielded (Ironwood)",
  height: "3,490,472",
  txidPrefix: "281e9f7b",
};

const M1_FRAGMENT = process.env.ZENV_M1_FRAGMENT;

test.describe("M2: opening the funded mainnet envelope on the real core", () => {
  test.skip(
    !M1_FRAGMENT,
    "ZENV_M1_FRAGMENT is not set; this test needs the funded M1 link secret",
  );
  test.skip(!REAL_CORE, "no wasm build under src/wasm/core; run ./scripts/build-core.sh");

  // A cold scan of mainnet over the public gRPC-web gateway.
  test.setTimeout(180_000);

  test("opens it in the browser and shows the real amount", async ({ page }) => {
    const fragment = M1_FRAGMENT!.trim().replace(/^#/, "");
    const birthday = Number(fragment.split(".")[1]);
    expect(fragment.split(".")[0], "fragment secret is 43 base64url chars").toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`/e#${fragment}`);

    // Sealed, on the real core: no MOCK badge anywhere in this flow.
    await expect(page.getByRole("heading", { name: "You have an envelope" })).toBeVisible();
    await expect(page.getByTestId("mock-badge")).toHaveCount(0);

    const started = Date.now();
    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("scanning")).toBeVisible();

    // The scan really ran: the amount is the one the oracle sees.
    await expect(page.getByTestId("amount")).toHaveText(M1.amount, { timeout: 150_000 });
    const seconds = (Date.now() - started) / 1000;

    await expect(page.getByTestId("envelope")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("pool")).toHaveText(M1.pool);
    await expect(page.getByTestId("height")).toHaveText(M1.height);
    await expect(page.getByTestId("txid")).toHaveText(
      new RegExp(`^${M1.txidPrefix}…[0-9a-f]{8}$`),
    );
    await expect(page.getByTestId("mock-badge")).toHaveCount(0);
    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);

    // The chain tip the scan finished at, so the block count is a measured number.
    const tipLine = (await page.getByText(/Chain tip [\d,]+ when this scan finished/).textContent())!;
    const tip = Number(tipLine.replace(/[^\d]/g, ""));
    expect(tip).toBeGreaterThanOrEqual(3_490_472);
    console.log(
      `M2 open page: ${tip - birthday + 1} blocks (${birthday}..${tip}) in ${seconds.toFixed(1)} s`,
    );

    await expect(page.getByTestId("amount")).toHaveCSS("opacity", "1");
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m2-open-real.png"), fullPage: true });

    // Drainer copy is banned product-wide.
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");

    // The secret goes nowhere: no link on the page carries it onward.
    const hrefs = await page.locator("a[href]").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    for (const href of hrefs) expect(href).not.toContain(fragment.split(".")[0]);
  });
});
