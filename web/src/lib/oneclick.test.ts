/**
 * The 1Click client, against a mocked `fetch`.
 *
 * The fixtures are verbatim bodies from the live API on 2026-09-21, trimmed of
 * nothing that this module reads, so a change in the rail's shape breaks a test
 * here rather than a recipient's swap. The recorded run is in
 * web/docs/M5-VERIFICATION.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appFeeBps,
  appFeeDisclosure,
  paidOutAmount,
  ONECLICK_BASE,
  ONECLICK_TIMEOUT_MS,
  OneClickError,
  SOLANA_ASSETS,
  ZEC_ASSET_ID,
  effectiveCost,
  formatAssetAmount,
  formatTimeEstimate,
  formatUsd,
  isFinalStatus,
  oneClickQuote,
  oneClickStatus,
  oneClickTokens,
  parseMinAmount,
  quoteBody,
  solanaTxid,
  zecPriceUsd,
  type OneClickQuote,
} from "./oneclick";

/** A live dry quote for 0.00132 ZEC to USDC, 2026-09-21. */
const DRY_QUOTE = {
  quote: {
    amountIn: "132000",
    amountInFormatted: "0.00132",
    amountInUsd: "1.993569600000",
    minAmountIn: "132000",
    amountOut: "1669370",
    amountOutFormatted: "1.66937",
    amountOutUsd: "1.668867519630",
    minAmountOut: "1652676",
    timeEstimate: 454,
    refundFee: "32000",
    withdrawFee: "298357",
  },
  quoteRequest: {
    dry: true,
    amount: "132000",
    originAsset: ZEC_ASSET_ID,
    destinationAsset: SOLANA_ASSETS.usdc.id,
    refundTo: "t1Ju33aCPGZPXiJzCNb36t5udqueQoSKRuN",
    recipient: "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS",
    appFees: [{ recipient: "5880ad…47dd", fee: 25 }],
  },
  signature: "ed25519:3zUZ…1EDu",
  timestamp: "2026-09-21T02:33:27.939Z",
};

/** The same, with `dry: false`: a reserved transparent deposit address. */
const REAL_QUOTE = {
  ...DRY_QUOTE,
  quote: {
    ...DRY_QUOTE.quote,
    deadline: "2026-09-24T09:00:00.000Z",
    timeWhenInactive: "2026-09-24T09:00:00.000Z",
    depositAddress: "t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd",
  },
  quoteRequest: { ...DRY_QUOTE.quoteRequest, dry: false },
};

const MIN_ERROR = {
  message: "Amount is too low for bridge, try at least 132000",
  correlationId: "9298d720-9929-4e32-8e42-cf778376568a",
  timestamp: "2026-09-21T02:33:15.550Z",
  path: "/v0/quote",
};

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const INPUT = {
  dry: true,
  asset: "usdc" as const,
  amountZat: 132000n,
  refundTo: "u1envelope",
  recipient: "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS",
  now: new Date("2026-09-21T06:00:00.000Z"),
};

describe("the request body", () => {
  it("is exactly what the live API was probed with", () => {
    expect(quoteBody(INPUT)).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:zec.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      amount: "132000",
      refundTo: "u1envelope",
      refundType: "ORIGIN_CHAIN",
      recipient: "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-09-21T09:00:00.000Z",
      quoteWaitingTimeMs: 3000,
    });
  });

  it("sends the SOL asset id when SOL is chosen", () => {
    expect(quoteBody({ ...INPUT, asset: "sol" }).destinationAsset).toBe("nep141:sol.omft.near");
  });

  it("carries the amount as a zatoshi string, never a number", () => {
    expect(quoteBody({ ...INPUT, amountZat: 9007199254740993n }).amount).toBe(
      "9007199254740993",
    );
  });
});

