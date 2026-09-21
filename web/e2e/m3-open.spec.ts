/**
 * M3 end-to-end proof: sending the envelope on, driven by the MOCK core.
 *
 *   npm run e2e
 *
 * The MOCK gives this run a four-second scan, a three-second proving-key warm-up
 * and four one-second stages, so the whole flow is real timing on a fake chain:
 * no network, no wasm build, no money. The group skips itself when a wasm build
 * is present, because then the page is on the real core and its made-up secret
 * would scan mainnet for nothing — and a real sweep is somebody's money.
 *
 * What it proves:
 *   - the proving key starts warming the moment the envelope opens, and says so
 *   - a pasted Sapling zs1 address is refused with the message that names u1
 *   - the test-vector unified address from crates/core/TEST_VECTORS.md is accepted
 *   - the new-wallet path shows 24 words, the address and the birthday height,
 *     and will not continue until "I wrote these down" is ticked
 *   - the review screen's arithmetic: envelope - network fee = what you receive
 *   - the four stages tick over in order, with an elapsed clock
 *   - a pasted transparent t1 goes through the same trust boundary the Solana
 *     exit does, and the tick is the only way past it (M7)
 *   - the done screen has the txid, a copy button, an explorer link, and says
 *     the envelope is now empty
 *   - the done screen's Timing block measures the scan, the warm-up and each
 *     stage, and copies as plain text
 *   - the secret never reaches a link or a request, and the word "claim" never
 *     appears anywhere on any screen
 *
 * Screenshots: docs/m3-choose.png, docs/m3-progress.png, docs/m3-done.png.
 */

import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

/** Any valid secret: 43 base64url chars, plus a birthday height. */
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FRAGMENT = `${SECRET}.3490437`;

/** The fixed mainnet vector from crates/core/TEST_VECTORS.md. */
const VECTOR_UA =
  "u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f";

/** A Sapling address: the one shape the destination matrix has to turn away. */
const SAPLING =
  "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly";

/** A real wasm build puts the page on the real core, and this group off. */
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

/** Opens the envelope and lands on the "Where should it go?" card. */
async function openEnvelope(page: Page) {
  await page.goto(`/e#${FRAGMENT}`);
  await page.getByTestId("open-envelope").click();
  await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
}

/** How the page shortens a long string: src/lib/format.ts truncateMiddle. */
function truncated(value: string, keep = 12): string {
  return `${value.slice(0, keep)}\u2026${value.slice(-keep)}`;
}

/** Nothing on any screen may say "claim": it is the top wallet-drainer lure. */
async function noDrainerCopy(page: Page) {
  expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
}

