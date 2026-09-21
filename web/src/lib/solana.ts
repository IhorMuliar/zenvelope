/**
 * Solana addresses and keys, in about two hundred lines and with no dependency.
 *
 * Two jobs:
 *
 *   1. **Validate** a pasted address. A Solana address is base58 of a 32-byte
 *      ed25519 public key, and nothing else, so validation is a base58 decode
 *      and a length check. Getting this wrong sends money nowhere recoverable,
 *      which is why it is done here and not with a regular expression.
 *   2. **Generate** a fresh keypair for a recipient who has no Solana wallet,
 *      using `crypto.subtle` — no key library, no entropy of our own — and hand
 *      it back in the 64-byte base58 form Phantom and Solflare import.
 *
 * `@solana/web3.js` is deliberately not a dependency. It is megabytes of RPC
 * client, wallet adapters and transaction builders for two functions we can
 * write in full view, and every byte of it would be code running on a page that
 * holds somebody's spending key.
 *
 * **The secret key is never stored.** It is generated, shown once, and lives in
 * one piece of React state until the tab closes — the same rule as the Zcash
 * mnemonic on the other destination card.
 */

/** Bitcoin/Solana base58: no 0, O, I or l. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i += 1) map[ALPHABET[i]] = i;
  return map;
})();

/** An ed25519 public key, and so a Solana address. */
export const SOLANA_PUBKEY_BYTES = 32;

/** Phantom and Solflare import `seed || pubkey`, base58. */
export const SOLANA_SECRET_KEY_BYTES = 64;

/**
 * base58 of a byte string. Big-integer base conversion done in bytes, so it
 * needs no BigInt and cannot lose precision.
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Every leading zero byte is one leading "1", by definition, and is not part
  // of the numeric conversion.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      const value = digits[j] * 256 + carry;
      digits[j] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

/**
 * base58 back to bytes. Throws on any character outside the alphabet, which is
 * what catches an address pasted with a look-alike `0`, `O`, `I` or `l` in it.
 */
export function base58Decode(text: string): Uint8Array {
  if (text === "") return new Uint8Array(0);

  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;

  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const digit = INDEX[text[i]];
    if (digit === undefined) {
      throw new Error(`"${text[i]}" is not a base58 character`);
    }
    let carry = digit;
    for (let j = 0; j < bytes.length; j += 1) {
      const value = bytes[j] * 58 + carry;
      bytes[j] = value & 0xff;
      carry = value >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** True when `text` is base58 of exactly 32 bytes: a Solana address and nothing else. */
export function isSolanaAddress(text: string): boolean {
  const addr = text.trim();
  // Cheap rejects first, so a paste of a whole paragraph does not run the loop.
  if (addr.length < 32 || addr.length > 44) return false;
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(addr);
  } catch {
    return false;
  }
  return decoded.length === SOLANA_PUBKEY_BYTES;
}

/** Why a pasted address was refused. `null` means it was not. */
export type SolanaAddressProblem = "empty" | "charset" | "length" | null;

/**
 * The same check, with a reason, so the field can say something more useful than
 * "invalid". Pure, and the single source of the verdict the screen shows.
 */
export function checkSolanaAddress(text: string): SolanaAddressProblem {
  const addr = text.trim();
  if (addr === "") return "empty";
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(addr);
  } catch {
    return "charset";
  }
  return decoded.length === SOLANA_PUBKEY_BYTES ? null : "length";
}

/* ------------------------------------------------------- generating a keypair */

export interface SolanaKeypair {
  /** base58 of the 32-byte public key. What the rail pays out to. */
  address: string;
  /**
   * base58 of `seed || pubkey`, 64 bytes: the exact string Phantom's and
   * Solflare's "import private key" boxes take. Shown once and stored nowhere.
   */
  secretKeyBase58: string;
}

/** Said when the engine has no Ed25519 in WebCrypto. Not a crash, a way out. */
export const ED25519_UNAVAILABLE =
  "This browser cannot generate a Solana key. Chrome, Edge and Safari can; Firefox " +
  "cannot yet. Paste an address from a Solana wallet instead, or open this link in " +
  "another browser.";

/** Narrow shape of what we use, so the fallback path can be tested. */
type SubtleLike = Pick<SubtleCrypto, "generateKey" | "exportKey">;

/**
 * A PKCS#8 ed25519 private key is a fixed 48-byte DER wrapper whose last 32
 * bytes are the seed. Nothing else in the structure varies, so slicing is safe
 * and a wrong length is caught rather than silently mis-sliced.
 */
export function seedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length < SOLANA_PUBKEY_BYTES) {
    throw new Error("the exported private key is too short to be an ed25519 seed");
  }
  return pkcs8.slice(pkcs8.length - SOLANA_PUBKEY_BYTES);
}

/**
 * `seed || pubkey`, base58: the import format. Kept separate from the
 * generation so the format itself can be tested against a fixed pair.
 */
export function encodeSecretKey(seed: Uint8Array, pubkey: Uint8Array): string {
  if (seed.length !== SOLANA_PUBKEY_BYTES || pubkey.length !== SOLANA_PUBKEY_BYTES) {
    throw new Error("an ed25519 keypair is two 32-byte halves");
  }
  const out = new Uint8Array(SOLANA_SECRET_KEY_BYTES);
  out.set(seed, 0);
  out.set(pubkey, SOLANA_PUBKEY_BYTES);
  return base58Encode(out);
}

/**
 * A fresh ed25519 keypair from `crypto.subtle`.
 *
 * The entropy is the engine's, not ours. Ed25519 landed in WebCrypto in
 * Chromium 137 and Safari 17; a browser without it throws
 * {@link ED25519_UNAVAILABLE} rather than falling back to some hand-rolled
 * generator, because a weak key here is a stolen payout.
 */
export async function generateSolanaKeypair(
  subtle: SubtleLike | undefined = globalThis.crypto?.subtle,
): Promise<SolanaKeypair> {
  if (!subtle || typeof subtle.generateKey !== "function") {
    throw new Error(ED25519_UNAVAILABLE);
  }

  let pair: CryptoKeyPair;
  try {
    pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    throw new Error(ED25519_UNAVAILABLE);
  }
  if (!pair?.privateKey || !pair?.publicKey) {
    throw new Error(ED25519_UNAVAILABLE);
  }

  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const pubkey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const seed = seedFromPkcs8(pkcs8);

  return {
    address: base58Encode(pubkey),
    secretKeyBase58: encodeSecretKey(seed, pubkey),
  };
}

/**
 * True when the exported secret key really ends in the address's own bytes.
 *
 * Cheap, and it is the one mistake that would hand someone a key that imports
 * into a wallet holding a different address than the one the swap was told to
 * pay. The generator checks itself with it, and so does the test.
 */
export function secretKeyMatchesAddress(secretKeyBase58: string, address: string): boolean {
  let secret: Uint8Array;
  let pubkey: Uint8Array;
  try {
    secret = base58Decode(secretKeyBase58);
    pubkey = base58Decode(address);
  } catch {
    return false;
  }
  if (secret.length !== SOLANA_SECRET_KEY_BYTES || pubkey.length !== SOLANA_PUBKEY_BYTES) {
    return false;
  }
  for (let i = 0; i < SOLANA_PUBKEY_BYTES; i += 1) {
    if (secret[SOLANA_PUBKEY_BYTES + i] !== pubkey[i]) return false;
  }
  return true;
}
