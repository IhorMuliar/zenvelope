/**
 * M4 proof, part B: the judge-facing surfaces.
 *
 *   npm run e2e
 *
 * Three things, all on the MOCK core so this needs no network and no wasm build:
 *
 *   1. The landing page. The tagline, one paragraph of how it works, the
 *      three-step "we never hold funds" strip, the never-ask line and the
 *      footer. Screenshot: docs/m4-landing.png.
 *   2. `/how`. The "Is this link safe?" section and its four checks, and the
 *      never-ask line again.
 *   3. Group envelopes. Three links generated client-side, a table of three
 *      single-output ZIP-321 URIs, and a CSV download whose bytes are read back
 *      and parsed. Screenshot: docs/m4-group.png.
 *
 * Throughout: the word "claim" appears on no screen, no screen asks for a seed
 * phrase or a wallet connection, nothing is written to localStorage or
 * sessionStorage, and no request carries a secret.
 *
 * Skipped when a real wasm build is present: the create form would then make
 * real mainnet envelopes, and an unattended test run has no business doing that
 * fifty times. The same rule as m2-open.spec.ts and m3-open.spec.ts.
 */

import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

const NEVER_ASK =
  "We will never ask for your seed phrase, your wallet password, or a wallet connection.";

/** A secret is 43 base64url characters. Any of them turning up is a leak. */
const SECRET_RE = /[A-Za-z0-9_-]{43}/g;

/** Drainer copy is banned product-wide, on every screen, in every compound. */
async function expectNoDrainerCopy(page: Page) {
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("claim");
  expect(text).not.toMatch(/connect\s+(your|a|the)?\s*wallet/);
  expect(text).not.toMatch(/(enter|type|paste)[^.]{0,40}(seed|recovery|mnemonic) phrase/);
}

/** Nothing is persisted, ever: there is no state to come back to and none to leak. */
async function expectNothingStored(page: Page) {
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
  expect(stored.local).toEqual([]);
  expect(stored.session).toEqual([]);
}

