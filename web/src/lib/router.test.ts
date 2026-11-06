import { createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROUTER_INFO, deriveRouterKey, deriveRouterSeed, routerKeyFromSeed, secretBytesFromB64url } from "./router";
import { base58Encode } from "./solana";

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

function nodeAddress(secret: Uint8Array) {
  const seed = Buffer.from(hkdfSync("sha256", secret, new Uint8Array(0), ROUTER_INFO, 32));
  const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" }))
    .export({ format: "jwk" }).x as string;
  return { seed, address: base58Encode(new Uint8Array(Buffer.from(pub, "base64url"))) };
}

describe("router wallet", () => {
  it("derives the same seed as Node's HKDF", async () => {
    const seed = await deriveRouterSeed(SECRET);
    expect(Buffer.from(seed).toString("hex")).toBe(nodeAddress(SECRET).seed.toString("hex"));
  });

  it("has a fixed address for a fixed secret (vector)", async () => {
    const key = await deriveRouterKey(SECRET);
    expect(key.address).toBe(nodeAddress(SECRET).address);
    expect(key.address).toBe("CUSLQnkxX7fr6tJasa1v48g3CaeKGRZLYRnzFq8r8RTL");
  });

  it("is deterministic and secret-dependent", async () => {
    const other = SECRET.slice();
    other[0] ^= 1;
    expect((await deriveRouterKey(SECRET)).address).toBe((await deriveRouterKey(SECRET)).address);
    expect((await deriveRouterKey(other)).address).not.toBe((await deriveRouterKey(SECRET)).address);
  });

  it("keeps the private key non-extractable but able to sign", async () => {
    const key = await deriveRouterKey(SECRET);
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", key.privateKey)).rejects.toThrow();
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, new Uint8Array([1, 2, 3])));
    const pub = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", pub, sig, new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("maps a seed to the address Node computes", async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" }))
      .export({ format: "jwk" }).x as string;
    expect((await routerKeyFromSeed(seed)).address).toBe(base58Encode(new Uint8Array(Buffer.from(pub, "base64url"))));
  });

  it("rejects short secrets and decodes base64url", async () => {
    await expect(deriveRouterKey(new Uint8Array(8))).rejects.toThrow();
    expect(Array.from(secretBytesFromB64url("-_8"))).toEqual([251, 255]);
  });
});
