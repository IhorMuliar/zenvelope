import { describe, expect, it } from "vitest";
import vectors from "./__fixtures__/soltx-vectors.json";
import prepareSol from "./__fixtures__/mh-prepare-sol.json";
import { routerKeyFromSeed } from "./router";
import { base58Decode } from "./solana";
import {
  base64ToBytes,
  buildTransferTransaction,
  parseTransaction,
  readCompactU16,
  signTransaction,
  signerSlot,
  writeCompactU16,
} from "./soltx";

const seed = Uint8Array.from(Buffer.from(vectors.seedHex, "hex"));

describe("compact-u16", () => {
  it("round-trips", () => {
    for (const v of [0, 1, 127, 128, 300, 16383, 16384, 65535]) {
      expect(readCompactU16(Uint8Array.from(writeCompactU16(v)), 0).value).toBe(v);
    }
  });
});

describe("signTransaction against web3.js output", () => {
  it("uses the test key", async () => {
    expect((await routerKeyFromSeed(seed)).address).toBe(vectors.address);
  });

  for (const [name, v] of Object.entries(vectors.txs)) {
    it(`signs ${name} (${v.version === 0 ? "v0" : "legacy"}) byte-for-byte like web3.js`, async () => {
      const key = await routerKeyFromSeed(seed);
      const out = await signTransaction(v.patched, key);
      expect(out.base64).toBe(v.expected);
      expect(out.unsignedSlots).toEqual([]);
    });
  }

  it("preserves the server pre-signature on a two-signer routeInit", async () => {
    const key = await routerKeyFromSeed(seed);
    const before = base64ToBytes(vectors.txs.route0.patched);
    const after = base64ToBytes((await signTransaction(vectors.txs.route0.patched, key)).base64);
    const tx = parseTransaction(before);
    expect(tx.sigCount).toBe(2);
    const slot = signerSlot(vectors.txs.route0.patched, key.publicKey);
    const other = slot === 0 ? 1 : 0;
    // The server's slot is untouched, ours changed, the message is untouched.
    expect(after.slice(tx.sigStart + other * 64, tx.sigStart + other * 64 + 64)).toEqual(
      before.slice(tx.sigStart + other * 64, tx.sigStart + other * 64 + 64),
    );
    expect(after.slice(tx.messageStart)).toEqual(before.slice(tx.messageStart));
    expect(slot).toBe(0);
    expect(before.slice(tx.sigStart + 64, tx.sigStart + 128).some((b) => b !== 0)).toBe(true);
  });

  it("verifies with WebCrypto and returns the first signature as id", async () => {
    const key = await routerKeyFromSeed(seed);
    const out = await signTransaction(vectors.txs.keeper.patched, key);
    const bytes = base64ToBytes(out.base64);
    const tx = parseTransaction(bytes);
    const pub = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", pub, bytes.slice(1, 65), bytes.slice(tx.messageStart))).toBe(true);
    expect(base58Decode(out.signature)).toEqual(bytes.slice(1, 65));
  });

  it("refuses a transaction that does not list our key", async () => {
    const key = await routerKeyFromSeed(seed);
    await expect(signTransaction(prepareSol.preparedTxs.keeperFundingTx, key)).rejects.toThrow(/required signer/);
  });

  it("parses the unpatched fixtures", () => {
    const p = prepareSol.preparedTxs;
    expect(parseTransaction(base64ToBytes(p.keeperFundingTx)).version).toBe(0);
    expect(parseTransaction(base64ToBytes(p.orchestratorInitTx)).version).toBe("legacy");
    expect(parseTransaction(base64ToBytes(p.routeInitTxs[0].base64)).numRequiredSignatures).toBe(2);
  });
});

describe("buildTransferTransaction", () => {
  const t = vectors.transfer;
  it("matches web3.js unsigned and signed", async () => {
    const key = await routerKeyFromSeed(seed);
    const unsigned = buildTransferTransaction(key.publicKey, base58Decode(t.to), BigInt(t.lamports), base58Decode(t.blockhash));
    expect(unsigned).toBe(t.unsigned);
    expect((await signTransaction(unsigned, key)).base64).toBe(t.signed);
  });
  it("validates inputs", () => {
    expect(() => buildTransferTransaction(new Uint8Array(31), new Uint8Array(32), 1n, new Uint8Array(32))).toThrow();
    expect(() => buildTransferTransaction(new Uint8Array(32), new Uint8Array(32), -1n, new Uint8Array(32))).toThrow();
  });
});

