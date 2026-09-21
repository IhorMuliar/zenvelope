/**
 * Solana address validation and keypair export.
 *
 * Two things worth being sure of: that a mistyped address is refused rather
 * than paid, and that the secret key we hand someone really is the secret key
 * for the address we told the rail to pay.
 */

import { describe, expect, it } from "vitest";
import {
  ED25519_UNAVAILABLE,
  SOLANA_PUBKEY_BYTES,
  SOLANA_SECRET_KEY_BYTES,
  base58Decode,
  base58Encode,
  checkSolanaAddress,
  encodeSecretKey,
  generateSolanaKeypair,
  isSolanaAddress,
  secretKeyMatchesAddress,
  seedFromPkcs8,
} from "./solana";

/** The USDC mint: a real 32-byte Solana address, and a fixed vector. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The system program: all-zero key, and so the leading-"1" edge case. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

describe("base58", () => {
  it("round-trips arbitrary bytes", () => {
    for (const bytes of [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array([255, 255, 255]),
      new Uint8Array(32).fill(7),
    ]) {
      expect(Array.from(base58Decode(base58Encode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("encodes each leading zero byte as one leading 1", () => {
    expect(base58Encode(new Uint8Array(32))).toBe(SYSTEM_PROGRAM);
    expect(base58Decode(SYSTEM_PROGRAM)).toHaveLength(32);
  });

  it("decodes a known address to exactly 32 bytes", () => {
    expect(base58Decode(USDC_MINT)).toHaveLength(SOLANA_PUBKEY_BYTES);
    expect(base58Encode(base58Decode(USDC_MINT))).toBe(USDC_MINT);
  });

  it("throws on every character outside the alphabet", () => {
    for (const bad of ["0", "O", "I", "l", "+", "/", " "]) {
      expect(() => base58Decode(`abc${bad}def`)).toThrow(/not a base58 character/);
    }
  });
});

describe("validating a pasted address", () => {
  it("accepts real Solana addresses", () => {
    expect(isSolanaAddress(USDC_MINT)).toBe(true);
    expect(isSolanaAddress(SYSTEM_PROGRAM)).toBe(true);
    expect(isSolanaAddress("9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS")).toBe(true);
  });

  it("ignores surrounding whitespace, because a paste carries it", () => {
    expect(isSolanaAddress(`  ${USDC_MINT}\n`)).toBe(true);
    expect(checkSolanaAddress(` ${USDC_MINT} `)).toBeNull();
  });

  it("refuses anything that is not base58 of 32 bytes", () => {
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress("not-an-address")).toBe(false);
    // A Zcash unified address, pasted into the wrong box.
    expect(isSolanaAddress("u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0")).toBe(false);
    // An Ethereum address.
    expect(isSolanaAddress("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toBe(false);
    // Right charset, wrong length: 31 bytes.
    expect(isSolanaAddress(base58Encode(new Uint8Array(31).fill(9)))).toBe(false);
    // And 33.
    expect(isSolanaAddress(base58Encode(new Uint8Array(33).fill(9)))).toBe(false);
  });

  it("says which way it is wrong, so the field can be useful", () => {
    expect(checkSolanaAddress("")).toBe("empty");
    expect(checkSolanaAddress("   ")).toBe("empty");
    // A look-alike zero in the middle of an otherwise fine address.
    expect(checkSolanaAddress(`${USDC_MINT.slice(0, 10)}0${USDC_MINT.slice(11)}`)).toBe("charset");
    expect(checkSolanaAddress(base58Encode(new Uint8Array(33).fill(9)))).toBe("length");
    expect(checkSolanaAddress(USDC_MINT)).toBeNull();
  });
});

describe("the exported secret key", () => {
  it("is 64 bytes: the seed then the public key", () => {
    const seed = new Uint8Array(32).fill(1);
    const pubkey = new Uint8Array(32).fill(2);
    const encoded = encodeSecretKey(seed, pubkey);
    const decoded = base58Decode(encoded);

    expect(decoded).toHaveLength(SOLANA_SECRET_KEY_BYTES);
    expect(Array.from(decoded.slice(0, 32))).toEqual(Array.from(seed));
    expect(Array.from(decoded.slice(32))).toEqual(Array.from(pubkey));
  });

  it("ends in the address's own bytes", () => {
    const seed = new Uint8Array(32).fill(1);
    const pubkey = new Uint8Array(32).fill(2);
    expect(secretKeyMatchesAddress(encodeSecretKey(seed, pubkey), base58Encode(pubkey))).toBe(true);
    // A key for some other address must not pass.
    const other = new Uint8Array(32).fill(3);
    expect(secretKeyMatchesAddress(encodeSecretKey(seed, pubkey), base58Encode(other))).toBe(false);
    expect(secretKeyMatchesAddress("not base58 at all!!", base58Encode(pubkey))).toBe(false);
    // A 32-byte "secret key" is a seed, not the import format.
    expect(secretKeyMatchesAddress(base58Encode(seed), base58Encode(pubkey))).toBe(false);
  });

  it("refuses halves that are not 32 bytes each", () => {
    expect(() => encodeSecretKey(new Uint8Array(31), new Uint8Array(32))).toThrow();
    expect(() => encodeSecretKey(new Uint8Array(32), new Uint8Array(33))).toThrow();
  });

  it("takes the seed from the last 32 bytes of the PKCS#8 wrapper", () => {
    // A real 48-byte ed25519 PKCS#8 export, from Node's WebCrypto.
    const pkcs8 = Uint8Array.from(
      Buffer.from(
        "302e020100300506032b6570042204200b386b6f59e18a43bf4e27f5bf2bc2c0" +
          "6b319c92ec3e73e5af95691e408f592b",
        "hex",
      ),
    );
    expect(pkcs8).toHaveLength(48);
    expect(Buffer.from(seedFromPkcs8(pkcs8)).toString("hex")).toBe(
      "0b386b6f59e18a43bf4e27f5bf2bc2c06b319c92ec3e73e5af95691e408f592b",
    );
    expect(() => seedFromPkcs8(new Uint8Array(8))).toThrow();
  });
});

describe("generating a keypair", () => {
  it("makes one whose secret key imports to its own address", async () => {
    const pair = await generateSolanaKeypair();

    expect(isSolanaAddress(pair.address)).toBe(true);
    expect(base58Decode(pair.secretKeyBase58)).toHaveLength(SOLANA_SECRET_KEY_BYTES);
    expect(secretKeyMatchesAddress(pair.secretKeyBase58, pair.address)).toBe(true);
  });

  it("makes a different one every time", async () => {
    const [a, b] = await Promise.all([generateSolanaKeypair(), generateSolanaKeypair()]);
    expect(a.address).not.toBe(b.address);
    expect(a.secretKeyBase58).not.toBe(b.secretKeyBase58);
  });

  it("says so plainly when the engine has no Ed25519", async () => {
    // An engine whose WebCrypto has no generateKey at all.
    await expect(generateSolanaKeypair({} as unknown as SubtleCrypto)).rejects.toThrow(
      ED25519_UNAVAILABLE,
    );

    const refusing = {
      generateKey: async () => {
        throw new Error("Unrecognized algorithm name");
      },
      exportKey: async () => new ArrayBuffer(0),
    } as unknown as SubtleCrypto;
    await expect(generateSolanaKeypair(refusing)).rejects.toThrow(ED25519_UNAVAILABLE);
    // And the message names a way forward rather than just failing.
    expect(ED25519_UNAVAILABLE).toMatch(/Paste an address/);
  });
});
