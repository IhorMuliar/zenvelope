/**
 * Amount validation and the fee breakdown. All money maths is bigint zatoshi;
 * floating point never touches an amount.
 */

import { FLAT_FEE_ZAT, MIN_ENVELOPE_ZAT } from "../config";
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
