/**
 * M5 end-to-end proof: the Solana exit, on the MOCK core, with the 1Click rail
 * mocked by `page.route`.
 *
 *   cd web && ZENVELOPE_E2E_PORT=4197 npm run e2e -- e2e/m5-solana.spec.ts
 *
 * The rail's bodies are verbatim from the live API on 2026-09-21, amounts
 * changed to this envelope's: a dry quote, the 400 that carries the minimum, a
 * real quote with a transparent deposit address, and a status sequence. Nothing
 * here reaches the network — neither the Zcash chain, through the MOCK core, nor
 * the rail, through `page.route` — so the run is repeatable and costs nobody
 * anything.
 *
 * Two deliberate departures from the recording, both of them consequences of the
 * 2026-09-21 security fixes:
 *
 *   - the recorded USD pair costs **18.03%** to leave, because a flat Solana
 *     withdrawal fee spread over a $1.74 swap is enormous. That is above
 *     `MAX_SPREAD_BPS`, so the product now refuses it — which is a test of its
 *     own below. The flow tests use the same body with a healthier
 *     `amountOutUsd`, so they can reach the deposit address at all.
 *   - `quoteRequest` is **echoed from the request** rather than hard-coded, as
 *     the live API does it, because the product now compares the echo with what
 *     it asked for before it sweeps anything (M6).
 *
 * What it proves:
 *   - the Solana card is live, and leads to the trust boundary rather than to a
 *     swap: the required tick is the only way past it
 *   - both destination modes: a pasted address, refused when it is not base58 of
 *     32 bytes, and a keypair generated here whose secret key is shown once and
 *     gated behind "I saved this key"
 *   - the dry quote's numbers on screen: what arrives, both USD figures, the
 *     effective spread, the time estimate, the 0.25% disclosure, and the line
 *     that Zenvelope is not the swap provider
 *   - the minimum, read out of the rail's own 400, blocking the deposit address
 *   - the real quote's `t1` deposit address and its three-day deadline, then the
 *     ordinary sweep to that `t1` at the transparent fee of 15,000 zatoshi
 *   - the refund override is classified by the core before a quote may be asked
 *     for, and a bad one blocks it with the reason (M4)
 *   - a quote above the spread cap cannot be acted on (M5)
 *   - a deposit address that is not a transparent `t1`, and a rail that echoes
 *     back something other than what we asked for, are both refused before the
 *     sweep, with a message and a way to start again (M6/L9)
 *   - backing out of the exit takes its swap screens with it (M3)
 *   - the status poll: PENDING_DEPOSIT, PROCESSING, SUCCESS, with the Solana txid
 *   - `?dry=1` stops after the real quote and the built transaction, and says so
 *   - the word "claim" is on no screen of any of it
 *
 * Screenshots: docs/m5-trust.png, docs/m5-quote.png.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

/** Any valid secret: 43 base64url chars, plus a birthday height. */
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FRAGMENT = `${SECRET}.3490437`;

/** The MOCK envelope: 130,000 zatoshi. */
const ENVELOPE_ZAT = 130_000n;
/** ZIP-317 for a transparent destination, which every deposit address is. */
const TRANSPARENT_FEE_ZAT = 15_000n;
/** The flat Zenvelope fee, taken now that the production fee address is set. */
const SERVICE_FEE_ZAT = 30_000n;
/** What the rail is actually quoted on. */
const SWAP_INPUT_ZAT = ENVELOPE_ZAT - TRANSPARENT_FEE_ZAT - SERVICE_FEE_ZAT; // 85,000

const SOLANA_ADDRESS = "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS";
/** Right charset, wrong length: 33 bytes, so not a Solana address. */
const TOO_LONG = "2VfUX6Xj6GfMfF5bAKrkRRhCcmc6xYfkKWLdnGnFn5wVZ";
const DEPOSIT_T1 = "t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd";
/** A unified address the MOCK core classifies as one: 60 characters of `u1mock…`. */
const MOCK_UA = `u1mock${"q".repeat(54)}`;
const SOLANA_TXID = "5j7sQqvxQ3pYhTYVVYd1gWbEtZ6dQeJ8p1bXK2cPqRfN9sTuVwXyZaBcDeFgHiJkLmNoPq";

/** A real wasm build puts the page on the real core, and this group off. */
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