describeOnMock("M4: the landing page", () => {
  test("leads with the tagline, the strip and the footer", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Send shielded money as a link. No wallet, no address, no amount on screen.",
    );

    // How it works, in one paragraph, naming the fragment.
    await expect(page.getByTestId("how-paragraph")).toContainText("after the #");
    await expect(page.getByTestId("how-paragraph")).toContainText("never send to any server");

    // The three-step strip: sender's wallet, the link's address, their browser.
    const strip = page.getByTestId("never-hold").locator("li");
    await expect(strip).toHaveCount(3);
    await expect(strip.nth(0)).toContainText("Your wallet");
    await expect(strip.nth(1)).toContainText("on-chain");
    await expect(strip.nth(2)).toContainText("Their browser");

    // The create form is on the same screen, with both group controls.
    await expect(page.getByTestId("amount")).toBeVisible();
    await expect(page.getByTestId("count")).toHaveValue("1");
    await expect(page.getByTestId("create")).toHaveText("Create envelope");

    // Said out loud, on the landing page itself.
    await expect(page.getByTestId("never-ask")).toHaveText(NEVER_ASK);

    // The footer: three checkable lines.
    await expect(page.getByTestId("footer-source")).toHaveText("Open source, MIT");
    await expect(page.getByTestId("footer-source")).toHaveAttribute(
      "href",
      "https://github.com/IhorMuliar/zenvelope",
    );
    await expect(page.getByTestId("footer-built")).toHaveText(
      "Built for the Colosseum Crypto World's Fair 2026, Zcash track.",
    );
    await expect(page.getByTestId("footer-tracking")).toHaveText("No analytics. No cookies.");

    await expectNoDrainerCopy(page);
    await expectNothingStored(page);

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m4-landing.png"), fullPage: true });
  });

  test("reads on a phone without a sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

describeOnMock('M4: "Is this link safe?" on /how', () => {
  test("names what we never ask for and teaches four checks", async ({ page }) => {
    await page.goto("/how");

    const safety = page.getByTestId("safety");
    await expect(safety.getByRole("heading", { name: "Is this link safe?" })).toBeVisible();
    await expect(page.getByTestId("never-ask")).toHaveText(NEVER_ASK);

    const checks = safety.locator("ol.steps > li");
    await expect(checks).toHaveCount(4);
    await expect(checks.nth(0)).toContainText("host");
    await expect(checks.nth(1)).toContainText("never leaves your browser");
    await expect(checks.nth(2)).toContainText("github.com/IhorMuliar/zenvelope");
    await expect(checks.nth(3)).toContainText("block explorer");

    // The one thing opening an envelope does ask for.
    await expect(safety).toContainText("one thing");
    await expect(safety).toContainText("address");

    await expectNoDrainerCopy(page);
  });
});

describeOnMock("M4: group envelopes (M6 preview)", () => {
  test("makes three links, shows the table, and downloads the CSV", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.goto("/");
    await page.getByTestId("amount").fill("0.01");
    await page.getByTestId("count").fill("3");
    await page.getByTestId("message").fill("Payroll, March");

    // The running total is worked out before anything is generated.
    await expect(page.getByTestId("preview-total")).toContainText("0.0309 ZEC in total");
    await expect(page.getByTestId("preview-total")).toContainText("3 payments of 0.0103 ZEC");
    await expect(page.getByTestId("create")).toHaveText("Create envelopes");

    await page.getByTestId("create").click();

    await expect(page.getByRole("heading", { name: "Your envelopes are ready" })).toBeVisible();
    await expect(page.getByTestId("group-lede")).toContainText("3 links");

    // Three rows, each a separate envelope.
    const rows = page.getByTestId("group-row");
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId("group-total")).toContainText("0.0309 ZEC in total");

    // The header names both amounts rather than one ambiguous "Amount". Read as text
    // content, not innerText: the column heads are uppercased by CSS, not by the copy.
    const headers = await page.getByTestId("group-table").locator("thead th").allTextContents();
    expect(headers).toEqual([
      "#",
      "In the envelope",
      "To send",
      "Link",
      "Address",
      "Payment URI",
    ]);

    const links = await page.getByTestId("row-link").allInnerTexts();
    const uris = await page.getByTestId("row-uri").allInnerTexts();
    const envelopeAmounts = await page.getByTestId("row-envelope").allInnerTexts();
    const sendAmounts = await page.getByTestId("row-send").allInnerTexts();
    expect(new Set(links).size).toBe(3);
    expect(new Set(uris).size).toBe(3);

    for (let i = 0; i < 3; i++) {
      expect(links[i]).toMatch(/\/e#[A-Za-z0-9_-]{43}(\.\d+)?$/);
      // Single-output ZIP-321: one address, one amount, no indexed parameters.
      expect(uris[i]).toMatch(/^zcash:[a-z0-9]+\?amount=0\.0103&memo=[A-Za-z0-9_-]+$/);
      expect(uris[i]).not.toMatch(/address\.\d/);
      // Two amount columns: what the recipient gets, and what the sender sends.
      expect(envelopeAmounts[i]).toBe("0.01 ZEC");
      expect(sendAmounts[i]).toBe("0.0103 ZEC");
    }

    // The link is the money, and the page says so.
    await expect(page.getByTestId("group-warn")).toContainText("Anyone holding one can open");
    await expect(page.getByTestId("group-memory")).toContainText("not stored");

    await expectNoDrainerCopy(page);
    await expectNothingStored(page);

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m4-group.png"), fullPage: true });

    // The CSV: downloaded for real, read back, and parsed.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("download-csv").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^zenvelope-3-envelopes-\d{4}-\d{2}-\d{2}\.csv$/);

    const path = await download.path();
    expect(path, "the download produced no file").toBeTruthy();
    const csv = readFileSync(path!, "utf8");
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe("index,link,address,envelope_zec,send_zec,memo,payment_uri");
    expect(lines).toHaveLength(5); // header + 3 rows + the trailing empty
    for (let i = 0; i < 3; i++) {
      const row = lines[i + 1];
      expect(row.startsWith(`${i + 1},`)).toBe(true);
      expect(row).toContain(links[i]);
      expect(row).toContain(uris[i]);
      // Both amounts, in their own columns, and the send amount is the URI's.
      const cells = row.split(",");
      expect(cells[3]).toBe("0.01");
      expect(cells[4]).toBe("0.0103");
      expect(row).toContain("amount=0.0103");
      // The memo has a comma in it, so it has to be quoted rather than split.
      expect(row).toContain('"Payroll, March"');
    }
    expect(csv.toLowerCase()).not.toContain("claim");

    // The secrets are in the links and in the CSV the sender asked for. They
    // are in no request this page made.
    const secrets = links.flatMap((l) => l.match(SECRET_RE) ?? []);
    expect(secrets).toHaveLength(3);
    for (const url of requests) {
      for (const secret of secrets) expect(url).not.toContain(secret);
    }
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""));
    for (const href of hrefs) {
      for (const secret of secrets) expect(href).not.toContain(secret);
    }
  });

  test("keeps the M1 QR flow for a single envelope", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("amount").fill("0.01");
    await expect(page.getByTestId("count")).toHaveValue("1");
    await page.getByTestId("create").click();

    await expect(page.getByRole("heading", { name: "Your envelope is ready" })).toBeVisible();
    await expect(page.locator("canvas[aria-label='Payment QR code']")).toBeVisible();
    await expect(page.getByTestId("envelope-link")).toContainText("/e#");
    await expect(page.getByTestId("payment-uri")).toContainText("zcash:");
    await expect(page.getByTestId("group-table")).toHaveCount(0);
    await expect(page.getByTestId("breakdown")).toContainText("= 0.0103 ZEC");

    await expectNoDrainerCopy(page);
    await expectNothingStored(page);
  });

  test("refuses a group larger than fifty", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("amount").fill("0.01");
    await page.getByTestId("count").fill("51");
    await expect(page.getByTestId("count-error")).toContainText("50 envelopes at a time");
    await page.getByTestId("create").click();
    await expect(page.getByTestId("group-table")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Send shielded money");
  });
});
