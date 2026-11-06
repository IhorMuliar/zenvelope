/**
 * The private route as a state machine, in the style of solanaFlow.ts: a pure reducer,
 * nothing here touches the network, the clock or a key.
 *
 *   estimating -> funding -> creating -> signing -> routing -> done
 *                                                         \-> refunded | failed
 *
 * Every state is resumable from the link: {@link resumeFrom} picks the phase from what
 * `GET by-external` and the router balance say when the link is reopened.
 */

import type { MhEstimate, MhTransfer } from "./multihop";

export type MhPhase =
  | "estimating"
  | "funding"
  | "creating"
  | "signing"
  | "routing"
  | "done"
  | "refunded"
  | "failed";

/** What the router must hold before a transfer can be created. */
export interface FundingNeeds {
  /** Lamports: SOL route = amount + overhead; SPL route = overhead only. */
  lamports: number;
  /** Raw token units for an SPL route; 0 for a SOL route. */
  tokenRaw: bigint;
}

export interface RouterBalance {
  lamports: number;
  tokenRaw: bigint;
}

export interface HopProgress {
  done: number;
  total: number;
}

export interface MhFlowState {
  phase: MhPhase;
  estimate: MhEstimate | null;
  needs: FundingNeeds | null;
  balance: RouterBalance | null;
  transfer: MhTransfer | null;
  /** 1-based step of the signing phase. */
  step: { index: number; total: number; label: string } | null;
  hops: HopProgress | null;
  error: string | null;
}

export const initialMhState: MhFlowState = {
  phase: "estimating",
  estimate: null,
  needs: null,
  balance: null,
  transfer: null,
  step: null,
  hops: null,
  error: null,
};

export type MhEvent =
  | { type: "estimated"; estimate: MhEstimate; needs: FundingNeeds }
  | { type: "balance"; balance: RouterBalance }
  | { type: "created"; transfer: MhTransfer }
  | { type: "step"; index: number; total: number; label: string }
  | { type: "broadcast"; transfer: MhTransfer }
  | { type: "polled"; transfer: MhTransfer }
  | { type: "failed"; message: string }
  | { type: "retry" };

/** Hop progress from `route.hops[].executedAt`. `progress.hopsTotal` counts 2x on the wire. */
export function hopProgress(t: MhTransfer): HopProgress {
  const hops = t.route?.hops ?? [];
  return { done: hops.filter((h) => h.executedAt).length, total: hops.length || t.hops };
}

export function fundingReached(needs: FundingNeeds, b: RouterBalance): boolean {
  return b.lamports >= needs.lamports && b.tokenRaw >= needs.tokenRaw;
}

/**
 * Where a transfer, as the API reports it, belongs. Statuses measured on devnet:
 * quote, awaiting_signature, processing, active, completed. The refund and failure
 * names are not measured yet (unverified), so they are matched loosely.
 */
export function phaseForTransfer(t: MhTransfer): MhPhase {
  const s = (t.status ?? "").toLowerCase();
  const ph = (t.phase ?? "").toLowerCase();
  if (s === "completed") return "done";
  if (s.includes("refund") || ph.includes("refund")) return "refunded";
  if (s === "failed" || s === "cancelled" || s === "canceled" || s === "expired") return "failed";
  if (s === "active") return "routing";
  // quote, awaiting_signature, processing: something is still unsigned or unconfirmed.
  return "signing";
}

function withTransfer(state: MhFlowState, transfer: MhTransfer): MhFlowState {
  const phase = phaseForTransfer(transfer);
  return {
    ...state,
    phase,
    transfer,
    step: phase === "signing" ? state.step : null,
    hops: phase === "routing" || phase === "done" ? hopProgress(transfer) : state.hops,
    error: phase === "failed" ? "The route could not finish." : null,
  };
}

export function mhReducer(state: MhFlowState, event: MhEvent): MhFlowState {
  switch (event.type) {
    case "estimated":
      return { ...state, phase: "funding", estimate: event.estimate, needs: event.needs, error: null };
    case "balance": {
      const next = { ...state, balance: event.balance };
      if (state.phase === "funding" && state.needs && fundingReached(state.needs, event.balance)) {
        return { ...next, phase: "creating" };
      }
      return next;
    }
    case "created":
      return withTransfer({ ...state, phase: "signing" }, event.transfer);
    case "step":
      return state.phase === "signing"
        ? { ...state, step: { index: event.index, total: event.total, label: event.label } }
        : state;
    case "broadcast":
    case "polled":
      // A late poll must not drag a finished route back.
      if (state.phase === "done" || state.phase === "refunded") return state;
      return withTransfer(state, event.transfer);
    case "failed":
      return { ...state, phase: "failed", error: event.message };
    case "retry":
      if (state.phase !== "failed") return state;
      if (state.transfer) {
        const p = phaseForTransfer(state.transfer);
        return { ...state, error: null, phase: p === "failed" ? "signing" : p };
      }
      return { ...state, error: null, phase: state.needs ? "creating" : "estimating" };
  }
}

/**
 * Phase on reopening a link: a transfer found by external id decides it; with none, the
 * router balance does. `needs` is known only once an estimate has been made.
 */
export function resumeFrom(
  transfer: MhTransfer | null,
  routerBalance: RouterBalance,
  needs?: FundingNeeds,
): MhFlowState {
  if (transfer) return withTransfer({ ...initialMhState, balance: routerBalance, needs: needs ?? null }, transfer);
  const funded = routerBalance.lamports > 0 || routerBalance.tokenRaw > 0n;
  let phase: MhPhase = "estimating";
  if (needs && fundingReached(needs, routerBalance)) phase = "creating";
  else if (funded || needs) phase = "funding";
  return { ...initialMhState, phase, balance: routerBalance, needs: needs ?? null };
}

// ---------------------------------------------------------------------------
// Is the route worth its fixed SOL cost?

/** Largest share of the gift the route's SOL overhead may take. */
export const MAX_OVERHEAD_FRACTION = 0.05;
/** Devnet measured overhead 6% above the estimate (36.2M vs 34.1M lamports). */
export const OVERHEAD_BUFFER_BPS = 1000;

export interface OverheadVerdict {
  ok: boolean;
  overheadLamports: number;
  overheadUsd: number;
  /** overheadUsd / giftUsd. */
  fraction: number;
  /** Smallest gift for which the route passes. */
  minGiftUsd: number;
}

/**
 * Net SOL overhead = the estimate's `netCostLamports` (required up front minus the
 * refundable part) less the principal when the gift itself is SOL, since for a SOL route
 * `netCostLamports` includes the amount. A 10% buffer covers the measured shortfall.
 * `solUsd` is injected (price feed or a pinned number).
 */
export function overheadOk(
  estimate: MhEstimate,
  giftUsd: number,
  solUsd: number,
  opts: { isSolRoute: boolean; maxFraction?: number } = { isSolRoute: false },
): OverheadVerdict {
  const principal = opts.isSolRoute ? Number(estimate.tokens.amountRaw) : 0;
  const net = Math.max(0, estimate.sol.netCostLamports - principal);
  const overheadLamports = Math.ceil((net * (10_000 + OVERHEAD_BUFFER_BPS)) / 10_000);
  const overheadUsd = (overheadLamports / 1e9) * solUsd;
  const max = opts.maxFraction ?? MAX_OVERHEAD_FRACTION;
  const fraction = giftUsd > 0 ? overheadUsd / giftUsd : Infinity;
  return { ok: giftUsd > 0 && fraction <= max, overheadLamports, overheadUsd, fraction, minGiftUsd: overheadUsd / max };
}