/* ------------------------------------------------------------ the rail, mocked */

/** The recorded USD figures: 1 - 1.424419544/1.737834 = 18.03%, over the cap. */
const RECORDED_OUT_USD = "1.424419544000";
/** The same swap at a rate the product will act on: 3.33%. */
const HEALTHY_OUT_USD = "1.680000000000";

interface QuoteOptions {
  /** Keep the recorded 18.03% spread instead of the healthy one. */
  wideSpread?: boolean;
  /** Answer with a deposit address other than the transparent `t1` (M6). */
  depositAddress?: string;
  /** Echo back a request we did not make (M6). */
  echo?: Record<string, unknown>;
}

/**
 * A quote, priced off the request, with `quoteRequest` echoed from it exactly as
 * the live API does. The echo is load-bearing now: the product compares it with
 * what it asked for before it sweeps anything to the deposit address.
 */
function quoteFor(request: Record<string, unknown>, options: QuoteOptions = {}) {
  const amount = String(request.amount ?? "");
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: "0.00085",
      amountInUsd: "1.737834000000",
      minAmountIn: amount,
      amountOut: "1424851",
      amountOutFormatted: "1.424851",
      amountOutUsd: options.wideSpread ? RECORDED_OUT_USD : HEALTHY_OUT_USD,
      minAmountOut: "1410602",
      timeEstimate: 454,
      refundFee: "32000",
      withdrawFee: "298357",
    },
    quoteRequest: {
      dry: request.dry,
      amount,
      originAsset: request.originAsset,
      destinationAsset: request.destinationAsset,
      refundTo: request.refundTo,
      recipient: request.recipient,
      appFees: [{ recipient: "5880ad…47dd", fee: 25 }],
      ...(options.echo ?? {}),
    },
    signature: "ed25519:mock",
    timestamp: "2026-09-21T02:33:27.939Z",
  };
}

function realQuote(request: Record<string, unknown>, options: QuoteOptions = {}) {
  const body = quoteFor(request, options);
  return {
    ...body,
    quote: {
      ...body.quote,
      deadline: "2026-09-24T09:00:00.000Z",
      timeWhenInactive: "2026-09-24T09:00:00.000Z",
      depositAddress: options.depositAddress ?? DEPOSIT_T1,
    },
  };
}

const MIN_AMOUNT_400 = {
  message: "Amount is too low for bridge, try at least 132000",
  correlationId: "9298d720-9929-4e32-8e42-cf778376568a",
  timestamp: "2026-09-21T02:33:15.550Z",
  path: "/v0/quote",
};

function statusBody(status: string, withTxid = false) {
  return {
    status,
    updatedAt: "2026-09-21T02:40:00.000Z",
    swapDetails: {
      amountOut: "1424851",
      amountOutFormatted: "1.424851",
      amountOutUsd: "1.42",
      refundedAmount: "0",
      refundReason: null,
      refundFee: "32000",
      withdrawFee: "298357",
      originChainTxHashes: [],
      destinationChainTxHashes: withTxid ? [{ hash: SOLANA_TXID }] : [],
    },
  };
}

interface RailOptions extends QuoteOptions {
  /** true makes every dry quote answer with the minimum error. */
  belowMinimum?: boolean;
  /** Served in order; the last one repeats. */
  statuses?: string[];
}

/**
 * Every 1Click call, answered from memory, with the request bodies recorded so
 * the test can assert what we actually asked for.
 */
async function mockRail(page: Page, options: RailOptions = {}) {
  const quoteRequests: Array<Record<string, unknown>> = [];
  const statusRequests: string[] = [];
  const statuses = options.statuses ?? ["PENDING_DEPOSIT"];
  let statusIndex = 0;

  await page.route("https://1click.chaindefuser.com/v0/quote", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    quoteRequests.push(body);

    if (options.belowMinimum && body.dry === true) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify(MIN_AMOUNT_400),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        body.dry === true ? quoteFor(body, options) : realQuote(body, options),
      ),
    });
  });

  await page.route("https://1click.chaindefuser.com/v0/status*", async (route: Route) => {
    statusRequests.push(route.request().url());
    const status = statuses[Math.min(statusIndex, statuses.length - 1)];
    statusIndex += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statusBody(status, status === "SUCCESS")),
    });
  });

  return { quoteRequests, statusRequests };
}

