/**
 * A minimal Solana wire-format signer. No web3.js, no @solana/kit.
 *
 * What it does: take the base64 transaction MultiHopper hands back, find our key
 * among the required signers, sign the message bytes, put the signature in that slot
 * and leave every other slot alone (the server pre-signs one of the routeInit
 * transactions). What it does not do: build or inspect instructions. It also builds
 * one transaction of its own, a plain SystemProgram transfer, for the final sweep.
 *
 * Wire format:
 *   transaction = compact-u16 sigCount | sigCount * 64 bytes | message
 *   message     = [0x80 | version]? (v0 only) | header(3) | compact-u16 nKeys | nKeys*32 | ...
 *   header      = numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
 * Signers are the first `numRequiredSignatures` static keys, in signature-slot order.
 */

import { base58Encode } from "./solana";

export const SIGNATURE_BYTES = 64;
/** Fee of a one-signature transaction with no priority fee. */
export const BASE_FEE_LAMPORTS = 5000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function readCompactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const b = bytes[offset + i];
    if (b === undefined) throw new Error("transaction is truncated");
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  throw new Error("bad compact-u16 in transaction");
}

export function writeCompactU16(value: number): number[] {
  const out: number[] = [];
  let v = value;
  for (;;) {
    const low = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

export interface ParsedTx {
  version: "legacy" | 0;
  /** Offset of the first signature. */
  sigStart: number;
  sigCount: number;
  /** Offset of the message (what is signed). */
  messageStart: number;
  numRequiredSignatures: number;
  /** Static account keys, 32 bytes each, in order. */
  accountKeys: Uint8Array[];
}

export function parseTransaction(bytes: Uint8Array): ParsedTx {
  const { value: sigCount, next: sigStart } = readCompactU16(bytes, 0);
  const messageStart = sigStart + sigCount * SIGNATURE_BYTES;
  if (messageStart >= bytes.length) throw new Error("transaction is truncated");
  let p = messageStart;
  let version: "legacy" | 0 = "legacy";
  if (bytes[p] & 0x80) {
    const v = bytes[p] & 0x7f;
    if (v !== 0) throw new Error(`unsupported transaction version ${v}`);
    version = 0;
    p += 1;
  }
  const numRequiredSignatures = bytes[p];
  p += 3;
  const { value: nKeys, next } = readCompactU16(bytes, p);
  if (next + nKeys * 32 > bytes.length) throw new Error("transaction is truncated");
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i += 1) accountKeys.push(bytes.slice(next + i * 32, next + (i + 1) * 32));
  if (sigCount !== numRequiredSignatures) {
    throw new Error("transaction signature slots do not match its header");
  }
  if (numRequiredSignatures > nKeys) throw new Error("transaction header is inconsistent");
  return { version, sigStart, sigCount, messageStart, numRequiredSignatures, accountKeys };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export interface Signer {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface SignedTx {
  base64: string;
  /** First signature, base58: the transaction id. */
  signature: string;
  /** Slots still all-zero after our signature (should be none before sending). */
  unsignedSlots: number[];
}

/** Signs `base64` in our slot, keeping every other signature. */
export async function signTransaction(
  base64: string,
  signer: Signer,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<SignedTx> {
  const bytes = base64ToBytes(base64);
  const tx = parseTransaction(bytes);
  const slot = tx.accountKeys.slice(0, tx.numRequiredSignatures).findIndex((k) => sameBytes(k, signer.publicKey));
  if (slot < 0) throw new Error("the router wallet is not a required signer of this transaction");
  const message = bytes.subarray(tx.messageStart);
  const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, signer.privateKey, message as BufferSource));
  const out = bytes.slice();
  out.set(sig, tx.sigStart + slot * SIGNATURE_BYTES);
  const unsignedSlots: number[] = [];
  for (let i = 0; i < tx.sigCount; i += 1) {
    const s = out.subarray(tx.sigStart + i * SIGNATURE_BYTES, tx.sigStart + (i + 1) * SIGNATURE_BYTES);
    if (s.every((b) => b === 0)) unsignedSlots.push(i);
  }
  return {
    base64: bytesToBase64(out),
    signature: base58Encode(out.slice(tx.sigStart, tx.sigStart + SIGNATURE_BYTES)),
    unsignedSlots,
  };
}

/** Our signer's slot in `base64`, or -1. Handy for tests and sanity checks. */
export function signerSlot(base64: string, publicKey: Uint8Array): number {
  const tx = parseTransaction(base64ToBytes(base64));
  return tx.accountKeys.slice(0, tx.numRequiredSignatures).findIndex((k) => sameBytes(k, publicKey));
}

const SYSTEM_PROGRAM = new Uint8Array(32);

/**
 * An unsigned legacy transaction with one SystemProgram transfer (instruction 2):
 * `from` pays `lamports` to `to`, `from` also pays the fee.
 */
export function buildTransferTransaction(
  from: Uint8Array,
  to: Uint8Array,
  lamports: bigint,
  recentBlockhash: Uint8Array,
): string {
  if (from.length !== 32 || to.length !== 32 || recentBlockhash.length !== 32) {
    throw new Error("keys and blockhash are 32 bytes");
  }
  if (lamports < 0n || lamports >= 1n << 64n) throw new Error("lamports out of range");
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  const message = [
    1, 0, 1, // 1 signer, 0 readonly signed, 1 readonly unsigned (the program)
    3, ...from, ...to, ...SYSTEM_PROGRAM,
    ...recentBlockhash,
    1, // one instruction
    2, // program id index
    2, 0, 1, // accounts: from, to
    12, ...data,
  ];
  const tx = new Uint8Array(1 + SIGNATURE_BYTES + message.length);
  tx[0] = 1;
  tx.set(message, 1 + SIGNATURE_BYTES);
  return bytesToBase64(tx);
}
