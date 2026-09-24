/**
 * The Solana exit, as a state machine.
 *
 *   trust -> asset -> destination -> quote -> deposit -> (the ordinary sweep)
 *     ^        |           |           |
 *     +--------+-----------+-----------+   back, at every step
 *
 * Five steps and then it hands over: once a real quote has reserved a
 * transparent deposit address, the Solana part is finished and the money moves
 * with exactly the same `sweep_envelope` call as a pasted `t1`. Nothing in this
 * file knows about the core, the secret or a transaction.
 *
 * Kept out of the component for the usual reason: the gate that stops a
 * recipient reaching a deposit address without ticking the trust boundary, and
 * the gate that stops them reaching it without having saved a generated secret
 * key, are rules worth testing without a DOM.
 */

import type {
  OneClickQuote,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  SolanaAsset,
} from "./oneclick";
import { SOLANA_ASSETS, STATUS_POLL_MS, effectiveCost, isFinalStatus } from "./oneclick";
import { checkSolanaAddress } from "./solana";
import type { SolanaKeypair } from "./solana";
import { MAX_SPREAD_BPS } from "../config";
import { solanaExit as copy } from "../copy/en";
import type { AddressKind } from "../core/types";

export type SolanaPhase = "trust" | "asset" | "destination" | "quote" | "deposit";

/** How the recipient gets a Solana address: they have one, or the page makes one. */
export type DestinationMode = "paste" | "generate";

/** The verdict on the refund override. See {@link SolanaExitState.refundStatus}. */
export type RefundStatus = "default" | "checking" | "ok" | "bad";

/** What a real quote reserved. The deposit address is an ordinary ZEC `t1`. */
export interface DepositReservation {
  /** Transparent ZEC address. No memo: the address itself identifies the swap. */
  address: string;
  /** ISO, about three days out. The server sets it, not us. */
  deadline: string | null;
  quote: OneClickQuote;
  /**
   * What the rail says we asked for, kept so it can be compared with what we
   * actually asked for before a single zatoshi moves ({@link checkSwapPlan}).
   */
  quoteRequest: OneClickQuoteResponse["quoteRequest"];
  /** The rail's service fees, when the response carried them at the top level. */
  appFees?: OneClickQuoteResponse["appFees"];
}

export interface SolanaExitState {
  phase: SolanaPhase;
  /** The trust-boundary tick. The only way out of `trust`. */
  acknowledged: boolean;
  asset: SolanaAsset | null;
  mode: DestinationMode | null;
  /** Exactly what was pasted, untrimmed. */
  pasted: string;
  /** Generated here, shown once, stored nowhere. */
  keypair: SolanaKeypair | null;
  /** "I saved it". Required before a generated key may be used. */
  savedKey: boolean;
  keypairError: string | null;
  /**
   * Where a failed swap sends the ZEC back. Empty means the envelope's own
   * address, which is the default and what almost everyone should use
   * (DECISIONS D14).
   */
  refundOverride: string;
  /**
   * What the core made of {@link refundOverride}. "default" is the empty box —
   * the envelope's own address, which the link derived and is payable by
   * construction. Anything typed is "checking" until the core answers, and a
   * quote cannot be asked for until it answers "ok" (M4).
   */
  refundStatus: RefundStatus;
  /** Why the override was refused, when it was. */
  refundMessage: string | null;
  /** The last dry quote. */
  quote: OneClickQuoteResponse | null;
  /** A request is in flight: every button that starts another one is off. */
  busy: boolean;
  error: string | null;
  /** The rail's floor, in zatoshi, when it has told us one. */
  minAmountZat: bigint | null;
  deposit: DepositReservation | null;
}

export const initialSolanaExitState: SolanaExitState = {
  phase: "trust",
  acknowledged: false,
  asset: null,
  mode: null,
  pasted: "",
  keypair: null,
  savedKey: false,
  keypairError: null,
  refundOverride: "",
  refundStatus: "default",
  refundMessage: null,
  quote: null,
  busy: false,
  error: null,
  minAmountZat: null,
  deposit: null,
};