import tokenVectors from "./__fixtures__/soltx-token-vectors.json";
import {
  buildCloseAccountTransaction,
  buildTokenSendTransaction,
  findAssociatedTokenAddress,
  isOnCurve,
} from "./soltx";
import { base58Encode } from "./solana";

/** header, blockhash and every instruction with its accounts resolved to base58. */
function decodeLegacy(b64: string) {
  const bytes = base64ToBytes(b64);
  const tx = parseTransaction(bytes);
  let p = tx.messageStart + 3;
  const n = readCompactU16(bytes, p);
  p = n.next + n.value * 32;
  const blockhash = base58Encode(bytes.slice(p, p + 32));
  p += 32;
  const count = readCompactU16(bytes, p);
  p = count.next;
  const keys = tx.accountKeys.map((k) => base58Encode(k));
  const ixs = [];
  for (let i = 0; i < count.value; i += 1) {
    const program = keys[bytes[p]];
    p += 1;
    const nk = readCompactU16(bytes, p);
    p = nk.next;
    const accts = [];
    for (let j = 0; j < nk.value; j += 1) accts.push(keys[bytes[p + j]]);
    p += nk.value;
    const dl = readCompactU16(bytes, p);
    p = dl.next;
    ixs.push({ program, accts, data: Buffer.from(bytes.slice(p, p + dl.value)).toString("hex") });
    p += dl.value;
  }
  return { signers: tx.numRequiredSignatures, feePayer: keys[0], keySet: [...keys].sort(), blockhash, ixs };
}

describe("token transactions match web3.js", () => {
  const v = tokenVectors;
  const d = (s: string) => base58Decode(s);

  it("CloseAccount, rent back to the owner (accounts de-duplicated)", () => {
    expect(buildCloseAccountTransaction(d(v.owner), d(v.acct), d(v.owner), d(v.blockhash))).toBe(v.close1);
  });

  it("CloseAccount, rent to another wallet", () => {
    expect(buildCloseAccountTransaction(d(v.owner), d(v.acct), d(v.recip), d(v.blockhash))).toBe(v.close2);
  });

  it("create-ATA-idempotent + TransferChecked", async () => {
    const ata = await findAssociatedTokenAddress(d(v.recip), d(v.mint));
    expect(base58Encode(ata)).toBe(v.ataRecip);
    const tx = buildTokenSendTransaction({
      owner: d(v.owner),
      sourceAccount: d(v.acct),
      mint: d(v.mint),
      decimals: 6,
      amount: 1234567n,
      recipient: d(v.recip),
      recipientAta: ata,
      recentBlockhash: d(v.blockhash),
    });
    // web3.js orders accounts within a group by base58 text; the runtime accepts any
    // order, so compare what the message means rather than its bytes.
    expect(decodeLegacy(tx)).toEqual(decodeLegacy(v.send));
  });

  it("derives associated token addresses like web3.js (30 owners)", async () => {
    for (const [owner, expected] of v.many) {
      expect(base58Encode(await findAssociatedTokenAddress(d(owner), d(v.mint)))).toBe(expected);
    }
  });

  it("knows a derived address is off the curve and a public key is on it", async () => {
    expect(isOnCurve(await findAssociatedTokenAddress(d(v.owner), d(v.mint)))).toBe(false);
    expect(isOnCurve(d(vectors.address))).toBe(true);
  });

  it("refuses a zero token amount", () => {
    expect(() =>
      buildTokenSendTransaction({
        owner: d(v.owner), sourceAccount: d(v.acct), mint: d(v.mint), decimals: 6, amount: 0n,
        recipient: d(v.recip), recipientAta: d(v.acct), recentBlockhash: d(v.blockhash),
      }),
    ).toThrow(/out of range/);
  });
});
