/**
 * Amount validation and the fee breakdown. All money maths is bigint zatoshi;
 * floating point never touches an amount.
 */

import {
  FLAT_FEE_ZAT,
  MIN_ENVELOPE_ZAT,
  NETWORK_FEE_TRANSPARENT_ZAT,
  NETWORK_FEE_ZAT,
  SWEEP_FEE_ZAT,
} from "../config";
import type { AddressKind } from "../core/types";
import { zatToZecString, zecStringToZat } from "../core/mock";

export interface AmountOk {
  ok: true;
  zat: bigint;
}
export interface AmountErr {
  ok: false;
  error: string;
}
export type AmountResult = AmountOk | AmountErr;

const DECIMAL_RE = /^\d*(\.\d*)?$/;

/** Validates a ZEC amount typed by the sender. 8 decimals max, 0.0001 ZEC min. */
export function validateAmount(input: string): AmountResult {
  const t = input.trim();
  if (t === "") return { ok: false, error: "Enter an amount in ZEC." };
  if (!DECIMAL_RE.test(t)) return { ok: false, error: "Use digits and one decimal point." };
  const frac = t.split(".")[1] ?? "";
  if (frac.length > 8) return { ok: false, error: "ZEC has at most 8 decimal places." };
  let zat: bigint;
  try {
    zat = zecStringToZat(t);
  } catch {
    return { ok: false, error: "Use digits and one decimal point." };
  }
  if (zat <= 0n) return { ok: false, error: "Enter an amount greater than zero." };
  if (zat < MIN_ENVELOPE_ZAT) {
    return { ok: false, error: `The smallest envelope is ${zatToZecString(MIN_ENVELOPE_ZAT)} ZEC.` };
  }
  return { ok: true, zat };
}

export interface Breakdown {
  envelopeZat: bigint;
  feeZat: bigint;
  totalZat: bigint;
  envelope: string;
  fee: string;
  total: string;
}

/** envelope + flat fee = total, as one ZIP-321 output (DECISIONS D5). */
export function feeBreakdown(envelopeZat: bigint, feeZat: bigint = FLAT_FEE_ZAT): Breakdown {
  const totalZat = envelopeZat + feeZat;
  return {
    envelopeZat,
    feeZat,
    totalZat,
    envelope: zatToZecString(envelopeZat),
    fee: zatToZecString(feeZat),
    total: zatToZecString(totalZat),
  };
}

/** The two lines shown under the QR. */
export function breakdownLines(b: Breakdown): [string, string] {
  return [`Envelope ${b.envelope} ZEC + service fee ${b.fee} ZEC`, `= ${b.total} ZEC`];
}

/* ------------------------------------------------- M3: what the recipient gets */

/** ZIP-317's marginal fee, in zatoshi: one logical action costs this. */
const MARGINAL_FEE_ZAT = 5000n;

/**
 * The ZIP-317 miner fee for the sweep: 0.0001 ZEC for the two-action shielded
 * case, 0.00015 ZEC when the destination is transparent and costs another
 * logical action.
 *
 * `spends` is how many notes the sweep spends. Ironwood permits cross-address
 * transfers, so its actions are `max(spends, outputs)` padded up to two: a second
 * note rides in an action the outputs had already paid for, and only the third
 * costs anything. This is the same arithmetic `network_fee_zat` does in
 * crates/core/src/spend.rs, and the two must agree or the build refuses the fee.
 */
export function networkFeeFor(kind: AddressKind, spends = 1): bigint {
  if (spends <= 2) {
    return kind === "transparent" ? NETWORK_FEE_TRANSPARENT_ZAT : NETWORK_FEE_ZAT;
  }
  const transparentActions = kind === "transparent" ? 1n : 0n;
  return MARGINAL_FEE_ZAT * (BigInt(spends) + transparentActions);
}

export interface SweepAmounts {
  /** What the scan found in the envelope. */
  inEnvelopeZat: bigint;
  /** The miner fee. */
  networkFeeZat: bigint;
  /** The flat Zenvelope fee. 0n while there is no fee address, and then no line. */
  serviceFeeZat: bigint;
  /** What lands at the destination. Never negative: see `ok`. */
  receiveZat: bigint;
  /** False when the envelope cannot cover the fees, and then nothing is offered. */
  ok: boolean;
  /** How much short it is, 0n when ok. */
  shortfallZat: bigint;
}

/**
 * envelope - miner fee - flat fee = what the recipient receives.
 *
 * `inEnvelopeZat` is the **sum** of every note being swept and `spends` is how many
 * there are, because the miner fee depends on the action count and the action count
 * depends on the number of spends.
 *
 * All bigint zatoshi: no float ever touches an amount, and the review screen and
 * the done screen do the same arithmetic on the same numbers.
 */
export function sweepAmounts(
  inEnvelopeZat: bigint,
  kind: AddressKind,
  serviceFeeZat: bigint = SWEEP_FEE_ZAT,
  spends = 1,
): SweepAmounts {
  const networkFee = networkFeeFor(kind, spends);
  const fee = serviceFeeZat < 0n ? 0n : serviceFeeZat;
  const receive = inEnvelopeZat - networkFee - fee;
  return {
    inEnvelopeZat,
    networkFeeZat: networkFee,
    serviceFeeZat: fee,
    receiveZat: receive > 0n ? receive : 0n,
    ok: receive > 0n,
    shortfallZat: receive > 0n ? 0n : -receive + 1n,
  };
}
