/**
 * M6 end-to-end proof: the recipient UI of the MultiHopper "Private route", on the MOCK
 * core, with the 1Click rail, the MultiHopper proxy (`/api/mh/*`) and the Solana relay
 * (`/api/sol`) all answered by `page.route`. Nothing reaches a network.
 *
 *   cd web && ZENVELOPE_E2E_PORT=4197 npm run e2e -- e2e/m6-private-route.spec.ts
 *
 * Like every MOCK group it is skipped when a real wasm build is present (move
 * src/wasm/core aside and rebuild to run it). The two devnet tests need a build made
 * with VITE_SOLANA_CLUSTER=devnet and run only with M6_DEVNET=1.
 *
 * What it proves:
 *   - the "Private route" switch is hidden under the break-even gift (with the one line
 *     that names it) and shown, off, above it; the figures line reads as specified
 *   - turning it on adds its own tick-to-continue gate (MultiHopper, TRM, not audited)
 *   - a USDC gift buys SOL for the route with a second 1Click quote, both paying the
 *     router wallet, and the sweep pays both deposits in one transaction
 *   - "Connect my wallet" lists a Wallet Standard wallet, takes only its address and
 *     never calls a signing feature; with no wallet it is hidden and paste says where
 *     to copy the address from
 *   - a new wallet needs the last 4 characters of its key typed back
 *   - the tracker, from mocked GET responses: Packed, Hop i of n, Landing, In your
 *     wallet, the late notice, and the refund path with a plain send
 *   - reopening a swept link finds the route (router funds or a transfer) instead of
 *     "already opened", and every per-transfer call carries the externalId header
 *   - devnet: no swap, the router address and a QR to fund it
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.M6_SHOTS ?? "";
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FRAGMENT = `${SECRET}.3490437`;
const SPENT_FRAGMENT = `spentAll${SECRET.slice(8)}.3490437`;

const SWAP_INPUT_ZAT = 85_000;
const RECIPIENT = "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS";
const DEPOSIT_T1 = "t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd";
const DEPOSIT_T1_EXTRA = "t1Nm8QcWb3fYKJe7vr2s5xGt9HzLd4TqEu6";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;
const DEVNET = process.env.M6_DEVNET === "1";

/* ------------------------------------------------------------- the rail */

const SOL_USD = 90;

interface Rail {
  quotes: Record<string, unknown>[];
}

/** 1Click, priced like a ~2% spread, with SOL at $90 and a flat withdrawal fee. */
async function mockRail(page: Page, giftUsd: number): Promise<Rail> {
  const rail: Rail = { quotes: [] };
  await page.route("https://1click.chaindefuser.com/v0/quote", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    rail.quotes.push(body);
    const zat = Number(body.amount);
    const isSol = String(body.destinationAsset).includes("sol.omft");
    const out = isSol
      ? Math.round(((giftUsd / SOL_USD) * 1e9 * zat) / SWAP_INPUT_ZAT) - 100_000
      : Math.round(giftUsd * 1e6);
    const outUsd = isSol ? (out / 1e9) * SOL_USD : giftUsd;
    const dry = body.dry === true;
    const quote: Record<string, unknown> = {
      amountIn: String(zat),
      amountInFormatted: String(zat / 1e8),
      amountInUsd: (outUsd * 1.02).toFixed(6),
      minAmountIn: String(zat),
      amountOut: String(out),
      amountOutFormatted: String(isSol ? out / 1e9 : out / 1e6),
      amountOutUsd: outUsd.toFixed(6),
      minAmountOut: String(Math.floor(out * 0.99)),
      timeEstimate: 300,
      refundFee: "32000",
      withdrawFee: "100000",
    };
    if (!dry) {
      // A USDC gift's SOL quote is the route's extra deposit; every other quote is the main one.
      const usdcFlow = rail.quotes.some((q) => String(q.destinationAsset).includes("sol-5ce3"));
      quote.depositAddress = isSol && usdcFlow ? DEPOSIT_T1_EXTRA : DEPOSIT_T1;
      quote.deadline = "2026-12-01T09:00:00.000Z";
      quote.timeWhenInactive = "2026-12-01T09:00:00.000Z";
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        quote,
        quoteRequest: {
          dry,
          amount: body.amount,
          originAsset: body.originAsset,
          destinationAsset: body.destinationAsset,
          refundTo: body.refundTo,
          recipient: body.recipient,
          appFees: [{ recipient: "5880ad…47dd", fee: 25 }],
        },
        signature: "ed25519:mock",
        timestamp: "2026-11-06T12:00:00.000Z",
      }),
    });
  });
  return rail;
}

