/**
 * M5 end-to-end proof: the real UI, the real wasm core, the real mainnet
 * envelope and the **live** 1Click API — and deliberately nothing sent.
 *
 *   ./scripts/build-core.sh
 *   cd web && npm ci && npm run build
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' ZENV_EXPECT_ZEC='0.0003' \
 *   ZENVELOPE_E2E_PORT=4211 npx playwright test e2e/m5-real.spec.ts
 *
 * The fragment is never committed: it lives in the private, gitignored
 * M1-FUND.md and M3-DEST.md, is read from the environment here, and the group
 * skips cleanly without it — which is what CI and a fresh checkout see.
 *
 * **Which envelope.** The M1 envelope (0.0013 ZEC) was swept on 2026-09-21 and is
 * empty; the live fixture is the 0.0003 ZEC fee envelope from M3-DEST.md, which is
 * unspent. `ZENV_EXPECT_ZEC` says what to expect and everything below is derived
 * from it, defaulting to the M1 amount.
 *
 * Nothing here is mocked. Every 1Click call goes to
 * `https://1click.chaindefuser.com/v0` from the page's own origin, which is
 * also the CORS proof: the browser really can talk to this rail with no proxy
 * of ours in the middle.
 *
 * **Nothing is broadcast.** The page is loaded with `?dry=1`, so `sweep_envelope`
 * is called with `broadcast: false`; the done screen's "Dry run" copy is
 * asserted on the way out, so a run that silently broadcast would fail here.
 * A *real* (non-dry) quote is asked for, and that is harmless: it reserves a
 * transparent address the rail watches for three days, and an address nobody
 * pays simply expires.
 *
 * ## The one thing this run cannot do end to end
 *
 * The M1 envelope holds 130,000 zatoshi. A deposit address is transparent, so
 * the sweep's ZIP-317 fee is 15,000, leaving 115,000 for the rail — and the
 * rail's floor is about $2, which on 2026-09-21 was 132,000 zatoshi. The
 * envelope is therefore **under the floor**, and the product says so and stops.
 * That is the assertion below, with the floor read live out of the rail's own
 * 400 rather than out of a constant.
 *
 * So the deposit address is obtained with a second, real quote at the floor
 * amount, made from the page with the same body the app sends, and the dry
 * sweep is then driven to that `t1` through the ordinary pasted-address
 * destination. The `t1` is real, the transaction built to it is real, and it
 * goes nowhere.
 */

import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const FRAGMENT = process.env.ZENV_M1_FRAGMENT;
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));

/** Zatoshi from a ZEC string, and back the way the page renders it. */
function toZat(zec: string): bigint {
  const [whole, frac = ""] = zec.trim().split(".");
  return BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

function asZec(zat: bigint): string {
  const whole = (zat / 100_000_000n).toString();
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}.${frac === "" ? "0" : frac} ZEC`;
}

/** What the envelope under test holds. Default: the (now empty) M1 envelope. */
const ENVELOPE_ZAT = toZat(process.env.ZENV_EXPECT_ZEC ?? "0.0013");
const ENVELOPE = asZec(ENVELOPE_ZAT);

/**
 * The flat Zenvelope fee is only charged when the build had a fee address, so what
 * the rail would be quoted depends on the build this run is driving:
 *
 *   envelope - 15,000 transparent ZIP-317            (no fee address)
 *   envelope - 15,000 transparent ZIP-317 - 30,000   (VITE_FEE_ADDRESS set)
 *
 * It is the same arithmetic `sweepAmounts(..., "transparent", ...)` does for the
 * quote, so asserting it here is asserting that the review screen and the rail were
 * shown the same number. Every envelope we have is under the rail's floor today,
 * which is the point of the run: the product refuses and says why.
 */
const FEE_ENABLED = (process.env.VITE_FEE_ADDRESS ?? "").trim() !== "";
const TRANSPARENT_FEE_ZAT = 15_000n;
const SERVICE_FEE_ZAT = FEE_ENABLED ? 30_000n : 0n;
const SWAP_INPUT_ZAT = ENVELOPE_ZAT - TRANSPARENT_FEE_ZAT - SERVICE_FEE_ZAT;
const SERVICE_FEE = asZec(SERVICE_FEE_ZAT);
const SWAP_INPUT = asZec(SWAP_INPUT_ZAT);

const USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

/** A dry quote for 0.0009 ZEC, which the milestone asks for by name. */
const NINE_HUNDRED_MICRO_ZEC = 90_000;

/** Where a real quote's address is redacted to in the log. */
function redact(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)} (${address.length} chars)`;
}