describeOnMock("M3: sending the envelope on", () => {
  // The mock spends 4 s scanning, 3 s warming and 4 s proving, and one test
  // walks the whole way through.
  test.setTimeout(120_000);

  test("pastes an address, reviews, sends, and lands on Sent", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await openEnvelope(page);

    // 1. The proving key is already being built, before anything was chosen.
    await expect(page.getByTestId("warm-status")).toHaveText(/Preparing keys… ~40 s|Keys ready/);
    await expect(page.getByTestId("warm-status")).toHaveText("Keys ready");

    // The Solana card is live from M5, and it still leads with what it costs
    // you rather than with the money. e2e/m5-solana.spec.ts drives it in full.
    await expect(page.getByTestId("dest-solana")).toBeEnabled();
    await expect(page.getByTestId("dest-solana")).toContainText("leaves the shielded pool");
    await expect(page.getByTestId("to-review")).toBeDisabled();

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m3-choose.png"), fullPage: true });

    // 2. A Sapling address is refused, and told what to paste instead.
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(SAPLING);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("dest-feedback")).toHaveText(
      "This address type is not supported yet, paste a unified address starting with u1.",
    );
    await expect(page.getByTestId("to-review")).toBeDisabled();

    // Nonsense is refused too, and does not throw the page away.
    await page.getByTestId("dest-input").fill("not-an-address");
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("to-review")).toBeDisabled();

    // 3. The test-vector unified address is accepted.
    await page.getByTestId("dest-input").fill(VECTOR_UA);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("dest-feedback")).toContainText("stays shielded");
    await expect(page.getByTestId("to-review")).toBeEnabled();

    // 4. Review: the arithmetic, in full, with the destination truncated.
    await page.getByTestId("to-review").click();
    await expect(page.getByTestId("review-in-envelope")).toHaveText("0.0013 ZEC");
    await expect(page.getByTestId("review-network-fee")).toHaveText("0.0001 ZEC");
    await expect(page.getByTestId("review-receive")).toHaveText("0.0012 ZEC");
    // No fee address is configured yet, so there is no Zenvelope fee line.
    await expect(page.getByTestId("review-service-fee")).toHaveCount(0);
    await expect(page.getByTestId("review-destination")).toHaveText(truncated(VECTOR_UA));
    await expect(page.getByTestId("send-timing")).toHaveText(
      "This takes about 1 to 2 minutes on a laptop and longer on a phone. Keep this tab open.",
    );
    await noDrainerCopy(page);

    // 5. The four stages, in order, with a clock. Each stage is one second in
    // the mock, so the states are caught with an in-page poll rather than with
    // a round trip that could miss the window.
    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sending")).toBeVisible();
    await expect(page.getByTestId("stage-row")).toHaveCount(4);
    await expect(page.getByTestId("stage-row").nth(0)).toHaveText(
      /Building the proof of ownership/,
    );
    await expect(page.getByTestId("stage-row").nth(1)).toHaveText(/Preparing keys/);
    await expect(page.getByTestId("stage-row").nth(2)).toHaveText(
      /Proving \(this is the slow part\)/,
    );
    await expect(page.getByTestId("stage-row").nth(3)).toHaveText(/Sending to the network/);

    const stageIs = (index: number, state: string) =>
      page.waitForFunction(
        ([i, want]) => {
          const rows = document.querySelectorAll('[data-testid="stage-row"]');
          return rows[i as number]?.getAttribute("data-state") === want;
        },
        [index, state] as const,
        { polling: 40, timeout: 20_000 },
      );

    await stageIs(0, "active");
    await stageIs(1, "active");
    await stageIs(2, "active");
    await expect(page.getByTestId("stage-row").nth(0)).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("stage-row").nth(1)).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("stage-row").nth(3)).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId("elapsed")).toHaveText(/^\d+:\d{2}$/);
    await expect(page.getByTestId("stage-detail")).not.toBeEmpty();
    await page.screenshot({ path: resolve(DOCS, "m3-progress.png"), fullPage: true });
    await stageIs(3, "active");

    // 6. Sent: the txid, the copy button, the explorer link, and the empty envelope.
    await expect(page.getByTestId("sent-heading")).toHaveText("Sent.");
    await expect(page.getByTestId("sent-amount")).toHaveText("0.0012 ZEC");
    await expect(page.getByTestId("sent-txid")).toHaveText(/^[0-9a-f]{10}\u2026[0-9a-f]{10}$/);
    await expect(page.getByTestId("explorer-link")).toHaveAttribute(
      "href",
      /^https:\/\/mainnet\.zcashexplorer\.app\/transactions\/[0-9a-f]{64}$/,
    );
    await expect(page.getByTestId("envelope-empty")).toHaveText("The envelope is now empty.");
    // The progress checklist is gone: this screen is the end of the road.
    await expect(page.getByTestId("stage-row")).toHaveCount(0);

    // 6b. The Timing block: every line a measurement, to one decimal, and the
    // three stage rows telling the mock's three different stage lengths apart.
    const seconds = /^\d+\.\d s$/;
    for (const row of ["open", "keys", "witness", "proving", "send", "total"]) {
      await expect(page.getByTestId(`timing-${row}`)).toHaveText(seconds);
    }
    const asNumber = async (row: string) =>
      Number((await page.getByTestId(`timing-${row}`).innerText()).replace(" s", ""));
    // MOCK_STAGE_TIMES: 0.8 s of witness, 1.3 s of proving, 1.2 s of broadcast.
    expect(await asNumber("witness")).toBeGreaterThanOrEqual(0.7);
    expect(await asNumber("witness")).toBeLessThan(1.2);
    expect(await asNumber("proving")).toBeGreaterThanOrEqual(1.2);
    expect(await asNumber("proving")).toBeLessThan(1.9);
    expect(await asNumber("send")).toBeGreaterThanOrEqual(1.1);
    // The scan is 4 s in the mock and the key warm-up 3 s; the whole sweep is 4 s.
    expect(await asNumber("open")).toBeGreaterThanOrEqual(3.9);
    expect(await asNumber("keys")).toBeGreaterThanOrEqual(2.9);
    expect(await asNumber("total")).toBeGreaterThanOrEqual(3.9);
    await expect(page.getByTestId("timing-device")).toHaveText(
      /^proving: \d+ threads? \u00b7 hardwareConcurrency \d+ \u00b7 \w+ on \w+$/,
    );
    // And it copies as plain text.
    const copyTiming = page.getByTestId("copy-timing");
    await expect(copyTiming).toHaveText("Copy timing");
    await copyTiming.click();
    await expect(copyTiming).toHaveText("Copied");
    await page.screenshot({ path: resolve(DOCS, "m3-done.png"), fullPage: true });

    // The copy button next to the txid copies the whole thing.
    const txidField = page.locator(".copy-field").filter({ has: page.getByTestId("sent-txid") });
    await txidField.getByRole("button", { name: "Copy" }).click();
    await expect(txidField.getByRole("button", { name: "Copied" })).toBeVisible();

    await noDrainerCopy(page);

    // The secret goes nowhere: not into a link, not into a request.
    const hrefs = await page.locator("a[href]").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    for (const href of hrefs) expect(href).not.toContain(SECRET);
    for (const url of requests) expect(url).not.toContain(SECRET);

    // Nothing was written down anywhere it could be read back.
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    expect(stored.local).toBe("{}");
    expect(stored.session).toBe("{}");
  });

  test("generates a wallet and will not go on until the words are written down", async ({
    page,
  }) => {
    await openEnvelope(page);

    await page.getByTestId("dest-wallet").click();

    // 24 words, on screen, in a grid.
    await expect(page.getByTestId("wallet-word")).toHaveCount(24);
    await expect(page.getByTestId("wallet-address")).toHaveText(/^u1mock.{6}\u2026.{12}$/);
    await expect(page.getByTestId("wallet-birthday")).toHaveText("3,490,500");
    await expect(page.getByTestId("wallet-restore")).toHaveText(
      "Restore in Zodl or Zingo with these words and this birthday height.",
    );

    // The gate: untouched checkbox, no way forward.
    await expect(page.getByTestId("wallet-confirm")).not.toBeChecked();
    await expect(page.getByTestId("to-review")).toBeDisabled();

    await page.getByTestId("wallet-confirm").check();
    await expect(page.getByTestId("to-review")).toBeEnabled();

    // And it is a gate, not a one-way door.
    await page.getByTestId("wallet-confirm").uncheck();
    await expect(page.getByTestId("to-review")).toBeDisabled();
    await page.getByTestId("wallet-confirm").check();

    // The wallet it generated is a destination like any other.
    await page.getByTestId("to-review").click();
    await expect(page.getByTestId("review-receive")).toHaveText("0.0012 ZEC");
    await expect(page.getByTestId("review-destination")).toHaveText(/^u1mock.{6}\u2026.{12}$/);

    // The mnemonic is on the screen and nowhere else.
    const words = await page.getByTestId("wallet-word").count();
    expect(words).toBe(0); // the review screen does not repeat it
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);

    await noDrainerCopy(page);
  });

  /**
   * M7: a pasted `t1` leaves the shielded pool exactly as permanently as the
   * Solana exit does. It used to need nothing but reading one warning line
   * above "Send it on"; it goes through the same gate now, with its own words.
   */
  test("gates a transparent destination behind the trust boundary, then allows it", async ({
    page,
  }) => {
    await openEnvelope(page);
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill("t1KvSHRKp5ZgFcqJe8ZbeBHhpTCVCXjPWKa");
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "warn");
    await expect(page.getByTestId("dest-feedback")).toContainText(
      "this leaves the shielded pool and is visible on-chain",
    );
    await expect(page.getByTestId("to-review")).toBeEnabled();

    // Continue does not reach the review screen: it reaches the boundary.
    await page.getByTestId("to-review").click();
    await expect(page.getByTestId("transparent-boundary")).toBeVisible();
    await expect(page.getByTestId("review-receive")).toHaveCount(0);
    await expect(page.getByTestId("trust-title")).toHaveText("This address leaves the shielded pool");
    await expect(page.getByTestId("trust-points").locator("li")).toHaveCount(4);
    await expect(page.getByTestId("trust-continue")).toBeDisabled();
    await expect(page.getByTestId("trust-blocked")).toHaveText("Tick the box above to continue.");

    // Poking the disabled attribute out of the DOM does not get through: the
    // handler checks the same rule the attribute is derived from.
    await page.getByTestId("trust-continue").evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.removeAttribute("disabled");
      button.click();
    });
    await expect(page.getByTestId("transparent-boundary")).toBeVisible();
    await expect(page.getByTestId("review-receive")).toHaveCount(0);

    // The way back is always open, and it keeps the typed address.
    await page.getByTestId("trust-back").click();
    await expect(page.getByTestId("dest-input")).toHaveValue("t1KvSHRKp5ZgFcqJe8ZbeBHhpTCVCXjPWKa");

    // And the tick is the way through.
    await page.getByTestId("to-review").click();
    await page.getByTestId("trust-ack").check();
    await expect(page.getByTestId("trust-continue")).toBeEnabled();
    await page.getByTestId("trust-continue").click();

    // The higher ZIP-317 fee follows the destination onto the review screen.
    await expect(page.getByTestId("review-network-fee")).toHaveText("0.00015 ZEC");
    await expect(page.getByTestId("review-receive")).toHaveText("0.00115 ZEC");
    await expect(page.getByTestId("review-warning")).toContainText("visible on-chain");
    await noDrainerCopy(page);
  });

  /** A unified address is not gated: it never leaves the shielded pool. */
  test("does not gate a shielded destination", async ({ page }) => {
    await openEnvelope(page);
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(VECTOR_UA);
    await page.getByTestId("to-review").click();
    await expect(page.getByTestId("transparent-boundary")).toHaveCount(0);
    await expect(page.getByTestId("review-receive")).toHaveText("0.0012 ZEC");
  });

  /**
   * L10: the core's own reason is on the screen, rather than being dropped in
   * favour of a guess at the prefix of what was typed.
   */
  test("shows the core's reason under a refused address", async ({ page }) => {
    await openEnvelope(page);
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(SAPLING);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("dest-reason")).not.toBeEmpty();

    // A wrong-network address is named as one, whatever it starts with.
    await page.getByTestId("dest-input").fill("nonsense-for-this-network");
    await expect(page.getByTestId("dest-reason")).toContainText("network");
    await noDrainerCopy(page);
  });
});