/* ------------------------------------------------------ MultiHopper + Solana */

interface World {
  /** The transfer by-external and GET /transfers/:id answer with; null = none yet. */
  transfer: Record<string, unknown> | null;
  lamports: number;
  tokens: bigint;
  sent: string[];
  creates: Record<string, unknown>[];
  estimates: Record<string, unknown>[];
  /** x-zenvelope-ext of every per-transfer call. */
  extHeaders: string[];
}

function newWorld(over: Partial<World> = {}): World {
  return { transfer: null, lamports: 0, tokens: 0n, sent: [], creates: [], estimates: [], extHeaders: [], ...over };
}

function estimateFor(body: Record<string, unknown>) {
  const amount = Number(body.amountRaw);
  const isSol = body.tokenMint === WSOL;
  const principal = isSol ? amount : 0;
  return {
    tokens: { amountRaw: String(amount), feeRaw: "0", netDeliveredRaw: String(amount), decimals: body.tokenDecimals },
    sol: {
      requiredSolUpFrontLamports: principal + 50_210_313,
      refundableLamports: 16_083_280,
      netCostLamports: principal + 34_127_033,
    },
  };
}

/** A transfer in the shape GET returns, timed relative to now. */
function transferAt(opts: {
  status: string;
  phase?: string;
  executed: number;
  ageSec: number;
  recipient?: string;
  mint?: string;
}) {
  const now = Date.now();
  const created = now - opts.ageSec * 1000;
  const at = (offsetSec: number) => new Date(created + offsetSec * 1000).toISOString();
  const sched = [10, 40, 110];
  return {
    id: 1583,
    externalId: "x".repeat(32),
    status: opts.status,
    phase: opts.phase ?? "executing",
    tokenMint: opts.mint ?? WSOL,
    amountRaw: "300000000",
    sourceOwner: "router",
    recipientWallet: opts.recipient ?? RECIPIENT,
    hops: 3,
    createdAt: at(0),
    quotedAt: at(0),
    route: {
      hops: sched.map((s, i) => ({
        index: i,
        address: `hop${i}`,
        scheduledAt: at(s),
        executedAt: i < opts.executed ? at(s + 3) : null,
        txSignature: i < opts.executed ? `SIG${i}${"s".repeat(60)}` : null,
      })),
    },
    progress: { hopsCompleted: opts.executed, hopsTotal: 6 },
  };
}