export type SolanaExitEvent =
  | { type: "ack"; value: boolean }
  | { type: "toAsset" }
  | { type: "asset"; asset: SolanaAsset }
  | { type: "mode"; mode: DestinationMode }
  | { type: "pasted"; value: string }
  | { type: "keypair"; keypair: SolanaKeypair }
  | { type: "keypairError"; message: string }
  | { type: "savedKey"; value: boolean }
  | { type: "refund"; value: string }
  | { type: "refundVerdict"; input: string; ok: boolean; message: string | null }
  | { type: "busy" }
  | { type: "quote"; quote: OneClickQuoteResponse }
  | { type: "quoteError"; message: string; minAmountZat?: bigint | null }
  | { type: "deposit"; reservation: DepositReservation }
  | { type: "back" }
  | { type: "reset" };

/** The step before this one, so one "back" handles every screen. */
function previousPhase(phase: SolanaPhase): SolanaPhase {
  switch (phase) {
    case "deposit":
      return "quote";
    case "quote":
      return "destination";
    case "destination":
      return "asset";
    default:
      return "trust";
  }
}

export function solanaExitReducer(
  state: SolanaExitState,
  event: SolanaExitEvent,
): SolanaExitState {
  switch (event.type) {
    case "ack":
      return { ...state, acknowledged: event.value };

    // The gate. Ticking the box is the only thing that opens it, and the caller
    // cannot get past this by dispatching harder.
    case "toAsset":
      return state.phase === "trust" && state.acknowledged
        ? { ...state, phase: "asset" }
        : state;

    case "asset":
      return { ...state, asset: event.asset, phase: "destination", error: null };

    case "mode":
      return {
        ...state,
        mode: event.mode,
        error: null,
        // Switching away from a generated key drops it: it was never usable
        // anywhere else, and leaving it in state would keep it on screen.
        keypair: event.mode === "generate" ? state.keypair : null,
        savedKey: event.mode === "generate" ? state.savedKey : false,
        pasted: event.mode === "paste" ? state.pasted : "",
      };

    case "pasted":
      return { ...state, pasted: event.value, error: null };

    case "keypair":
      return { ...state, keypair: event.keypair, keypairError: null, savedKey: false };

    case "keypairError":
      return { ...state, keypair: null, keypairError: event.message };

    case "savedKey":
      return { ...state, savedKey: event.value };

    case "refund":
      return {
        ...state,
        refundOverride: event.value,
        // Every keystroke puts the verdict back to unknown, so a quote can never
        // be asked for on the strength of a verdict about earlier text.
        refundStatus: event.value.trim() === "" ? "default" : "checking",
        refundMessage: null,
        error: null,
      };

    // The core's answer, tagged with the text it was asked about: an answer that
    // has been typed past is dropped rather than allowed to land late.
    case "refundVerdict":
      if (event.input !== state.refundOverride.trim() || event.input === "") return state;
      return {
        ...state,
        refundStatus: event.ok ? "ok" : "bad",
        refundMessage: event.ok ? null : event.message,
      };

    case "busy":
      return { ...state, busy: true, error: null };

    case "quote":
      return { ...state, busy: false, quote: event.quote, error: null, phase: "quote" };

    case "quoteError":
      return {
        ...state,
        busy: false,
        error: event.message,
        minAmountZat: event.minAmountZat ?? state.minAmountZat,
        // A floor error is still useful on the review screen, so a quote that
        // already succeeded once is not thrown away by a later failure.
        phase: state.phase === "deposit" ? "quote" : state.phase,
      };

    case "deposit":
      return { ...state, busy: false, deposit: event.reservation, phase: "deposit", error: null };

    case "back":
      return { ...state, phase: previousPhase(state.phase), busy: false, error: null };

    case "reset":
      return { ...initialSolanaExitState };

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ the gates */

/** The Solana address the rail would pay out to. "" when there is not one yet. */
export function recipientAddress(state: SolanaExitState): string {
  if (state.mode === "generate") return state.keypair?.address ?? "";
  return state.pasted.trim();
}

/**
 * True when there is a usable Solana destination.
 *
 * A generated key counts only once "I saved it" is ticked: a payout to a key
 * nobody wrote down is a payout to nobody.
 */
export function destinationReady(state: SolanaExitState): boolean {
  const addr = recipientAddress(state);
  if (checkSolanaAddress(addr) !== null) return false;
  if (state.mode === "generate") return state.savedKey;
  return state.mode === "paste";
}

/** True when the refund address is one the rail could actually pay (M4). */
export function refundReady(state: SolanaExitState): boolean {
  return state.refundStatus === "default" || state.refundStatus === "ok";
}

/** Whether "See what you would get" may run. */
export function canQuote(state: SolanaExitState): boolean {
  return (
    state.phase === "destination" &&
    !state.busy &&
    state.asset !== null &&
    destinationReady(state) &&
    refundReady(state)
  );
}

/**
 * Whether the quote on screen is one we will let a recipient act on (M5/M6).
 *
 * `spreadBps` is the whole cost of leaving, and it used to be shown and nothing
 * more: a response with `amountOut` near zero rendered as a large percentage and
 * a live "Get deposit address" button. Three things are checked now, and each
 * failure says which:
 *
 *   1. the USD figures have to be arithmetic we can do at all
 *   2. the spread has to be at or under {@link MAX_SPREAD_BPS}
 *   3. `amountOut` has to be at least the rail's own `minAmountOut`
 */
export interface QuoteVerdict {
  ok: boolean;
  /** null when `ok`. */
  reason: string | null;
}

const ACCEPTABLE: QuoteVerdict = { ok: true, reason: null };

/** A decimal string from the rail, as a bigint. null when it is not one. */
function asZat(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

export function quoteAcceptable(
  quote: OneClickQuote,
  maxSpreadBps: number = MAX_SPREAD_BPS,
): QuoteVerdict {
  const cost = effectiveCost(quote);
  if (!cost.ok) return { ok: false, reason: copy.quoteUnreadable };

  if (cost.spreadBps > maxSpreadBps) {
    return {
      ok: false,
      reason: copy.spreadTooHigh(cost.spreadPct, `${(maxSpreadBps / 100).toFixed(2)}%`),
    };
  }

  const out = asZat(quote.amountOut);
  const floor = asZat(quote.minAmountOut);
  if (out === null || floor === null) return { ok: false, reason: copy.quoteUnreadable };
  if (out <= 0n || out < floor) return { ok: false, reason: copy.quoteShortfall };

  return ACCEPTABLE;
}

/** Whether "Get deposit address" may run. */
export function canGetDeposit(state: SolanaExitState, amountZat: bigint): boolean {
  return (
    state.phase === "quote" &&
    !state.busy &&
    state.quote !== null &&
    !belowMinimum(state, amountZat) &&
    quoteAcceptable(state.quote.quote).ok
  );
}

/**
 * The last check before the sweep: does the reservation say what we asked for?
 *
 * The deposit address is about to be paid out of somebody's envelope, on the
 * strength of an answer from a service we do not run. Two things are therefore
 * not taken on trust (M6):
 *
 *   - **what the address is.** Our own core classifies it, and only a
 *     transparent address of this network is accepted. A unified address here
 *     would be a different rail, or a different party's, and it is refused.
 *   - **what the rail thinks it was asked.** `quoteRequest` echoes the
 *     recipient, the destination asset and the refund address; all three are
 *     compared with what this page actually sent. A quote that pays out
 *     somewhere else, in something else, or refunds somewhere else is refused.
 *
 * Returns the sentence to show, or null when the plan is sound. A non-null
 * answer must stop the flow: nothing is swept on it.
 */
export interface SwapPlanFacts {
  /** What our core made of the deposit address. */
  depositKind: AddressKind | null;
  /** The echoed request, as the rail sent it back. */
  quoteRequest: OneClickQuoteResponse["quoteRequest"] | null | undefined;
  asset: SolanaAsset;
  /** The Solana address this page asked to be paid. */
  recipient: string;
  /** The Zcash address this page asked refunds to go to. */
  refundTo: string;
}

export function checkSwapPlan(facts: SwapPlanFacts): string | null {
  if (facts.depositKind !== "transparent") return copy.depositNotTransparent;

  const echoed = facts.quoteRequest;
  if (!echoed) return copy.depositMismatch("quote");

  if ((echoed.recipient ?? "").trim() !== facts.recipient.trim()) {
    return copy.depositMismatch("payout address");
  }
  if ((echoed.refundTo ?? "").trim() !== facts.refundTo.trim()) {
    return copy.depositMismatch("refund address");
  }
  if ((echoed.destinationAsset ?? "").trim() !== SOLANA_ASSETS[facts.asset].id) {
    return copy.depositMismatch("asset");
  }
  return null;
}

/** True when the rail has said the amount is under its floor. */
export function belowMinimum(state: SolanaExitState, amountZat: bigint): boolean {
  return state.minAmountZat !== null && amountZat < state.minAmountZat;
}

/**
 * Where a refund goes: the override if there is a usable one, otherwise the
 * envelope's own address (DECISIONS D14).
 */
export function refundAddress(state: SolanaExitState, envelopeAddress: string): string {
  const override = state.refundOverride.trim();
  return override !== "" ? override : envelopeAddress;
}

/* ------------------------------------------------- watching the swap afterwards */

/** The three stages the recipient is shown while the rail works. */
export const SWAP_STAGES = ["deposit", "swap", "payout"] as const;
export type SwapStage = (typeof SWAP_STAGES)[number];

export const SWAP_STAGE_LABEL: Record<SwapStage, string> = {
  deposit: "The rail is waiting for the ZEC",
  swap: "Swapping",
  payout: "Paid out on Solana",
};

export type SwapStageState = "done" | "active" | "waiting" | "stopped";

export interface SwapChecklistRow {
  stage: SwapStage;
  label: string;
  state: SwapStageState;
}

/**
 * The rail's status, mapped onto the three lines on screen.
 *
 * Its vocabulary is longer than ours and may grow, so anything unrecognised is
 * treated as "somewhere in the middle" rather than as an error: an unknown
 * status is not a failed swap.
 */
export function swapChecklist(status: string | null): SwapChecklistRow[] {
  const ended = status !== null && isFinalStatus(status);
  const failed = status === "REFUNDED" || status === "FAILED";
  const paid = status === "SUCCESS";
  const waitingForDeposit = status === null || status === "PENDING_DEPOSIT";

  const stateOf = (stage: SwapStage): SwapStageState => {
    if (stage === "deposit") {
      return waitingForDeposit ? "active" : "done";
    }
    if (stage === "swap") {
      if (waitingForDeposit) return "waiting";
      if (failed) return "stopped";
      return ended ? "done" : "active";
    }
    // payout
    if (paid) return "done";
    if (failed) return "stopped";
    return waitingForDeposit ? "waiting" : "waiting";
  };

  return SWAP_STAGES.map((stage) => ({
    stage,
    label: SWAP_STAGE_LABEL[stage],
    state: stateOf(stage),
  }));
}

/** One line under the checklist, in the recipient's words rather than the rail's. */
export function swapStatusLine(status: string | null): string {
  switch (status) {
    case null:
      return "Asking the swap service where it has got to…";
    case "PENDING_DEPOSIT":
      return "The swap service has not seen the ZEC yet. It usually takes a few confirmations.";
    case "KNOWN_DEPOSIT_TX":
    case "INCOMPLETE_DEPOSIT":
      return "The swap service has seen the payment and is confirming it.";
    case "PROCESSING":
      return "The swap is running. The payout follows on Solana.";
    case "SUCCESS":
      return "Paid out on Solana.";
    case "REFUNDED":
      return "The swap did not go through, so the ZEC was sent back to the refund address.";
    case "FAILED":
      return "The swap service reported a failure. Check the refund address for the ZEC.";
    default:
      return `The swap service reports: ${status}.`;
  }
}

/** True once there is no point asking again. */
export function swapFinished(status: OneClickStatusResponse | null): boolean {
  return status !== null && isFinalStatus(status.status);
}

/**
 * How often to ask the rail where things stand.
 *
 * `?poll=<ms>` in the query string shortens it, which is the only way a test can
 * watch a whole status sequence without waiting minutes for it. It is a
 * measurement knob in the same family as `?threads=` and `?dry=`, it is read
 * from the query string and never from the fragment, and it is clamped so it
 * cannot be turned into a request flood.
 */
export function statusPollMs(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): number {
  try {
    const asked = Number(new URLSearchParams(search).get("poll"));
    if (!Number.isFinite(asked) || asked <= 0) return STATUS_POLL_MS;
    return Math.max(100, Math.min(asked, STATUS_POLL_MS));
  } catch {
    return STATUS_POLL_MS;
  }
}