interface LiveQuote {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A quote, retried past an answer that is neither a price nor a verdict.
 *
 * The rail can answer `400 {"message":"Internal server error"}` with a
 * correlation id — reproducibly for a recipient that is a token mint rather than
 * a wallet, and occasionally for no reason we could find. A priced quote and a
 * min-amount answer are both real answers and come back at once; anything else
 * is worth asking again before believing.
 *
 * The product does not retry. It shows the rail's own message and leaves the
 * button pressable, which is the right thing when the other side is somebody
 * else's service.
 */
async function liveQuoteRetrying(
  page: Page,
  args: { dry: boolean; amount: number; refundTo: string; recipient: string },
  attempts = 4,
): Promise<LiveQuote> {
  let last: LiveQuote | null = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await quoteOnce(page, args);
    const message = String((last.body as { message?: string }).message ?? "");
    if (last.status === 201 || /try at least \d+/.test(message)) return last;
    console.log(`M5 transient rail answer (attempt ${i + 1}): ${last.status} ${message}`);
    await page.waitForTimeout(3_000);
  }
  return last!;
}

/**
 * One 1Click quote, made from the page's own origin with exactly the body
 * `src/lib/oneclick.ts` sends. Running it in the page rather than in Node is the
 * point: it proves the CORS policy a browser actually meets.
 */