async function mockChain(page: Page, world: World) {
  await page.route("**/api/mh/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/mh/", "");
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "POST" && path === "transfers/estimate") {
      const body = JSON.parse(req.postData() ?? "{}");
      world.estimates.push(body);
      return json(200, estimateFor(body));
    }
    if (req.method() === "POST" && path === "transfers") {
      const body = JSON.parse(req.postData() ?? "{}");
      world.creates.push(body);
      return json(200, { ...transferAt({ status: "quote", executed: 0, ageSec: 1 }), ...body, id: 1583 });
    }
    if (path.startsWith("transfers/by-external/")) {
      return world.transfer ? json(200, world.transfer) : json(404, { error: { code: "MH_404", message: "none" } });
    }
    const m = /^transfers\/(\d+)(\/[a-z-]+)?$/.exec(path);
    if (m) {
      world.extHeaders.push(req.headers()["x-zenvelope-ext"] ?? "");
      if (!m[2] && req.method() === "GET") return world.transfer ? json(200, world.transfer) : json(404, {});
      // prepare / confirm-broadcast: the route's transactions are not mocked here.
      return json(409, { error: { code: "MH_999", message: "not mocked" } });
    }
    return json(404, { error: { code: "nope", message: path } });
  });

  await page.route("**/api/sol", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const reply = (result: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      });
    switch (body.method) {
      case "getBalance":
        return reply({ value: world.lamports });
      case "getTokenAccountsByOwner":
        return reply({
          value:
            world.tokens > 0n
              ? [
                  {
                    pubkey: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
                    account: {
                      owner: TOKEN_PROGRAM,
                      data: { parsed: { info: { tokenAmount: { amount: world.tokens.toString(), decimals: 6 } } } },
                    },
                  },
                ]
              : [],
        });
      case "getLatestBlockhash":
        return reply({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } });
      case "sendTransaction":
        world.sent.push(body.params[0]);
        return reply(`sig${world.sent.length}`);
      case "getSignatureStatuses":
        return reply({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      default:
        return reply(null);
    }
  });
}

/* ---------------------------------------------------------------- the journey */

async function openEnvelope(page: Page, query = ""): Promise<void> {
  await page.goto(`/e${query}#${FRAGMENT}`);
  await page.getByTestId("open-envelope").click();
  await expect(page.getByTestId("amount")).toHaveText("0.0013 ZEC");
  await page.getByTestId("receive-it").click();
}

async function toDestination(page: Page, asset: "usdc" | "sol"): Promise<void> {
  await page.getByTestId("dest-solana").click();
  await page.getByTestId("trust-ack").check();
  await page.getByTestId("trust-continue").click();
  await page.getByTestId(`swap-asset-${asset}`).click();
  await expect(page.getByTestId("swap-destination")).toBeVisible();
}

async function pasteAndQuote(page: Page): Promise<void> {
  await page.getByTestId("swap-mode-paste").click();
  await page.getByTestId("swap-address-input").fill(RECIPIENT);
  await page.getByTestId("swap-get-quote").click();
  await expect(page.getByTestId("swap-quote")).toBeVisible();
}

async function noDrainerCopy(page: Page): Promise<void> {
  expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
}

/* ------------------------------------------------------------------- tests */

