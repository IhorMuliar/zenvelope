/**
 * Display formatting for the open flow. All money maths is bigint zatoshi;
 * floating point never touches an amount.
 */

import type { Pool } from "../core/types";

const ZAT_PER_ZEC = 100000000n;
const DECIMALS = 8;

/** Groups an integer string in threes: "1234567" -> "1,234,567". */
export function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * Zatoshi to a ZEC string for display: trailing zeros trimmed, but always at
 * least one decimal place ("1.0"), and thousands separators on the whole part.
 *
 *   130000n          -> "0.0013"
 *   100000000n       -> "1.0"
 *   2099999999999999n-> "20,999,999.99999999"
 */
export function formatZec(zat: bigint): string {
  const neg = zat < 0n;
  const v = neg ? -zat : zat;
  const whole = groupThousands((v / ZAT_PER_ZEC).toString());
  const frac = (v % ZAT_PER_ZEC).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${frac === "" ? "0" : frac}`;
}

/** The same string with the unit, as one text node: "0.0013 ZEC". */
export function formatZecAmount(zat: bigint): string {
  return `${formatZec(zat)} ZEC`;
}

/** A block count or height, grouped: 12400 -> "12,400". */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return groupThousands(v.toString());
}

/** A txid short enough to read on a phone, with the ends intact. */
export function truncateTxid(txid: string, keep = 8): string {
  if (txid.length <= keep * 2 + 1) return txid;
  return `${txid.slice(0, keep)}…${txid.slice(-keep)}`;
}

/** How a pool is named to the recipient. Never a raw crate name. */
export function poolLabel(pool: Pool): string {
  switch (pool) {
    case "ironwood":
      return "shielded (Ironwood)";
    case "orchard":
      return "shielded (Orchard)";
    case "sapling":
      return "shielded (Sapling)";
    default:
      return "shielded";
  }
}

/** Sums note amounts that crossed the WASM boundary as decimal strings. */
export function sumZat(amounts: readonly string[]): bigint {
  return amounts.reduce((acc, a) => acc + BigInt(a.trim()), 0n);
}

/**
 * UTF-8 byte length of the sender's message.
 *
 * The message ends up in the note's 512-byte memo field, so the limit is a byte
 * limit: "🎁" is one character and four bytes, and counting characters would let
 * a message through that the memo cannot hold.
 */
export function memoByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