async function quoteOnce(
  page: Page,
  args: { dry: boolean; amount: number; refundTo: string; recipient: string },
): Promise<LiveQuote> {
  return page.evaluate(async (a) => {
    const response = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry: a.dry,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: "nep141:zec.omft.near",
        depositType: "ORIGIN_CHAIN",
        destinationAsset: a.usdc,
        amount: String(a.amount),
        refundTo: a.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: a.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        quoteWaitingTimeMs: 3000,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { ...args, usdc: USDC });
}

const describeReal = !FRAGMENT || !REAL_CORE ? test.describe.skip : test.describe;

describeReal("M5: the Solana exit against the live 1Click API, dry run", () => {
  // The proving key and the proof are tens of seconds of wasm each.
  test.setTimeout(1_200_000);

  test.skip(
    SWAP_INPUT_ZAT <= 0n,
    `the envelope (${ENVELOPE}) cannot cover a transparent sweep; set ZENV_EXPECT_ZEC`,
  );

  test("quotes live, is told the floor, takes a real deposit address, and sends nothing", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    /* ------------------------------------------------- open the real envelope */

    await page.goto(`/e?dry=1#${FRAGMENT}`);
    // H1: the link secret is out of the URL bar before anything else happens.
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
      .toBe("");
    expect(page.url()).not.toContain(FRAGMENT!.split(".")[0]);
    await expect(page.getByTestId("mock-badge")).toHaveCount(0);
    console.log(`M5 ${await page.getByTestId("proving-note").innerText()}`);

    // The envelope's own address, which is also the default refund target (D14).
    // It is on the sealed screen and only there, so it is read before opening.
    await expect(page.getByTestId("open-address-toggle")).toBeVisible();
    await page.getByTestId("open-address-toggle").click();
    const envelopeAddress = (await page.getByTestId("open-address").innerText()).trim();
    expect(envelopeAddress).toMatch(/^u1/);

    await page.getByTestId("open-envelope").click();
    await expect(page.getByTestId("amount")).toHaveText(ENVELOPE, { timeout: 300_000 });

    /* ------------------- 1. the product's own path, with a generated keypair */

    const refundTo = envelopeAddress;

    await page.getByTestId("dest-solana").click();
    await expect(page.getByTestId("trust-boundary")).toBeVisible();
    await expect(page.getByTestId("trust-continue")).toBeDisabled();
    await page.getByTestId("trust-ack").check();
    await page.getByTestId("trust-continue").click();

    await page.getByTestId("swap-asset-usdc").click();
    await page.getByTestId("swap-mode-generate").click();
    await expect(page.getByTestId("swap-secret-key")).toBeVisible();
    const generated = (await page.getByTestId("swap-keypair-address").innerText()).trim();
    console.log(`M5 generated Solana address: ${generated}`);
    expect(generated.length).toBeGreaterThanOrEqual(32);
    await page.getByTestId("swap-saved-key").check();

    /* --------------------------------------- 2. a live dry quote for 0.0009 ZEC
     *
     * The milestone asks for this figure by name, and it is not an amount the
     * product would ever ask for on this envelope, so it is asked for directly —
     * with the same body the app sends, and paying out to the key just generated.
     *
     * The recipient has to be an ordinary wallet key. The rail answers
     * `400 {"message":"Internal server error"}` for a recipient that is a token
     * mint (the USDC mint was tried), which is a gap in its own validation and
     * the reason this call moved below the keypair. */

    const nineHundred = await liveQuoteRetrying(page, {
      dry: true,
      amount: NINE_HUNDRED_MICRO_ZEC,
      refundTo,
      recipient: generated,
    });
    console.log(
      `M5 live dry quote for 0.0009 ZEC: HTTP ${nineHundred.status} ` +
        `${JSON.stringify(nineHundred.body).slice(0, 300)}`,
    );

    let floorZat: number | null = null;
    if (nineHundred.status === 400) {
      // Below the floor: the message carries the current minimum, live.
      const message = String((nineHundred.body as { message?: string }).message ?? "");
      expect(message).toMatch(/try at least \d+/);
      floorZat = Number(/try at least (\d+)/.exec(message)![1]);
      console.log(`M5 live minimum: ${floorZat} zatoshi (${floorZat / 1e8} ZEC)`);
    } else {
      // Above it: a real price came back, and it is the whole cost of leaving.
      expect(nineHundred.status).toBe(201);
      const quote = (nineHundred.body as { quote: Record<string, string> }).quote;
      const spread = 1 - Number(quote.amountOutUsd) / Number(quote.amountInUsd);
      console.log(
        `M5 live dry quote 0.0009 ZEC -> ${quote.amountOutFormatted} USDC ` +
          `($${quote.amountInUsd} in, $${quote.amountOutUsd} out, spread ${(spread * 100).toFixed(2)}%)`,
      );
      expect(Number(quote.amountOut)).toBeGreaterThan(0);
    }

    /* ------------------------- 3. the product's own live quote, on this envelope */

    // The envelope amount less the Zcash fees, quoted live from the page.
    await page.getByTestId("swap-get-quote").click();

    const minimum = page.getByTestId("swap-minimum");
    const quoted = page.getByTestId("swap-quote");
    await expect(minimum.or(quoted).first()).toBeVisible({ timeout: 30_000 });

    if (await minimum.isVisible()) {
      // The expected outcome on 2026-09-21: what is left of the envelope after the
      // Zcash fees — see SWAP_INPUT — is under the floor, either way round.
      const line = await minimum.innerText();
      const raw = await page.getByTestId("swap-error").innerText();
      console.log(`M5 product minimum line: ${line}`);
      console.log(`M5 rail message: ${raw}`);
      expect(raw).toMatch(/try at least \d+/);
      floorZat = Number(/try at least (\d+)/.exec(raw)![1]);
      expect(line).toMatch(/will not trade less than/);
      // The shielded way out is still there, which is the point of blocking.
      await expect(page.getByTestId("swap-back")).toBeVisible();
    } else {
      // The floor moved under the envelope: the whole path runs, live.
      console.log(`M5 live quote on screen: ${await quoted.innerText()}`);
      await expect(page.getByTestId("swap-amount-out")).toContainText("USDC");
      await expect(page.getByTestId("swap-fee-line")).toContainText("0.25%");
    }

    /* ----------------- 4. a real deposit address, and the dry sweep to it */

    // At the floor, so it succeeds whatever the envelope holds. This reserves an
    // address for three days and nothing more.
    const atFloor = floorZat ?? 132_000;
    const real = await liveQuoteRetrying(page, {
      dry: false,
      amount: atFloor,
      refundTo,
      recipient: generated,
    });
    expect(real.status).toBe(201);
    const realQuote = (real.body as { quote: Record<string, string> }).quote;
    const deposit = realQuote.depositAddress;
    console.log(
      `M5 real deposit address: ${redact(deposit)} — transparent, no memo; ` +
        `deadline ${realQuote.deadline}`,
    );
    expect(deposit).toMatch(/^t1[1-9A-HJ-NP-Za-km-z]{20,}$/);
    expect(new Date(realQuote.deadline).getTime() - Date.now()).toBeGreaterThan(
      2 * 24 * 60 * 60 * 1000,
    );

    // The status endpoint knows it, live, before anything has been paid.
    const status = await page.evaluate(async (address) => {
      const r = await fetch(
        `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(address)}`,
      );
      return { status: r.status, body: await r.json() };
    }, deposit);
    expect(status.status).toBe(200);
    expect((status.body as { status: string }).status).toBe("PENDING_DEPOSIT");
    console.log(`M5 live status: ${(status.body as { status: string }).status}`);

    // Now the ordinary sweep, to that real `t1`, through the pasted-address card.
    // How many steps back depends on how far the quote got, so walk until the
    // shielded destinations are on screen again rather than counting clicks.
    for (let i = 0; i < 6; i += 1) {
      if (await page.getByTestId("dest-address").isVisible()) break;
      const back = (await page.getByTestId("trust-back").count())
        ? page.getByTestId("trust-back")
        : page.getByTestId("swap-back").first();
      await back.click();
    }
    await expect(page.getByTestId("dest-address")).toBeVisible();

    await expect(page.getByTestId("warm-status")).toHaveText("Keys ready", { timeout: 600_000 });
    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(deposit);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "warn");
    await expect(page.getByTestId("dest-feedback")).toContainText("leaves the shielded pool");
    await page.getByTestId("to-review").click();

    // M7: a pasted transparent address goes through the trust boundary, with the
    // tick as the only way past it, exactly as the Solana card does.
    await expect(page.getByTestId("transparent-boundary")).toBeVisible();
    await expect(page.getByTestId("trust-continue")).toBeDisabled();
    await page.getByTestId("trust-ack").check();
    await page.getByTestId("trust-continue").click();

    await expect(page.getByTestId("review-in-envelope")).toHaveText(ENVELOPE);
    // A transparent destination, so the higher ZIP-317 fee, which is exactly the
    // number the swap was quoted on.
    await expect(page.getByTestId("review-network-fee")).toHaveText(asZec(TRANSPARENT_FEE_ZAT));
    if (FEE_ENABLED) {
      await expect(page.getByTestId("review-service-fee")).toHaveText(SERVICE_FEE);
    }
    await expect(page.getByTestId("review-receive")).toHaveText(SWAP_INPUT);

    const tapped = Date.now();
    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sending")).toBeVisible();
    await expect(page.getByTestId("sent-heading")).toBeVisible({ timeout: 900_000 });
    console.log(`M5 real dry sweep: tap to done ${((Date.now() - tapped) / 1000).toFixed(1)} s`);

    /* ----------------------------- 5. it was a dry run, and it says so */

    await expect(page.getByTestId("sent-heading")).toHaveText("Dry run complete.");
    await expect(page.getByTestId("dry-run-note")).toContainText("not sent");
    await expect(page.getByTestId("envelope-intact")).toContainText("Nothing was sent");
    await expect(page.getByTestId("explorer-link")).toHaveCount(0);
    const bytes = Number((await page.getByTestId("dry-run-size").innerText()).replace(/\D/g, ""));
    console.log(`M5 real dry sweep: raw transaction ${bytes} bytes to ${redact(deposit)}`);
    // A real proved bundle. The floor is generous because the shape depends on the
    // envelope: the two-output M3 sweep measured 9,166 bytes, and a one-output
    // transparent sweep of a smaller envelope is smaller than that.
    expect(bytes).toBeGreaterThan(5_000);

    /* -------------------------------------------------- and nothing leaked */

    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
    const secret = FRAGMENT!.split(".")[0];
    for (const url of requests) expect(url).not.toContain(secret);
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
  });
});
