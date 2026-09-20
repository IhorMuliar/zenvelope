/**
 * MOCK core.
 *
 * Used only when no WASM build is present under web/src/wasm/core. It is
 * deliberately obvious: every address it returns contains the string "mock" and
 * the UI shows a MOCK badge. It does no real Zcash key derivation and the
 * addresses it produces are not spendable.
 */

import type { Derived, LoadedCore, Network, ParsedFragment, ZatLike } from "./types";
import { toZat } from "./types";

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

/** Single-output ZIP-321 URI: zcash:<address>?amount=<zec>[&message=<text>] */
export function paymentUri(address: string, amount_zat: ZatLike, message?: string): string {
  const amount = zatToZecString(amount_zat);
  let uri = `zcash:${address}?amount=${amount}`;
  if (message && message.length > 0) {
    uri += `&message=${encodeURIComponent(message)}`;
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

export const mockCore: LoadedCore = {
  isMock: true,
  derive,
  generate_secret: generateSecret,
  parse_fragment: parseFragment,
  build_fragment: buildFragment,
  payment_uri: paymentUri,
  zat_to_zec_string: zatToZecString,
  zec_string_to_zat: zecStringToZat,
};