describe("a dry quote", () => {
  it("posts to /quote and hands back the priced body", async () => {
    fetchMock.mockResolvedValue(json(DRY_QUOTE, 201));
    const res = await oneClickQuote(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ONECLICK_BASE}/quote`);
    expect(init.method).toBe("POST");
    // The preflight allows content-type and nothing else, so we send nothing else.
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body).dry).toBe(true);
    expect(res.quote.amountOut).toBe("1669370");
  });

  it("does not demand a deposit address", async () => {
    fetchMock.mockResolvedValue(json(DRY_QUOTE, 201));
    await expect(oneClickQuote(INPUT)).resolves.toBeTruthy();
  });
});

describe("a real quote", () => {
  it("returns the transparent deposit address and the server's deadline", async () => {
    fetchMock.mockResolvedValue(json(REAL_QUOTE, 201));
    const res = await oneClickQuote({ ...INPUT, dry: false });
    expect(res.quote.depositAddress).toMatch(/^t1[1-9A-HJ-NP-Za-km-z]{20,}$/);
    expect(res.quote.deadline).toBe("2026-09-24T09:00:00.000Z");
  });

  it("refuses a body with no deposit address in it", async () => {
    fetchMock.mockResolvedValue(json(DRY_QUOTE, 201));
    await expect(oneClickQuote({ ...INPUT, dry: false })).rejects.toMatchObject({
      kind: "malformed",
    });
  });
});

describe("the minimum", () => {
  it("is read out of the 400 body rather than hard-coded", () => {
    expect(parseMinAmount(MIN_ERROR.message)).toBe(132000n);
    expect(parseMinAmount("try at least 250000 please")).toBe(250000n);
    expect(parseMinAmount("Amount is too low for bridge")).toBeNull();
    expect(parseMinAmount("something else entirely")).toBeNull();
  });

  it("comes back as a min_amount error carrying the floor", async () => {
    fetchMock.mockResolvedValue(json(MIN_ERROR, 400));
    const err = await oneClickQuote({ ...INPUT, amountZat: 90000n }).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err.kind).toBe("min_amount");
    expect(err.status).toBe(400);
    expect(err.minAmountZat).toBe(132000n);
    expect(err.message).toBe("Amount is too low for bridge, try at least 132000");
  });

  it("is not confused with any other 400", async () => {
    fetchMock.mockResolvedValue(json({ message: "refundTo is not valid" }, 400));
    const err = await oneClickQuote(INPUT).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.minAmountZat).toBeNull();
    expect(err.message).toBe("refundTo is not valid");
  });
});

describe("failures that are not the rail's answer", () => {
  it("gives up after the timeout, and says so", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.useFakeTimers();
    const pending = oneClickQuote(INPUT).catch((e) => e);
    await vi.advanceTimersByTimeAsync(ONECLICK_TIMEOUT_MS + 10);
    const err = await pending;
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/did not answer within 10 seconds/);
  });

  it("reports an unreachable rail as a network error, not a crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await oneClickQuote(INPUT).catch((e) => e);
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/Could not reach the swap service/);
  });

  it("reports an unparseable 2xx as malformed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const err = await oneClickQuote(INPUT).catch((e) => e);
    expect(err.kind).toBe("malformed");
  });

  it("falls back to a readable sentence when the rail sends no message", async () => {
    fetchMock.mockResolvedValue(json({}, 502));
    const err = await oneClickQuote(INPUT).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.message).toBe("The swap service answered 502.");
  });
});

describe("tokens", () => {
  it("lists them and finds the ZEC price", async () => {
    fetchMock.mockResolvedValue(
      json([
        { assetId: ZEC_ASSET_ID, decimals: 8, blockchain: "zec", symbol: "ZEC", price: 1511.16 },
        { assetId: SOLANA_ASSETS.sol.id, decimals: 9, blockchain: "sol", symbol: "SOL", price: 111.77 },
      ]),
    );
    const tokens = await oneClickTokens();
    expect(tokens).toHaveLength(2);
    expect(zecPriceUsd(tokens)).toBe(1511.16);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ONECLICK_BASE}/tokens`);
  });

  it("refuses a body that is not a list", async () => {
    fetchMock.mockResolvedValue(json({ tokens: [] }));
    await expect(oneClickTokens()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("has no ZEC price when the list does not carry one", () => {
    expect(zecPriceUsd([{ assetId: "x", decimals: 6, blockchain: "sol", symbol: "X" }])).toBeNull();
  });
});

describe("status", () => {
  it("asks about one deposit address, url-encoded", async () => {
    fetchMock.mockResolvedValue(json({ status: "PENDING_DEPOSIT", updatedAt: "now" }));
    const res = await oneClickStatus("t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${ONECLICK_BASE}/status?depositAddress=t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd`,
    );
    expect(res.status).toBe("PENDING_DEPOSIT");
  });

  it("knows which statuses end the wait", () => {
    expect(isFinalStatus("PENDING_DEPOSIT")).toBe(false);
    expect(isFinalStatus("PROCESSING")).toBe(false);
    expect(isFinalStatus("SUCCESS")).toBe(true);
    expect(isFinalStatus("REFUNDED")).toBe(true);
    expect(isFinalStatus("FAILED")).toBe(true);
  });

  it("finds the Solana transaction id in either shape the rail uses", () => {
    expect(
      solanaTxid({
        status: "SUCCESS",
        updatedAt: "now",
        swapDetails: { destinationChainTxHashes: [{ hash: "5xAbC" }] },
      }),
    ).toBe("5xAbC");
    expect(
      solanaTxid({
        status: "SUCCESS",
        updatedAt: "now",
        swapDetails: { destinationChainTxHashes: ["5xAbC"] },
      }),
    ).toBe("5xAbC");
    expect(
      solanaTxid({ status: "PENDING_DEPOSIT", updatedAt: "now", swapDetails: { destinationChainTxHashes: [] } }),
    ).toBeNull();
    expect(solanaTxid({ status: "PENDING_DEPOSIT", updatedAt: "now" })).toBeNull();
  });

  it("reports a 404 as an ordinary http error", async () => {
    fetchMock.mockResolvedValue(json({ message: "Deposit address t1… not found" }, 404));
    const err = await oneClickStatus("t1nope").catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(404);
  });
});

describe("what it actually costs", () => {
  const quote = DRY_QUOTE.quote as OneClickQuote;

  it("is the whole USD difference, not just the rate", () => {
    const cost = effectiveCost(quote);
    expect(cost.ok).toBe(true);
    // 1 - 1.66886752 / 1.99356960 = 0.16288…
    expect(cost.spread).toBeCloseTo(0.16288, 4);
    expect(cost.spreadBps).toBe(1629);
    expect(cost.spreadPct).toBe("16.29%");
    expect(cost.costUsd).toBeCloseTo(0.3247, 4);
  });

  it("restates the rail's service fee from the quote's appFees, not a constant", () => {
    const bps = appFeeBps(DRY_QUOTE);
    expect(bps).toBe(25);
    const cost = effectiveCost(quote, bps);
    expect(cost.appFeeBps).toBe(25);
    expect(cost.disclosure).toMatch(/includes a 0\.25% service fee to the swap provider/);
  });

  it("refuses to do arithmetic on figures the rail did not send", () => {
    const cost = effectiveCost({ ...quote, amountInUsd: "", amountOutUsd: "" });
    expect(cost.ok).toBe(false);
    expect(cost.spreadPct).toBe("—");
    expect(formatUsd(cost.amountInUsd)).toBe("—");
  });
});

describe("the figures on screen", () => {
  const quote = DRY_QUOTE.quote as OneClickQuote;

  it("shows the rail's own formatted amount with its symbol", () => {
    expect(formatAssetAmount(quote, "usdc")).toBe("1.66937 USDC");
  });

  it("falls back to the raw units when there is no formatted figure", () => {
    expect(formatAssetAmount({ ...quote, amountOutFormatted: "" }, "usdc")).toBe("1.669370 USDC");
  });

  it("turns 454 seconds into about 8 minutes", () => {
    expect(formatTimeEstimate(454)).toBe("about 8 minutes");
    expect(formatTimeEstimate(30)).toBe("about 1 minute");
    expect(formatTimeEstimate(0)).toBe("a few minutes");
  });

  it("formats dollars to the cent", () => {
    expect(formatUsd(1.668867519)).toBe("$1.67");
    expect(formatUsd(Number.NaN)).toBe("—");
  });
});

describe("the rail's service fee, from appFees", () => {
  it("sums every entry, in basis points", () => {
    const two = { quoteRequest: { appFees: [{ recipient: "a", fee: 25 }, { recipient: "b", fee: 10 }] } };
    expect(appFeeBps(two)).toBe(35);
    expect(appFeeDisclosure(35)).toMatch(/includes a 0\.35% service fee to the swap provider/);
    expect(appFeeBps({ appFees: [{ recipient: "a", fee: 50 }] })).toBe(50);
    expect(appFeeBps({ quoteRequest: { appFees: [] } })).toBe(0);
    expect(appFeeDisclosure(0)).toMatch(/0\.00% service fee/);
  });

  it("says the fee may be there when the field is absent, never a made-up figure", () => {
    expect(appFeeBps({ quoteRequest: {} })).toBeNull();
    expect(appFeeBps(null)).toBeNull();
    const cost = effectiveCost(DRY_QUOTE.quote as OneClickQuote);
    expect(cost.appFeeBps).toBeNull();
    expect(cost.disclosure).toBe("The swap provider may charge a service fee included in the quote.");
    expect(cost.disclosure).not.toMatch(/0\.25/);
  });
});

describe("what the rail actually paid out", () => {
  // The final GET /status of the live swap on 2026-09-24 (M5-VERIFICATION §7).
  const LIVE_SUCCESS = {
    status: "SUCCESS",
    updatedAt: "2026-09-24T10:38:39.000Z",
    swapDetails: {
      amountOut: "14400612",
      amountOutFormatted: "14.400612",
      amountOutUsd: "14.397285458628",
      refundedAmount: "0",
      refundReason: null,
      originChainTxHashes: [],
      destinationChainTxHashes: [{ hash: "2VTVZPoz" }],
    },
  };

  it("reads swapDetails.amountOutFormatted after SUCCESS", () => {
    expect(paidOutAmount(LIVE_SUCCESS, "usdc")).toBe("14.400612 USDC");
  });

  it("falls back to the raw amountOut in the asset's smallest unit", () => {
    const raw = { ...LIVE_SUCCESS, swapDetails: { ...LIVE_SUCCESS.swapDetails, amountOutFormatted: null } };
    expect(paidOutAmount(raw, "usdc")).toBe("14.400612 USDC");
    const sol = { ...LIVE_SUCCESS, swapDetails: { amountOut: "5000000" } };
    expect(paidOutAmount(sol, "sol")).toBe("0.005000000 SOL");
  });

  it("is null before SUCCESS and when the status carries no amount", () => {
    expect(paidOutAmount({ ...LIVE_SUCCESS, status: "PROCESSING" }, "usdc")).toBeNull();
    expect(paidOutAmount({ status: "SUCCESS", updatedAt: "", swapDetails: {} }, "usdc")).toBeNull();
    expect(paidOutAmount({ status: "SUCCESS", updatedAt: "" }, "usdc")).toBeNull();
    expect(paidOutAmount(null, "usdc")).toBeNull();
  });
});