/* ---------------------------------------------------------------- the journey */

/** Opens the envelope and lands on "Where should it go?". */
async function openEnvelope(page: Page, query = ""): Promise<void> {
  await page.goto(`/e${query}#${FRAGMENT}`);
  await page.getByTestId("open-envelope").click();
  await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
}

/** Through the trust boundary, ticking the box on the way. */
async function throughTrustBoundary(page: Page): Promise<void> {
  await page.getByTestId("dest-solana").click();
  await expect(page.getByTestId("trust-boundary")).toBeVisible();
  await page.getByTestId("trust-ack").check();
  await page.getByTestId("trust-continue").click();
  await expect(page.getByTestId("swap-asset")).toBeVisible();
}

/** Nothing on any screen may say "claim": it is the top wallet-drainer lure. */
async function noDrainerCopy(page: Page): Promise<void> {
  expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
}

describeOnMock("M5: the Solana exit", () => {
  // The MOCK spends 4 s scanning, 3 s warming and 4 s proving.
  test.setTimeout(150_000);

  test("the trust boundary is the only way in, and the tick is the only way through", async ({
    page,
  }) => {
    await mockRail(page);
    await openEnvelope(page);

    // The card is live, and it leads with what the exit costs rather than the money.
    await expect(page.getByTestId("dest-solana")).toBeEnabled();
    await expect(page.getByTestId("dest-solana")).toContainText("leaves the shielded pool");
    await expect(page.getByTestId("dest-solana")).toContainText("never hold the funds");

    await page.getByTestId("dest-solana").click();

    // A screen of its own: four things you give up, and a disabled button.
    await expect(page.getByTestId("trust-title")).toHaveText("This leaves the shielded pool");
    await expect(page.getByTestId("trust-points").locator("li")).toHaveCount(4);
    await expect(page.getByTestId("trust-continue")).toBeDisabled();
    await expect(page.getByTestId("trust-blocked")).toHaveText("Tick the box above to continue.");
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m5-trust.png"), fullPage: true });

    // Poking the disabled attribute from the outside does not get through: the
    // handler checks the same rule the attribute does.
    // Both in one evaluate, because React puts the attribute straight back.
    await page.getByTestId("trust-continue").evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.removeAttribute("disabled");
      button.click();
    });
    await expect(page.getByTestId("swap-asset")).toHaveCount(0);
    await expect(page.getByTestId("trust-boundary")).toBeVisible();

    // The tick opens it, and unticking closes it again.
    await page.getByTestId("trust-ack").check();
    await expect(page.getByTestId("trust-continue")).toBeEnabled();
    await page.getByTestId("trust-ack").uncheck();
    await expect(page.getByTestId("trust-continue")).toBeDisabled();

    // And there is always a way back to a shielded destination.
    await page.getByTestId("trust-back").click();
    await expect(page.getByTestId("dest-address")).toBeVisible();

    await noDrainerCopy(page);
  });

  test("a pasted address, the quote's numbers, and the dry-run end screen", async ({ page }) => {
    const rail = await mockRail(page);
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);

    // 1. What should arrive.
    await expect(page.getByTestId("swap-asset-usdc")).toBeVisible();
    await expect(page.getByTestId("swap-asset-sol")).toBeVisible();
    await page.getByTestId("swap-asset-usdc").click();

    // 2. A pasted Solana address, checked as it is typed.
    await expect(page.getByTestId("swap-destination")).toBeVisible();
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-mode-paste").click();

    // A Zcash address in the Solana box is not a Solana address.
    await page.getByTestId("swap-address-input").fill("u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4");
    await expect(page.getByTestId("swap-address-feedback")).toHaveAttribute(
      "data-status",
      "error",
    );
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();

    // A look-alike zero: the charset message, not the length one.
    await page.getByTestId("swap-address-input").fill(`${SOLANA_ADDRESS.slice(0, 10)}0${SOLANA_ADDRESS.slice(11)}`);
    await expect(page.getByTestId("swap-address-feedback")).toContainText(
      "a character no Solana address can contain",
    );

    // Right charset, wrong length.
    await page.getByTestId("swap-address-input").fill(TOO_LONG);
    await expect(page.getByTestId("swap-address-feedback")).toContainText("decodes to 32 bytes");
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();

    // And the real thing.
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await expect(page.getByTestId("swap-address-feedback")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();

    // The refund default is the envelope's own address (DECISIONS D14).
    await expect(page.getByTestId("swap-refund-default")).toContainText(
      "this envelope's own address",
    );

    // 3. The dry quote.
    await page.getByTestId("swap-get-quote").click();
    await expect(page.getByTestId("swap-quote")).toBeVisible();

    // It was quoted on the envelope less the Zcash fees, not on the envelope.
    expect(rail.quoteRequests[0].amount).toBe(SWAP_INPUT_ZAT.toString());
    expect(rail.quoteRequests[0].dry).toBe(true);
    expect(rail.quoteRequests[0].originAsset).toBe("nep141:zec.omft.near");
    expect(rail.quoteRequests[0].recipient).toBe(SOLANA_ADDRESS);
    expect(rail.quoteRequests[0].refundType).toBe("ORIGIN_CHAIN");
    // The refund goes to the envelope's own unified address by default.
    expect(String(rail.quoteRequests[0].refundTo)).toMatch(/^u1/);

    await expect(page.getByTestId("swap-amount-in")).toContainText("0.00085 ZEC");
    await expect(page.getByTestId("swap-amount-in")).toContainText("$1.74");
    await expect(page.getByTestId("swap-amount-out")).toHaveText("1.424851 USDC");
    await expect(page.getByTestId("swap-amount-out-usd")).toHaveText("$1.68");
    // 1 - 1.68 / 1.737834 = 0.03328…
    await expect(page.getByTestId("swap-spread")).toContainText("3.33%");
    await expect(page.getByTestId("swap-spread")).toContainText("$0.06");
    // Under the cap, so there is nothing refusing it and a way on.
    await expect(page.getByTestId("swap-quote-refused")).toHaveCount(0);
    await expect(page.getByTestId("swap-get-deposit")).toBeEnabled();
    await expect(page.getByTestId("swap-time")).toHaveText("about 8 minutes");
    await expect(page.getByTestId("swap-fee-line")).toContainText("0.25% service fee");
    await expect(page.getByTestId("swap-not-provider").first()).toContainText(
      "not the swap provider",
    );
    await expect(page.getByTestId("swap-minimum")).toHaveCount(0);
    await page.screenshot({ path: resolve(DOCS, "m5-quote.png"), fullPage: true });

    // 4. The real quote: a transparent deposit address and a three-day deadline.
    await page.getByTestId("swap-get-deposit").click();
    await expect(page.getByTestId("swap-deposit")).toBeVisible();
    expect(rail.quoteRequests[1].dry).toBe(false);
    await expect(page.getByTestId("swap-deposit-address")).toHaveText(DEPOSIT_T1);
    await expect(page.getByTestId("swap-deadline")).toContainText("2026");
    await expect(page.getByTestId("swap-recipient")).toHaveText(SOLANA_ADDRESS);

    // 5. From here it is the ordinary sweep, to a transparent address.
    await page.getByTestId("swap-continue").click();
    await expect(page.getByTestId("review-in-envelope")).toHaveText("0.0013 ZEC");
    await expect(page.getByTestId("review-network-fee")).toHaveText("0.00015 ZEC");
    await expect(page.getByTestId("review-receive")).toHaveText("0.00085 ZEC");
    await expect(page.getByTestId("review-swap-out")).toHaveText("1.424851 USDC");
    await expect(page.getByTestId("review-swap-spread")).toContainText("3.33%");
    await expect(page.getByTestId("review-warning")).toContainText("visible on-chain");
    await noDrainerCopy(page);

    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sending")).toBeVisible();

    // 6. `?dry=1`: a real deposit address, a built transaction, and nothing sent.
    await expect(page.getByTestId("sent-heading")).toHaveText("Dry run complete.", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("dry-run-note")).toHaveText(
      "Dry run: deposit address obtained, transaction built, nothing sent",
    );
    await expect(page.getByTestId("dry-run-deposit-address")).toHaveText(DEPOSIT_T1);
    await expect(page.getByTestId("dry-run-swap-note")).toContainText("still in the envelope");
    // A dry run is measured like any other: the same Timing block, same lines.
    await expect(page.getByTestId("timing-total")).toHaveText(/^\d+\.\d s$/);
    await expect(page.getByTestId("timing-proving")).toHaveText(/^\d+\.\d s$/);
    await expect(page.getByTestId("timing-device")).toContainText("hardwareConcurrency");
    await expect(page.getByTestId("envelope-intact")).toContainText("Nothing was sent");
    await expect(page.getByTestId("explorer-link")).toHaveCount(0);
    // Nothing was broadcast, so there is nothing for the rail to watch.
    await expect(page.getByTestId("swap-tracker")).toHaveCount(0);
    expect(rail.statusRequests).toHaveLength(0);

    await noDrainerCopy(page);
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);
  });

  test("a keypair generated here, shown once and gated on saving it", async ({ page }) => {
    const rail = await mockRail(page);
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-sol").click();

    await page.getByTestId("swap-mode-generate").click();
    await expect(page.getByTestId("swap-secret-key")).toBeVisible();
    await expect(page.getByTestId("swap-keypair-error")).toHaveCount(0);

    // 64 bytes of base58 is 87 or 88 characters; the address is 32 to 44.
    const secret = (await page.getByTestId("swap-secret-key").innerText()).trim();
    const address = (await page.getByTestId("swap-keypair-address").innerText()).trim();
    expect(secret.length).toBeGreaterThanOrEqual(86);
    expect(secret.length).toBeLessThanOrEqual(88);
    expect(address.length).toBeGreaterThanOrEqual(32);
    expect(address.length).toBeLessThanOrEqual(44);
    expect(secret).not.toBe(address);

    await expect(page.getByTestId("swap-secret-once")).toContainText("saved nowhere");
    await expect(page.getByTestId("swap-import-hint")).toContainText("Phantom");
    await expect(page.getByTestId("swap-import-hint")).toContainText("Solflare");

    // The gate: the key has to be saved before there is a way forward.
    await expect(page.getByTestId("swap-saved-key")).not.toBeChecked();
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-saved-key").check();
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();
    // And it is a gate, not a one-way door.
    await page.getByTestId("swap-saved-key").uncheck();
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-saved-key").check();

    await page.getByTestId("swap-get-quote").click();
    await expect(page.getByTestId("swap-quote")).toBeVisible();
    // The rail was told to pay the address this page generated, and SOL was asked for.
    expect(rail.quoteRequests[0].recipient).toBe(address);
    expect(rail.quoteRequests[0].destinationAsset).toBe("nep141:sol.omft.near");

    // The secret key was never written anywhere it could be read back.
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);
    // And it is not repeated on the review screen.
    await expect(page.getByTestId("swap-secret-key")).toHaveCount(0);

    await noDrainerCopy(page);
  });

  test("an envelope under the rail's floor is told the floor and stopped there", async ({
    page,
  }) => {
    await mockRail(page, { belowMinimum: true });
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();

    // The floor comes straight out of the rail's own 400, not from a constant,
    // and it is restated in the product's words with the rail's underneath.
    await expect(page.getByTestId("swap-minimum")).toContainText(
      "will not trade less than 0.00132 ZEC",
    );
    await expect(page.getByTestId("swap-minimum")).toContainText("shielded ZEC");
    await expect(page.getByTestId("swap-error")).toContainText(
      "Amount is too low for bridge, try at least 132000",
    );
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();
    await expect(page.getByTestId("swap-quote")).toHaveCount(0);
    await expect(page.getByTestId("swap-deposit")).toHaveCount(0);

    // And the shielded way out is still on the screen.
    await page.getByTestId("swap-back").click();
    await noDrainerCopy(page);
  });

  test("watches the swap after a broadcast: pending, processing, paid out", async ({ page }) => {
    // The MOCK core touches no chain and no network; "broadcast" here signs a
    // made-up transaction and hands back a made-up txid. Nothing is ever sent.
    const rail = await mockRail(page, {
      statuses: ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"],
    });
    await openEnvelope(page, "?poll=300");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("swap-continue").click();
    await page.getByTestId("send-it-on").click();

    await expect(page.getByTestId("sent-heading")).toHaveText("Sent.", { timeout: 60_000 });
    await expect(page.getByTestId("swap-tracker")).toBeVisible();
    await expect(page.getByTestId("swap-stage-row")).toHaveCount(3);

    // The three stages, in the order the rail reports them.
    const row = (stage: string) => page.locator(`[data-testid="swap-stage-row"][data-stage="${stage}"]`);
    await expect(row("deposit")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("swap-status-line")).toHaveText(
      "Paid out on Solana.",
      { timeout: 20_000 },
    );
    await expect(row("swap")).toHaveAttribute("data-state", "done");
    await expect(row("payout")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("swap-solana-txid")).toContainText("…");

    // It asked more than once, and it stopped once there was nothing left to ask.
    expect(rail.statusRequests.length).toBeGreaterThanOrEqual(3);
    for (const url of rail.statusRequests) {
      expect(url).toContain(`depositAddress=${DEPOSIT_T1}`);
    }
    const asked = rail.statusRequests.length;
    await page.waitForTimeout(1_500);
    expect(rail.statusRequests.length).toBe(asked);

    await noDrainerCopy(page);
  });
  /* ------------------------------------------------- the 2026-09-21 fixes */

  /**
   * M4. The refund override decides who can recover the money when a swap
   * fails, and it used to be free text that went straight into `refundTo`. It
   * goes through the core's classifier now, and the quote waits for the answer.
   */
  test("classifies the refund address before it will quote anything", async ({ page }) => {
    const rail = await mockRail(page);
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();

    // A Sapling address cannot take a refund, and the rail would accept it
    // happily: our own core is what refuses it.
    await page.getByTestId("swap-refund").click();
    await page.getByTestId("swap-refund-input").fill(`zs1${"q".repeat(75)}`);
    await expect(page.getByTestId("swap-refund-feedback")).toHaveAttribute("data-status", "bad");
    await expect(page.getByTestId("swap-refund-feedback")).toContainText("A refund could not be sent");
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    // Nothing was asked of the rail while the address was bad.
    expect(rail.quoteRequests).toHaveLength(0);

    // Nonsense is refused the same way.
    await page.getByTestId("swap-refund-input").fill("not-an-address");
    await expect(page.getByTestId("swap-refund-feedback")).toHaveAttribute("data-status", "bad");
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();

    // A unified address of this network is accepted.
    await page.getByTestId("swap-refund-input").fill(MOCK_UA);
    await expect(page.getByTestId("swap-refund-feedback")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();

    // And emptying the box goes back to the envelope's own address (D14).
    await page.getByTestId("swap-refund-input").fill("");
    await expect(page.getByTestId("swap-refund-feedback")).toHaveCount(0);
    await page.getByTestId("swap-get-quote").click();
    await expect(page.getByTestId("swap-quote")).toBeVisible();
    expect(String(rail.quoteRequests[0].refundTo)).toMatch(/^u1/);
    await noDrainerCopy(page);
  });

  /**
   * M5. The recorded quote for an envelope this small costs 18.03% to leave.
   * That used to be a percentage on the screen next to a live button; it is a
   * refusal now.
   */
  test("refuses a quote whose spread is over the cap", async ({ page }) => {
    const rail = await mockRail(page, { wideSpread: true });
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();

    await expect(page.getByTestId("swap-quote")).toBeVisible();
    // The number is still shown in full: the recipient is told what it costs
    // and why that is too much, not just that something went wrong.
    await expect(page.getByTestId("swap-spread")).toContainText("18.03%");
    await expect(page.getByTestId("swap-quote-refused")).toContainText("18.03%");
    await expect(page.getByTestId("swap-quote-refused")).toContainText("15.00%");
    await expect(page.getByTestId("swap-get-deposit")).toBeDisabled();

    // Poking the attribute off the button reserves nothing: only one dry quote
    // was ever asked for.
    await page.getByTestId("swap-get-deposit").evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.removeAttribute("disabled");
      button.click();
    });
    await expect(page.getByTestId("swap-deposit")).toHaveCount(0);
    expect(rail.quoteRequests.filter((r) => r.dry === false)).toHaveLength(0);

    // The shielded way out is still there.
    await expect(page.getByTestId("swap-back")).toBeVisible();
    await noDrainerCopy(page);
  });

  /**
   * M6 and L9. The deposit address is about to be paid out of somebody's
   * envelope. A `u1…` where a `t1…` was promised means this is not the rail's
   * ordinary answer, and the sweep must not happen — visibly, with a way on.
   */
  test("refuses a deposit address that is not a transparent one, and says so", async ({ page }) => {
    await mockRail(page, { depositAddress: MOCK_UA });
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("swap-continue").click();

    // Not the review screen: the choose screen, with the reason on it.
    await expect(page.getByTestId("swap-plan-error")).toBeVisible();
    await expect(page.getByTestId("swap-plan-error-message")).toContainText(
      "not a transparent Zcash address",
    );
    await expect(page.getByTestId("swap-plan-error-message")).toContainText("Nothing was sent");
    await expect(page.getByTestId("review-receive")).toHaveCount(0);
    await expect(page.getByTestId("send-it-on")).toHaveCount(0);
    // And the swap screens are gone with the plan.
    await expect(page.getByTestId("review-swap-out")).toHaveCount(0);

    // L9: a retry, not a dead end.
    await page.getByTestId("swap-plan-retry").click();
    await expect(page.getByTestId("trust-boundary")).toBeVisible();
    await noDrainerCopy(page);
  });

  test("refuses a rail that echoes back a payout address we did not ask for", async ({ page }) => {
    await mockRail(page, { echo: { recipient: "7Ncx1MipyrmGMD5YhGYZaHcdFN9NtcDBiKk9pBaMr2yL" } });
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("swap-continue").click();

    await expect(page.getByTestId("swap-plan-error-message")).toContainText("payout address");
    await expect(page.getByTestId("send-it-on")).toHaveCount(0);
    await noDrainerCopy(page);
  });

  test("refuses a rail that echoes back a refund address we did not ask for", async ({ page }) => {
    await mockRail(page, { echo: { refundTo: "u1somebodyelsesaddress" } });
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("swap-continue").click();

    await expect(page.getByTestId("swap-plan-error-message")).toContainText("refund address");
    await expect(page.getByTestId("send-it-on")).toHaveCount(0);
  });

  /**
   * M3. A stale swap plan used to survive "Choose somewhere else": the review
   * screen went on promising USDC on Solana above a button that paid a unified
   * Zcash address, and the Sent screen mounted a tracker polling an address
   * nobody had paid. A deceptive confirm screen on an irreversible action.
   */
  test("takes the swap screens away when the destination changes", async ({ page }) => {
    const rail = await mockRail(page, { statuses: ["PENDING_DEPOSIT"] });
    await openEnvelope(page, "?poll=300");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("swap-continue").click();

    // The review screen, with the swap's numbers on it.
    await expect(page.getByTestId("review-swap-out")).toBeVisible();

    // Back out, and choose a shielded address instead.
    await page.getByTestId("review-back").click();
    await expect(page.getByTestId("dest-address")).toBeVisible();
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(MOCK_UA);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "ok");
    await page.getByTestId("to-review").click();

    // No swap on the review screen: not the amount out, not the spread, not the
    // payout address.
    await expect(page.getByTestId("review-receive")).toHaveText("0.0009 ZEC");
    await expect(page.getByTestId("review-swap-out")).toHaveCount(0);
    await expect(page.getByTestId("review-swap-spread")).toHaveCount(0);
    await expect(page.getByTestId("review-swap-recipient")).toHaveCount(0);
    await expect(page.getByTestId("review-destination")).toContainText("u1");

    // And none on the Sent screen either: no tracker, and no poll for an address
    // nobody paid.
    const asked = rail.statusRequests.length;
    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sent-heading")).toHaveText("Sent.", { timeout: 60_000 });
    await expect(page.getByTestId("swap-tracker")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(rail.statusRequests.length).toBe(asked);
    await noDrainerCopy(page);
  });

  test("takes the plan away when the exit itself is backed out of", async ({ page }) => {
    await mockRail(page);
    await openEnvelope(page, "?dry=1");
    await throughTrustBoundary(page);
    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(SOLANA_ADDRESS);
    await page.getByTestId("swap-get-quote").click();
    await page.getByTestId("swap-get-deposit").click();
    await expect(page.getByTestId("swap-deposit")).toBeVisible();

    // Out of the exit the long way, from the deposit screen back to the cards.
    for (let i = 0; i < 6; i += 1) {
      if (await page.getByTestId("dest-address").isVisible()) break;
      const back = (await page.getByTestId("trust-back").count())
        ? page.getByTestId("trust-back")
        : page.getByTestId("swap-back").first();
      await back.click();
    }
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(MOCK_UA);
    await page.getByTestId("to-review").click();
    await expect(page.getByTestId("review-swap-out")).toHaveCount(0);
  });
});
