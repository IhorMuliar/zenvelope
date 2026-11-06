/**
 * The router wallet: a Solana key derived from the envelope's own link secret.
 *
 * The private route needs a wallet that the *page* controls, because the page has
 * to sign the MultiHopper transactions. It must also survive a closed tab: refunds,
 * rent and leftover SOL all land in it. So it is not stored anywhere. It is
 * recomputed from the link secret every time the link is opened:
 *
 *     seed = HKDF-SHA256(ikm = secret bytes, salt = "", info = "zenvelope/solana-router/v1")
 *
 * The link is already the bearer secret for the envelope, so deriving a wallet from
 * it adds no new thing to lose (same trust model as the refund to the envelope).
 *
 * The signing key is imported into WebCrypto **non-extractable**: after this module
 * returns, page code can ask it to sign but cannot read it back. Only the public key
 * is exported, which needs one short-lived extractable import of the seed.
 */

import { base58Encode } from "./solana";

/** HKDF `info`. Changing this changes every router address. */
export const ROUTER_INFO = "zenvelope/solana-router/v1";

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface RouterKey {
  /** base58 of the 32-byte public key. */
  address: string;
  publicKey: Uint8Array;
  /** Non-extractable Ed25519 signing key. */
  privateKey: CryptoKey;
}

/** base64url (no padding, as the core's `generate_secret` emits) to bytes. */
export function secretBytesFromB64url(secret: string): Uint8Array {
  const s = secret.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 seed bytes from the link secret. */
export async function deriveRouterSeed(
  secret: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Uint8Array> {
  if (secret.length < 16) throw new Error("the link secret is too short to derive a key from");
  const ikm = await subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(ROUTER_INFO) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

function pkcs8(seed: Uint8Array) {
  if (seed.length !== 32) throw new Error("an ed25519 seed is 32 bytes");
  const out = new Uint8Array(PKCS8_PREFIX.length + 32);
  out.set(PKCS8_PREFIX, 0);
  out.set(seed, PKCS8_PREFIX.length);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  return secretBytesFromB64url(s);
}

/** Seed to key pair. The seed is not retained. */
export async function routerKeyFromSeed(
  seed: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<RouterKey> {
  const der = pkcs8(seed);
  // Extractable once, only to read the public half out of the JWK `x`.
  const temp = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await subtle.exportKey("jwk", temp);
  if (!jwk.x) throw new Error("the browser did not return an Ed25519 public key");
  const publicKey = b64urlToBytes(jwk.x);
  const privateKey = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  der.fill(0);
  return { address: base58Encode(publicKey), publicKey, privateKey };
}

/** The router wallet for an envelope secret (raw bytes). */
export async function deriveRouterKey(
  secret: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<RouterKey> {
  const seed = await deriveRouterSeed(secret, subtle);
  try {
    return await routerKeyFromSeed(seed, subtle);
  } finally {
    seed.fill(0);
  }
}

/** Same, from the base64url secret string the core and the URL fragment use. */
export function deriveRouterKeyFromLinkSecret(secretB64url: string): Promise<RouterKey> {
  return deriveRouterKey(secretBytesFromB64url(secretB64url));
}