describeOnMock("M6: the private route, quote screen", () => {
  test.setTimeout(150_000);
  test.skip(DEVNET, "devnet build: the swap rail is skipped");

  test("the switch is hidden under the break-even gift and names where it starts", async ({ page }) => {
    await mockRail(page, 40);
    await mockChain(page, newWorld());
    await openEnvelope(page, "?dry=1");
    await toDestination(page, "sol");
    await pasteAndQuote(page);

    await expect(page.getByTestId("route-unavailable")).toHaveText(/^Private route is available for gifts over \$\d+$/);
    await expect(page.getByTestId("route-toggle")).toHaveCount(0);
    await shot(page, "quote-route-hidden");
    await noDrainerCopy(page);
  });

  test("above it the switch is off by default; on, it shows the figures and its own gate", async ({ page }) => {
    const rail = await mockRail(page, 120);
    await mockChain(page, newWorld());
    await openEnvelope(page, "?dry=1&debug=1");
    await toDestination(page, "sol");
    await pasteAndQuote(page);

    const toggle = page.getByTestId("route-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("route-numbers")).toHaveCount(0);
    await expect(page.getByTestId("route-offer")).toContainText(
      "Extra privacy: your money takes a longer route, so it's harder to trace. Solana is public, so this isn't a guarantee.",
    );

    await toggle.check();
    // $120 gift, 0.5% = $0.60, SOL overhead 0.0375 SOL at $90 = $3.38 -> about $116.
    await expect(page.getByTestId("route-numbers")).toHaveText(
      /^You'll receive about \$11\d\.\d\d · arrives in about 8 min · costs: 0\.5% \+ about \$3\.\d\d network$/,
    );
    await shot(page, "quote-route-on");

    // Its own gate: MultiHopper, the screening, the audit status. Nothing is asked first.
    await page.getByTestId("swap-get-deposit").click();
    await expect(page.getByTestId("private-route-boundary")).toBeVisible();
    expect(rail.quotes.filter((q) => q.dry === false)).toHaveLength(0);
    const points = await page.getByTestId("trust-points").innerText();
    expect(points).toContain("MultiHopper");
    expect(points).toContain("TRM");
    expect(points).toContain("a safety check may send the money back to this link");
    expect(points).toContain("not yet audited");
    await expect(page.getByTestId("trust-continue")).toBeDisabled();
    await shot(page, "route-gate");
    await page.getByTestId("trust-ack").check();
    await page.getByTestId("trust-continue").click();

    // SOL gift: one real quote, paying the router wallet instead of the recipient.
    await expect(page.getByTestId("swap-deposit")).toBeVisible();
    const real = rail.quotes.filter((q) => q.dry === false);
    expect(real).toHaveLength(1);
    expect(real[0].recipient).not.toBe(RECIPIENT);
    expect(String(real[0].amount)).toBe(String(SWAP_INPUT_ZAT));
    await expect(page.getByTestId("swap-recipient")).toHaveText(String(real[0].recipient));
    await expect(page.getByTestId("swap-final-recipient")).toHaveText(RECIPIENT);
    await expect(page.getByTestId("swap-extra-out")).toHaveCount(0);
    await shot(page, "route-deposit-sol");

    await page.getByTestId("swap-continue").click();
    await expect(page.getByTestId("review-final-recipient")).toBeVisible();
    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sent-heading")).toHaveText("Dry run complete.", { timeout: 60_000 });
    await expect(page.getByTestId("dry-run-deposit-address")).toHaveText(DEPOSIT_T1);
    await noDrainerCopy(page);
    expect(await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)])).toEqual(["{}", "{}"]);
  });

  test("a USDC gift buys the route's SOL with a second quote, both paying the router", async ({ page }) => {
    const rail = await mockRail(page, 120);
    await mockChain(page, newWorld());
    await openEnvelope(page, "?dry=1");
    await toDestination(page, "usdc");
    await pasteAndQuote(page);

    await page.getByTestId("route-toggle").check();
    await page.getByTestId("swap-get-deposit").click();
    await page.getByTestId("trust-ack").check();
    await page.getByTestId("trust-continue").click();
    await expect(page.getByTestId("swap-deposit")).toBeVisible();

    const real = rail.quotes.filter((q) => q.dry === false);
    expect(real).toHaveLength(2);
    const [solQuote, usdcQuote] = real;
    expect(String(solQuote.destinationAsset)).toContain("sol.omft");
    expect(String(usdcQuote.destinationAsset)).toContain("sol-5ce3");
    expect(solQuote.recipient).toBe(usdcQuote.recipient);
    expect(solQuote.recipient).not.toBe(RECIPIENT);
    // The SOL is sized for the route: (50,210,313 + 150,000) * 1.15 = 57.9M lamports is
    // about 4,100 zat at this rate; the USDC gets the rest less the extra output's
    // 5,000 zat of ZIP-317 fee.
    const extraZat = Number(solQuote.amount);
    expect(extraZat).toBeGreaterThan(3_800);
    expect(extraZat).toBeLessThan(6_000);
    expect(Number(usdcQuote.amount)).toBe(SWAP_INPUT_ZAT - 5_000 - extraZat);
    await expect(page.getByTestId("swap-extra-out")).toContainText("SOL");
    // What the extra swap pays covers the 15% margin: at least 0.0579 SOL.
    const solText = await page.getByTestId("swap-extra-out").innerText();
    expect(parseFloat(solText)).toBeGreaterThanOrEqual(0.0579);
    await shot(page, "route-deposit-usdc");

    await page.getByTestId("swap-continue").click();
    await page.getByTestId("send-it-on").click();
    await expect(page.getByTestId("sent-heading")).toHaveText("Dry run complete.", { timeout: 60_000 });
    // One sweep, two deposits.
    await expect(page.getByTestId("dry-run-deposit-address")).toHaveText(DEPOSIT_T1);
    await expect(page.getByTestId("dry-run-extra-deposit-address")).toHaveText(DEPOSIT_T1_EXTRA);
  });
});

