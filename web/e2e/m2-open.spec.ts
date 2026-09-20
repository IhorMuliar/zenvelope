/**
 * M2 end-to-end proof: opening an envelope.
 *
 *   npm run e2e
 *
 * This one runs on the MOCK core, so it needs no network and no wasm build: it
 * proves the screen flow, not the cryptography. The MOCK simulates a four-second
 * scan and then hands back one note of 130000 zatoshi with the memo
 * "Zenvelope M1". The real-core proof for M2 lands with the scanner.
 *
 * What it proves:
 *   - /e#<fragment> shows the sealed envelope, with the sender's message hidden
 *   - tapping "Open envelope" shows scan progress driven by on_progress
 *   - the amount reads 0.0013 ZEC and the memo is shown as the sender's message
 *   - the fiat equivalent is behind a tap and never a price request
 *   - the M3 next-step cards are present and disabled
 *   - no link on the page carries the secret fragment onward
 *   - a link with no fragment gets a friendly error and never scans
 */

import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

/** Any valid secret: 43 base64url chars, plus a birthday height. */
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FRAGMENT = `${SECRET}.3490437`;

test.describe("M2: opening an envelope", () => {
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

    // M3 placeholders, all three disabled.
    const next = page.getByTestId("next-step");
    await expect(next).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(next.nth(i)).toBeDisabled();
    await expect(next.nth(2)).toContainText("leaves the shielded pool");

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
