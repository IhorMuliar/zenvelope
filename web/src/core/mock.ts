/**
 * MOCK core.
 *
 * Used only when no WASM build is present under web/src/wasm/core. It is
 * deliberately obvious: every address it returns contains the string "mock" and
 * the UI shows a MOCK badge. It does no real Zcash key derivation and the
 * addresses it produces are not spendable.
 */

import type {
  Derived,
  LoadedCore,
  Network,
  OpenResult,
  ParsedFragment,
  ProgressFn,
  ZatLike,
} from "./types";
import { toZat } from "./types";
import { memoByteLength } from "../lib/format";

const SECRET_BYTES = 32;
const SECRET_CHARS = 43; // ceil(32 * 4 / 3) with padding stripped
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** FNV-1a, 32 bit. Not cryptographic; the mock only needs determinism. */
function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const b of bytes) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mockBody(bytes: Uint8Array, salt: number, len: number): string {
  let out = "";
  let h = fnv1a(bytes, salt) || 1;
  for (let i = 0; i < len; i++) {
    // xorshift32, so the mock body does not visibly repeat
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    out += BECH32_CHARSET[(h >>> 11) % BECH32_CHARSET.length];
  }
  return out;
}

export function zatToZecString(zat: ZatLike): string {
  let v = toZat(zat);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function zecStringToZat(s: string): bigint {
  const t = s.trim();
  if (!/^-?\d*(\.\d*)?$/.test(t) || t === "" || t === "." || t === "-") {
    throw new Error("not a decimal ZEC amount");
  }
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > 8) throw new Error("more than 8 decimal places");
  const zat = BigInt(whole || "0") * 100000000n + BigInt((frac + "00000000").slice(0, 8));
  return neg ? -zat : zat;
}

/** The memo parameter carries at most 512 bytes, per ZIP-321. */
export const MAX_MEMO_BYTES = 512;

/**
 * base64url of the UTF-8 bytes, no padding: the ZIP-321 `memo=` encoding.
 * <https://zips.z.cash/zip-0321>
 */
export function memoToBase64Url(text: string): string {
  if (memoByteLength(text) > MAX_MEMO_BYTES) {
    throw new Error(
      `the message is ${memoByteLength(text)} bytes; the most a memo can carry is ${MAX_MEMO_BYTES}`,
    );
  }
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/**
 * Single-output ZIP-321 URI: `zcash:<address>?amount=<zec>[&memo=<base64url>]`.
 *
 * The sender's text goes in `memo=`, not `message=`: a `message` is a label the
 * sending wallet keeps to itself, and M2 proved on mainnet that it never reaches
 * the chain. A `memo` is written into the note, encrypted, and is what the open
 * flow decrypts.
 */
export function paymentUri(address: string, amount_zat: ZatLike, memo?: string): string {
  const amount = zatToZecString(amount_zat);
  let uri = `zcash:${address}?amount=${amount}`;
  if (memo && memo.length > 0) {
    uri += `&memo=${memoToBase64Url(memo)}`;
  }
  return uri;
}

export function buildFragment(secret: string, birthday?: number): string {
  if (!B64URL_RE.test(secret)) throw new Error("secret must be 43 base64url chars");
  if (birthday === undefined || birthday === null) return secret;
  if (!Number.isInteger(birthday) || birthday < 0) throw new Error("birthday must be a height");
  return `${secret}.${birthday}`;
}

export function parseFragment(frag: string): ParsedFragment {
  let f = frag.trim();
  if (f.startsWith("#")) f = f.slice(1);
  if (f === "") throw new Error("empty fragment");
  const dot = f.indexOf(".");
  const secret = dot === -1 ? f : f.slice(0, dot);
  const rest = dot === -1 ? "" : f.slice(dot + 1);
  if (!B64URL_RE.test(secret)) throw new Error("fragment does not contain a valid secret");
  if (dot === -1) return { secret };
  if (!/^\d+$/.test(rest)) throw new Error("birthday must be a decimal height");
  return { secret, birthday: Number(rest) };
}

export function generateSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  const s = bytesToBase64Url(bytes);
  if (s.length !== SECRET_CHARS) throw new Error("unexpected secret length");
  return s;
}

export function derive(secret_b64url: string, network: Network): Derived {
  if (!B64URL_RE.test(secret_b64url)) throw new Error("secret must be 43 base64url chars");
  const bytes = base64UrlToBytes(secret_b64url);
  const hrp = network === "main" ? "u1" : "utest1";
  return {
    address: `${hrp}mock${mockBody(bytes, 1, 54)}`,
    ufvk: `${network === "main" ? "uview" : "uviewtest"}1mock${mockBody(bytes, 2, 64)}`,
    diversifier_index: 0,
  };
}


/**
 * MOCK scan. Four seconds of progress, then one note.
 *
 * It touches no network and reads no key material: `lightwalletd_url` is
 * accepted and ignored so the call shape matches the real core exactly. The
 * fixed note is the M1 envelope from web/docs/M1-VERIFICATION.md.
 */
export const MOCK_SCAN_MS = 4000;
const MOCK_TICK_MS = 100;
/** Ticks reported before the mock "knows" the span, so the bar starts indeterminate. */
const MOCK_UNKNOWN_TICKS = 4;
export const MOCK_TIP_HEIGHT = 3490500;
const MOCK_DEFAULT_SPAN = 12400;

export const MOCK_NOTE = {
  amount_zat: "130000",
  memo: "Zenvelope M1",
  height: 3490472,
  txid: "0b7e2a1c9d4f6835e1a0c72b5d9f4e6183a7c02d5be914f7308cd62a1f4b8e57",
  pool: "ironwood",
  // The real M1 note sits at Ironwood action 1: the sending wallet took its change in
  // action 0 of the same bundle.
  action_index: 1,
} as const;

export async function openEnvelope(
  secret_b64url: string,
  birthday: number | undefined,
  network: Network,
  _lightwalletd_url: string,
  on_progress?: ProgressFn,
): Promise<OpenResult> {
  // Derive first, so a bad secret fails the same way the real core would.
  derive(secret_b64url, network);
  const total =
    birthday !== undefined && birthday < MOCK_TIP_HEIGHT
      ? MOCK_TIP_HEIGHT - birthday + 1
      : MOCK_DEFAULT_SPAN;
  const ticks = Math.round(MOCK_SCAN_MS / MOCK_TICK_MS);

  return new Promise((resolve) => {
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      if (tick >= ticks) {
        clearInterval(timer);
        on_progress?.(total, total);
        resolve({
          found: true,
          notes: [{ ...MOCK_NOTE }],
          total_zat: MOCK_NOTE.amount_zat,
          tip_height: MOCK_TIP_HEIGHT,
          birthday: MOCK_TIP_HEIGHT - total + 1,
          birthday_defaulted: birthday === undefined,
          scanned_blocks: total,
        });
        return;
      }
      // The span is unknown for the first few ticks: total 0 keeps the bar
      // indeterminate, exactly as it is while the real scanner fetches the tip.
      if (tick <= MOCK_UNKNOWN_TICKS) on_progress?.(0, 0);
      else on_progress?.(Math.floor((total * tick) / ticks), total);
    }, MOCK_TICK_MS);
  });
}

export const mockCore: LoadedCore = {
  isMock: true,
  derive,
  generate_secret: generateSecret,
  parse_fragment: parseFragment,
  build_fragment: buildFragment,
  payment_uri: paymentUri,
  zat_to_zec_string: zatToZecString,
  zec_string_to_zat: zecStringToZat,
  open_envelope: openEnvelope,
};