describeOnMock("M6: where on Solana", () => {
  test.setTimeout(150_000);
  test.skip(DEVNET, "covered by the mainnet build");

  test("with no wallet extension, connect is hidden and paste says where to copy from", async ({ page }) => {
    await mockRail(page, 120);
    await openEnvelope(page, "?dry=1");
    await toDestination(page, "usdc");
    await expect(page.getByTestId("swap-mode-connect")).toHaveCount(0);
    await expect(page.getByTestId("swap-mode-paste")).toContainText("Copy your address from your wallet app");
    await expect(page.getByTestId("swap-mode-paste")).toContainText("Paste an address");
    await expect(page.getByTestId("swap-mode-generate")).toContainText("Give me a new wallet");
  });

  test("a Wallet Standard wallet is listed, connect reads one address and signs nothing", async ({ page }) => {
    await page.addInitScript((address) => {
      (window as unknown as { __signed: number }).__signed = 0;
      const wallet = {
        name: "Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnLz4=",
        chains: ["solana:mainnet"],
        features: {
          "standard:connect": { connect: async () => ({ accounts: [{ address }] }) },
          "solana:signTransaction": { signTransaction: () => ((window as unknown as { __signed: number }).__signed += 1) },
          "solana:signMessage": { signMessage: () => ((window as unknown as { __signed: number }).__signed += 1) },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (e) => (e as CustomEvent).detail.register(wallet));
    }, RECIPIENT);
    const rail = await mockRail(page, 120);
    await openEnvelope(page, "?dry=1");
    await toDestination(page, "usdc");

    await expect(page.getByTestId("swap-mode-connect")).toContainText("Connect my wallet");
    await expect(page.getByTestId("swap-mode-connect")).toContainText(
      "We only see your public address. We can't move your money.",
    );
    await page.getByTestId("swap-mode-connect").click();
    await expect(page.getByTestId("swap-wallet")).toContainText("Test Wallet");
    await expect(page.getByTestId("swap-wallet").locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
    await shot(page, "destination-connect");
    await page.getByTestId("swap-wallet").click();
    await expect(page.getByTestId("swap-connected-address")).toHaveText(RECIPIENT);

    await page.getByTestId("swap-get-quote").click();
    await expect(page.getByTestId("swap-quote")).toBeVisible();
    expect(rail.quotes[0].recipient).toBe(RECIPIENT);
    expect(await page.evaluate(() => (window as unknown as { __signed: number }).__signed)).toBe(0);
  });

  test("a new wallet needs the last 4 characters of its key typed back", async ({ page }) => {
    await mockRail(page, 120);
    await openEnvelope(page, "?dry=1");
    await toDestination(page, "sol");
    await page.getByTestId("swap-mode-generate").click();

    const key = (await page.getByTestId("swap-secret-key").innerText()).trim();
    await expect(page.getByTestId("swap-copy-key")).toHaveText("Copy my key");
    await expect(page.getByTestId("swap-key-warning")).toHaveText(
      "Anyone with this key can take the money. Keep it in a password manager.",
    );
    await expect(page.getByTestId("swap-import-guide").locator("li")).toHaveCount(3);
    await expect(page.getByTestId("swap-import-guide")).toContainText("Settings");
    await expect(page.getByTestId("swap-import-guide")).toContainText("Manage accounts");
    await expect(page.getByTestId("swap-import-guide")).toContainText("Import private key");
    // The tick box is gone for this path; the typed check replaces it.
    await expect(page.locator('[data-testid="swap-saved-key"]')).toHaveCount(0);
    await shot(page, "destination-new-wallet");

    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-key-confirm").fill(key.slice(-3));
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-key-confirm").fill(key.slice(-4).toLowerCase() === key.slice(-4) ? key.slice(-4).toUpperCase() + "" : key.slice(-4).toLowerCase());
    await expect(page.getByTestId("swap-get-quote")).toBeDisabled();
    await page.getByTestId("swap-key-confirm").fill(key.slice(-4));
    await expect(page.getByTestId("swap-key-confirm-ok")).toBeVisible();
    await expect(page.getByTestId("swap-get-quote")).toBeEnabled();
  });
});

describeOnMock("M6: the tracker and resuming from the link", () => {
  test.setTimeout(120_000);
  test.skip(DEVNET, "covered by the mainnet build");

  /** A swept link whose route is already under way; the world decides what MultiHopper says. */
  async function reopen(page: Page, world: World, fragment = SPENT_FRAGMENT, click = false) {
    await mockChain(page, world);
    // SOL's dollar price, for the "(about $X)" in the close note.
    await page.route("**/1click.chaindefuser.com/**/tokens", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 90 }]),
      }),
    );
    await page.goto(`/e?poll=150#${fragment}`);
    if (click) await page.getByTestId("open-envelope").click();
  }

  test("reopening a link whose route runs shows the tracker at once, without entering the flow", async ({ page }) => {
    // An envelope that is NOT spent: the route check alone brings the tracker, no tap needed.
    const world = newWorld({
      lamports: 40_000_000,
      transfer: transferAt({ status: "active", executed: 1, ageSec: 50 }),
    });
    await reopen(page, world, FRAGMENT, false);
    await expect(page.getByTestId("route-tracker")).toBeVisible();
    await expect(page.getByTestId("open-envelope")).toHaveCount(0);
    await expect(page.locator('[data-stage="hops"]')).toHaveText(/Hop 2 of 3/);
    await expect(page.getByTestId("route-recipient")).toBeVisible();
    await expect(page.getByTestId("route-close-note")).toHaveText(
      "You can close this page. Your money arrives either way. Leave it open about 3 more minutes and the unused network money (about $1.80) comes to you too, or open this link again later to collect it.",
    );
  });

  test("reopening with a funded router and no transfer shows 'Finish sending', then runs the route", async ({ page }) => {
    const world = newWorld({ lamports: 1_000_000_000 });
    await reopen(page, world, FRAGMENT, false);
    await expect(page.getByTestId("route-finish")).toContainText(
      "This link's money is waiting in its route wallet. Where should it go?",
    );
    await expect(page.getByTestId("route-finish-go")).toBeDisabled();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(RECIPIENT);
    await page.getByTestId("route-finish-go").click();
    await expect.poll(() => world.creates.length).toBe(1);
    expect(world.creates[0].recipientWallet).toBe(RECIPIENT);
    await expect(page.getByTestId("route-tracker")).toBeVisible();
  });

  test("an already-swept link with a route shows the tracker, not 'already opened'", async ({ page }) => {
    const world = newWorld({
      lamports: 40_000_000,
      transfer: transferAt({ status: "active", executed: 0, ageSec: 20 }),
    });
    await reopen(page, world);
    await expect(page.getByTestId("route-tracker")).toBeVisible();
    await expect(page.getByTestId("already-opened")).toHaveCount(0);

    const rows = page.getByTestId("route-stage-row");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toHaveText(/Swapping/);
    await expect(rows.nth(0)).toHaveAttribute("data-state", "done");
    await expect(rows.nth(1)).toHaveText(/Packed/);
    await expect(rows.nth(1)).toHaveAttribute("data-state", "done");
    await expect(page.locator('[data-stage="hops"]')).toHaveText(/Hop 1 of 3/);
    await expect(page.locator('[data-stage="hops"]')).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("route-close-note")).toContainText("Your money arrives either way.");
    await expect(page.getByTestId("route-status-line")).toContainText("Arrives");
    await expect(page.getByTestId("route-late")).toHaveCount(0);
    await shot(page, "tracker-hop-1");

    // Hop by hop, driven by the GET responses.
    world.transfer = transferAt({ status: "active", executed: 1, ageSec: 50 });
    await expect(page.locator('[data-stage="hops"]')).toHaveText(/Hop 2 of 3/);
    await shot(page, "tracker-hop-2");

    world.transfer = transferAt({ status: "active", executed: 2, ageSec: 100 });
    await expect(page.locator('[data-stage="landing"]')).toHaveAttribute("data-state", "active");
    await expect(page.locator('[data-stage="hops"]')).toHaveAttribute("data-state", "done");
    await shot(page, "tracker-landing");

    // Completed: the router is emptied into the recipient and the last row ticks.
    world.transfer = transferAt({ status: "completed", phase: "reclaimed", executed: 3, ageSec: 125 });
    await expect(page.locator('[data-stage="arrived"]')).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("route-status-line")).toHaveText("It arrived. The route is finished.");
    expect(world.sent.length).toBeGreaterThanOrEqual(1);
    // The leftover step follows "In your wallet": collecting, then done with the amount.
    await expect(page.locator('[data-stage="leftover"]')).toHaveText(/Done: 0\.040 SOL sent to your wallet\./);
    await expect(page.getByTestId("route-close-note")).toHaveText(
      "You can close this page. Open this link again any time to check.",
    );

    // Explorer links sit behind "See details", with the cluster suffix only on devnet.
    await page.getByTestId("route-details").locator("summary").click();
    await expect(page.getByTestId("route-hop-link").first()).toHaveAttribute("href", /^https:\/\/solscan\.io\/tx\/SIG0/);
    expect(await page.getByTestId("route-hop-link").first().getAttribute("href")).not.toContain("cluster=");
    await shot(page, "tracker-arrived");

    // Every per-transfer call carried the capability header (32 hex chars).
    expect(world.extHeaders.length).toBeGreaterThan(0);
    for (const h of world.extHeaders) expect(h).toMatch(/^[0-9a-f]{32}$/);
    await noDrainerCopy(page);
  });

  test("a slow route says 'taking longer than usual', never 'failed'", async ({ page }) => {
    const world = newWorld({
      lamports: 40_000_000,
      transfer: transferAt({ status: "active", executed: 1, ageSec: 900 }),
    });
    await reopen(page, world);
    await expect(page.getByTestId("route-late")).toHaveText("Taking longer than usual. Your money is safe.");
    await expect(page.getByTestId("route-failed")).toHaveCount(0);
    await shot(page, "tracker-late");
  });

  test("a refund by the safety check offers a plain send to the recipient", async ({ page }) => {
    const world = newWorld({
      lamports: 300_000_000,
      transfer: transferAt({ status: "refunded", phase: "refunded", executed: 1, ageSec: 200 }),
    });
    await reopen(page, world);
    await expect(page.getByTestId("route-refunded")).toContainText(
      "The safety check sent the money back to this link's wallet",
    );
    await shot(page, "tracker-refunded");
    expect(world.sent).toHaveLength(0);
    await page.getByTestId("route-refund-send").click();
    await expect(page.getByTestId("route-refund-done")).toHaveText("Sent to your wallet.");
    expect(world.sent).toHaveLength(1);
  });

  test("a swept link with a funded router and no transfer asks where to send it, then starts the route", async ({ page }) => {
    const world = newWorld({ lamports: 1_000_000_000 });
    await reopen(page, world);
    await expect(page.getByTestId("route-finish")).toBeVisible();
    await expect(page.getByTestId("route-finish-go")).toBeDisabled();
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(RECIPIENT);
    await page.getByTestId("route-finish-go").click();

    // It sized the route from the balance and created exactly one transfer for this link.
    await expect.poll(() => world.creates.length).toBe(1);
    const create = world.creates[0];
    expect(create.tokenMint).toBe(WSOL);
    expect(create.recipientWallet).toBe(RECIPIENT);
    expect(String(create.externalId)).toMatch(/^[0-9a-f]{32}$/);
    expect(Number(create.amountRaw)).toBeLessThan(1_000_000_000);
    expect(Number(create.amountRaw)).toBeGreaterThan(900_000_000);
    // The route's transactions are not mocked, so it stops with a retry rather than a spinner.
    await expect(page.getByTestId("route-retry")).toBeVisible();
  });

  test("a swept link with nothing in flight is still just 'already opened'", async ({ page }) => {
    await reopen(page, newWorld(), SPENT_FRAGMENT, true);
    await expect(page.getByTestId("already-opened")).toBeVisible();
    await expect(page.getByTestId("route-tracker")).toHaveCount(0);
  });
});

