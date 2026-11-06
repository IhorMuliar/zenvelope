/**
 * Pure arithmetic for the private route: what it costs, whether it is worth it, and how
 * much of each asset the router wallet must hold. No network, no clock, no key.
 *
 * The route needs SOL up front whatever the gift is worth (rent, keeper funding,
 * screening; measured on devnet, docs/MULTIHOPPER-PLAN.md "Phase 0 results"). A USDC
 * gift therefore buys that SOL with a second 1Click swap whose output also lands in the
 * router wallet; a SOL gift just keeps the overhead out of its own amount.
 */

import { overheadOk, type OverheadVerdict } from "./multihopFlow";
import type { MhEstimate } from "./multihop";
import type { OneClickQuote } from "./oneclick";

/** Transactions the router may send over a route's life, for fee budgeting. */
export const ROUTE_TX_ALLOWANCE = 30;
export const TX_FEE_LAMPORTS = 5000;
/** Extra SOL on top of the estimate, in basis points (15%). */
export const SOL_MARGIN_BPS = 1500;
/** The route is capped at this gift value while MultiHopper's contracts are unaudited. */
export const MAX_ROUTE_USD = 1000;
/** Typical seconds from the first route transaction to the funds landing (measured: 123-155 s). */
export const ROUTE_SECONDS = 155;
/**
 * Gifts worth less than this never get the offer or the "available over $X" line: no
 * plausible SOL price makes the route pay at this size, and finding out would cost a
 * second swap quote and an estimate call for nothing.
 */
export const MIN_OFFER_USD = 10;
/** MultiHopper's fee: 0.5% of the gift. */
export const ROUTE_FEE_PCT = 0.5;
/** A system account holds at least this much (rent exemption of a 0-byte account). */
export const MIN_SYSTEM_BALANCE_LAMPORTS = 890_880;

/** The least SOL the router must hold for the route, with no margin. */
export function routeSolFloor(estimate: MhEstimate): number {
  return estimate.sol.requiredSolUpFrontLamports + ROUTE_TX_ALLOWANCE * TX_FEE_LAMPORTS;
}

/** The SOL the extra swap must deliver: the floor plus 15%. */
export function extraLamportsNeeded(estimate: MhEstimate): number {
  return Math.ceil((routeSolFloor(estimate) * (10_000 + SOL_MARGIN_BPS)) / 10_000);
}

/**
 * First guess for the ZEC that buys `needLamports`, from a probe quote that turned
 * `probeInZat` into `probeOutLamports`. The probe's rate is flattered by the flat
 * withdrawal fee being spread over a bigger amount, so {@link sizeExtraZat} corrects it.
 */
export function guessExtraZat(needLamports: number, probeInZat: bigint, probeOutLamports: bigint): bigint {
  if (probeOutLamports <= 0n || probeInZat <= 0n) throw new Error("the probe quote has no output");
  const num = BigInt(needLamports) * probeInZat * 102n;
  const den = probeOutLamports * 100n;
  return (num + den - 1n) / den;
}

/**
 * Finds a ZEC amount whose SOL quote delivers at least `needLamports` (the quote's
 * *minimum* output, so a rate move inside slippage cannot leave the route short).
 * `minOut(zat)` asks a dry quote. It converges in two or three rounds because the cost
 * is a flat fee plus a rate.
 */
export async function sizeExtraZat(
  needLamports: number,
  firstGuessZat: bigint,
  minOut: (zat: bigint) => Promise<bigint>,
  maxRounds = 4,
): Promise<bigint> {
  let zat = firstGuessZat;
  const need = BigInt(needLamports);
  for (let round = 0; round < maxRounds; round += 1) {
    const out = await minOut(zat);
    if (out >= need) return zat;
    if (out <= 0n) throw new Error("the swap service quoted no SOL for the route");
    zat = (zat * need * 102n) / (out * 100n) + 1n;
  }
  throw new Error("could not size the SOL for the route");
}

/**
 * SOL route amount: the router's balance less the up-front overhead (+15%), the
 * transaction allowance and the final sweep's fee. `estimateAtBalance` is the estimate
 * for a route of the whole balance, whose `requiredSolUpFront` includes that principal.
 */
export function solRouteAmount(balanceLamports: number, estimateAtBalance: MhEstimate): number {
  const principal = Number(estimateAtBalance.tokens.amountRaw);
  const overhead = Math.max(0, estimateAtBalance.sol.requiredSolUpFrontLamports - principal);
  const reserve =
    Math.ceil((overhead * (10_000 + SOL_MARGIN_BPS)) / 10_000) +
    ROUTE_TX_ALLOWANCE * TX_FEE_LAMPORTS +
    TX_FEE_LAMPORTS;
  return Math.max(0, balanceLamports - reserve);
}

/** SOL USD price out of a SOL quote: its output's USD value over its output amount. */
export function solUsdFromQuote(quote: OneClickQuote): number {
  const usd = Number(quote.amountOutUsd);
  const sol = Number(quote.amountOut) / 1e9;
  return Number.isFinite(usd) && sol > 0 ? usd / sol : Number.NaN;
}

/** Whole minutes, rounded up, for "arrives in about N min". */
export function etaMinutes(oneClickSeconds: number): number {
  const swap = Number.isFinite(oneClickSeconds) && oneClickSeconds > 0 ? oneClickSeconds : 0;
  return Math.max(1, Math.ceil((swap + ROUTE_SECONDS) / 60));
}

/** "$X" in "available for gifts over $X": the break-even gift, rounded up to $5. */
export function thresholdUsd(minGiftUsd: number): number {
  if (!Number.isFinite(minGiftUsd)) return MAX_ROUTE_USD;
  return Math.max(5, Math.ceil(minGiftUsd / 5) * 5);
}

export interface RoutePricing {
  /** The toggle is shown. */
  available: boolean;
  /** Why not: the gift is too small for the overhead, or over the cap. */
  reason: "small" | "large" | null;
  verdict: OverheadVerdict;
  giftUsd: number;
  /** "Private route is available for gifts over $X". */
  thresholdUsd: number;
  /** About what the recipient ends with: gift less 0.5% and the SOL overhead. */
  receiveUsd: number;
  /** The SOL overhead in USD, for "about $B network". */
  networkUsd: number;
  minutes: number;
}

export function pricePrivateRoute(p: {
  estimate: MhEstimate;
  giftUsd: number;
  solUsd: number;
  isSolRoute: boolean;
  oneClickSeconds: number;
}): RoutePricing {
  const verdict = overheadOk(p.estimate, p.giftUsd, p.solUsd, { isSolRoute: p.isSolRoute });
  const large = p.giftUsd > MAX_ROUTE_USD;
  const networkUsd = verdict.overheadUsd;
  const receiveUsd = Math.max(0, p.giftUsd * (1 - ROUTE_FEE_PCT / 100) - networkUsd);
  return {
    available: verdict.ok && !large && Number.isFinite(p.solUsd),
    reason: large ? "large" : verdict.ok ? null : "small",
    verdict,
    giftUsd: p.giftUsd,
    thresholdUsd: thresholdUsd(verdict.minGiftUsd),
    receiveUsd,
    networkUsd,
    minutes: etaMinutes(p.oneClickSeconds),
  };
}
