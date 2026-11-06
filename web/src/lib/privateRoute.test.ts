import { describe, expect, it } from "vitest";
import estimateSol from "./__fixtures__/mh-estimate-sol.json";
import type { MhEstimate } from "./multihop";
import type { OneClickQuote } from "./oneclick";
import {
  MAX_ROUTE_USD,
  extraLamportsNeeded,
  etaMinutes,
  guessExtraZat,
  pricePrivateRoute,
  routeSolFloor,
  sizeExtraZat,
  solRouteAmount,
  solUsdFromQuote,
  thresholdUsd,
} from "./privateRoute";

const est = estimateSol as unknown as MhEstimate;

describe("funding sizing", () => {
  it("the floor is the up-front SOL plus 30 transactions of fees", () => {
    expect(routeSolFloor(est)).toBe(350_210_313 + 150_000);
  });
  it("the extra swap asks for the floor plus 15%", () => {
    expect(extraLamportsNeeded(est)).toBe(Math.ceil((350_210_313 + 150_000) * 1.15));
  });
  it("a SOL route keeps the overhead (+15%), the tx allowance and the sweep fee out of the amount", () => {
    const balance = 1_000_000_000;
    const overhead = 350_210_313 - 300_000_000;
    const reserve = Math.ceil(overhead * 1.15) + 150_000 + 5000;
    expect(solRouteAmount(balance, est)).toBe(balance - reserve);
    expect(solRouteAmount(10_000_000, est)).toBe(0);
  });
});

describe("sizeExtraZat", () => {
  // A quote with a flat withdrawal fee: out = rate*zat - fee, so a proportional guess falls short.
  const rate = 4_000n; // lamports per zat
  const fee = 2_000_000n;
  const minOut = async (zat: bigint) => {
    const out = rate * zat - fee;
    return out > 0n ? out : 0n;
  };

  it("converges on an amount whose minimum output covers the need", async () => {
    const need = 400_000_000;
    const probeIn = 100_000_000n;
    const guess = guessExtraZat(need, probeIn, rate * probeIn - fee);
    const zat = await sizeExtraZat(need, guess, minOut);
    expect(await minOut(zat)).toBeGreaterThanOrEqual(BigInt(need));
    // and not wildly over: within 5% of the exact answer
    const exact = (BigInt(need) + fee) / rate;
    expect(zat).toBeLessThan((exact * 105n) / 100n);
  });

  it("refuses a quote with no output", async () => {
    await expect(sizeExtraZat(1000, 10n, async () => 0n)).rejects.toThrow(/no SOL/);
  });

  it("gives up rather than loop", async () => {
    await expect(sizeExtraZat(1_000_000, 10n, async () => 1n, 3)).rejects.toThrow(/could not size/);
  });
});

describe("pricing", () => {
  const solUsd = 90;
  it("hides the toggle for a small gift and names the break-even", () => {
    const p = pricePrivateRoute({ estimate: est, giftUsd: 40, solUsd, isSolRoute: true, oneClickSeconds: 120 });
    expect(p.available).toBe(false);
    expect(p.reason).toBe("small");
    expect(p.thresholdUsd).toBeGreaterThan(40);
    expect(p.thresholdUsd % 5).toBe(0);
  });
  it("shows it above the threshold, with the figures the screen prints", () => {
    const p = pricePrivateRoute({ estimate: est, giftUsd: 1000, solUsd, isSolRoute: true, oneClickSeconds: 120 });
    expect(p.available).toBe(true);
    expect(p.receiveUsd).toBeLessThan(1000);
    expect(p.receiveUsd).toBeCloseTo(1000 * 0.995 - p.networkUsd, 6);
    expect(p.minutes).toBe(5);
  });
  it("hides it again over the cap while the contracts are unaudited", () => {
    const p = pricePrivateRoute({ estimate: est, giftUsd: MAX_ROUTE_USD + 1, solUsd, isSolRoute: true, oneClickSeconds: 0 });
    expect(p.available).toBe(false);
    expect(p.reason).toBe("large");
  });
  it("hides it when the SOL price is unknown", () => {
    const p = pricePrivateRoute({ estimate: est, giftUsd: 500, solUsd: Number.NaN, isSolRoute: true, oneClickSeconds: 0 });
    expect(p.available).toBe(false);
  });
  it("rounds the threshold up to $5", () => {
    expect(thresholdUsd(61.2)).toBe(65);
    expect(thresholdUsd(0.2)).toBe(5);
  });
  it("derives the SOL price from a quote and the minutes from the rail's estimate", () => {
    const q = { amountOut: "500000000", amountOutUsd: "45" } as OneClickQuote;
    expect(solUsdFromQuote(q)).toBe(90);
    expect(etaMinutes(454)).toBe(11);
    expect(etaMinutes(0)).toBe(3);
  });
});