describeOnMock("M6: devnet test build", () => {
  test.setTimeout(120_000);
  test.skip(!DEVNET, "needs a build made with VITE_SOLANA_CLUSTER=devnet and M6_DEVNET=1");

  test("no swap: the router address and a QR to fund it, then the route starts on devnet mints", async ({ page }) => {
    const rail = await mockRail(page, 120);
    const world = newWorld();
    await mockChain(page, world);
    await page.goto(`/e?poll=150#${FRAGMENT}`);
    await page.getByTestId("open-envelope").click();
    await page.getByTestId("receive-it").click();
    await toDestination(page, "usdc");
    await page.getByTestId("swap-mode-paste").click();
    await page.getByTestId("swap-address-input").fill(RECIPIENT);
    await expect(page.getByTestId("swap-get-quote")).toHaveText("Continue");
    await page.getByTestId("swap-get-quote").click();

    await expect(page.getByTestId("route-devnet-badge")).toHaveText("Devnet test build. No real money.");
    await expect(page.getByTestId("route-devnet-fund")).toContainText("Send devnet SOL or USDC here to test");
    const address = (await page.getByTestId("route-router-address").innerText()).trim();
    expect(address.length).toBeGreaterThanOrEqual(32);
    await expect(page.locator("canvas")).toBeVisible();
    // No Swapping row, and the swap rail and the Zcash sweep were never touched.
    await expect(page.locator('[data-stage="swap"]')).toHaveCount(0);
    expect(rail.quotes).toHaveLength(0);
    await shot(page, "devnet-fund");

    // Devnet USDC arrives (and the SOL for the route): the estimate and the create use the devnet mint.
    world.tokens = 5_000_000n;
    world.lamports = 500_000_000;
    await expect.poll(() => world.creates.length).toBe(1);
    expect(world.estimates[0].tokenMint).toBe(USDC_DEVNET);
    expect(world.creates[0].tokenMint).toBe(USDC_DEVNET);
    expect(world.creates[0].amountRaw).toBe("5000000");
    expect(world.creates[0].recipientWallet).toBe(RECIPIENT);
  });

  test("the explorer links carry ?cluster=devnet", async ({ page }) => {
    const world = newWorld({
      lamports: 40_000_000,
      transfer: transferAt({ status: "active", executed: 1, ageSec: 50 }),
    });
    await mockChain(page, world);
    await page.goto(`/e?poll=150#${SPENT_FRAGMENT}`);
    await page.getByTestId("open-envelope").click();
    await page.getByTestId("route-details").locator("summary").click();
    await expect(page.getByTestId("route-hop-link").first()).toHaveAttribute("href", /\?cluster=devnet$/);
    await expect(page.getByTestId("route-router-link")).toHaveAttribute("href", /\?cluster=devnet$/);
  });
});
