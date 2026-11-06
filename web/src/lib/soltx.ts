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

import { base58Decode, base58Encode } from "./solana";

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

// ---------------------------------------------------------------------------
// Token instructions: close an empty account, send tokens, derive an ATA.
//
// A tiny legacy-message compiler is enough for these: one fee payer who is also the
// only signer, a handful of instructions, no lookup tables.

export const TOKEN_PROGRAM = base58Decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = base58Decode("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = base58Decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface AccountMeta {
  pubkey: Uint8Array;
  signer?: boolean;
  writable?: boolean;
}
export interface Instruction {
  programId: Uint8Array;
  keys: AccountMeta[];
  data: Uint8Array;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Compiles `instructions` into an unsigned legacy transaction (base64) whose only
 * signer is `feePayer`. Accounts are de-duplicated and ordered the way the runtime
 * wants: signer+writable, signer+readonly, writable, readonly. Programs are readonly.
 */
export function compileLegacyTransaction(
  feePayer: Uint8Array,
  instructions: Instruction[],
  recentBlockhash: Uint8Array,
): string {
  if (feePayer.length !== 32 || recentBlockhash.length !== 32) throw new Error("keys and blockhash are 32 bytes");
  const metas = new Map<string, { pubkey: Uint8Array; signer: boolean; writable: boolean }>();
  const touch = (pubkey: Uint8Array, signer: boolean, writable: boolean) => {
    const id = hex(pubkey);
    const m = metas.get(id);
    if (m) {
      m.signer ||= signer;
      m.writable ||= writable;
    } else metas.set(id, { pubkey, signer, writable });
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) touch(k.pubkey, !!k.signer, !!k.writable);
    touch(ix.programId, false, false);
  }
  const all = [...metas.values()];
  const rank = (m: { signer: boolean; writable: boolean }) => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3);
  const feeId = hex(feePayer);
  all.sort((a, b) => (hex(a.pubkey) === feeId ? -1 : hex(b.pubkey) === feeId ? 1 : rank(a) - rank(b)));
  const index = new Map(all.map((m, i) => [hex(m.pubkey), i]));
  const nSigners = all.filter((m) => m.signer).length;
  const roSigned = all.filter((m) => m.signer && !m.writable).length;
  const roUnsigned = all.filter((m) => !m.signer && !m.writable).length;
  if (nSigners !== 1) throw new Error("only a single signer is supported");

  const message: number[] = [nSigners, roSigned, roUnsigned, ...writeCompactU16(all.length)];
  for (const m of all) message.push(...m.pubkey);
  message.push(...recentBlockhash, ...writeCompactU16(instructions.length));
  for (const ix of instructions) {
    message.push(index.get(hex(ix.programId))!, ...writeCompactU16(ix.keys.length));
    for (const k of ix.keys) message.push(index.get(hex(k.pubkey))!);
    message.push(...writeCompactU16(ix.data.length), ...ix.data);
  }
  const tx = new Uint8Array(1 + SIGNATURE_BYTES + message.length);
  tx[0] = 1;
  tx.set(message, 1 + SIGNATURE_BYTES);
  return bytesToBase64(tx);
}

/**
 * SPL Token `CloseAccount` (instruction 9): closes the empty token account
 * `tokenAccount` owned by `owner` and sends its rent to `destination`. The runtime
 * refuses it while the account still holds tokens.
 */
export function buildCloseAccountTransaction(
  owner: Uint8Array,
  tokenAccount: Uint8Array,
  destination: Uint8Array,
  recentBlockhash: Uint8Array,
  tokenProgram: Uint8Array = TOKEN_PROGRAM,
): string {
  return compileLegacyTransaction(
    owner,
    [
      {
        programId: tokenProgram,
        keys: [
          { pubkey: tokenAccount, writable: true },
          { pubkey: destination, writable: true },
          { pubkey: owner, signer: true },
        ],
        data: Uint8Array.of(9),
      },
    ],
    recentBlockhash,
  );
}

function transferCheckedIx(
  source: Uint8Array,
  mint: Uint8Array,
  dest: Uint8Array,
  owner: Uint8Array,
  amount: bigint,
  decimals: number,
  tokenProgram: Uint8Array,
): Instruction {
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("token amount out of range");
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, writable: true },
      { pubkey: mint },
      { pubkey: dest, writable: true },
      { pubkey: owner, signer: true },
    ],
    data,
  };
}

function createAtaIdempotentIx(
  payer: Uint8Array,
  ata: Uint8Array,
  owner: Uint8Array,
  mint: Uint8Array,
  tokenProgram: Uint8Array,
): Instruction {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: ata, writable: true },
      { pubkey: owner },
      { pubkey: mint },
      { pubkey: SYSTEM_PROGRAM },
      { pubkey: tokenProgram },
    ],
    data: Uint8Array.of(1),
  };
}

/**
 * Sends `amount` of `mint` from `sourceAccount` (owned by `owner`) to the recipient's
 * associated token account `destAta`, creating that account first if it is missing
 * (the owner pays its rent). One transaction, `owner` signs.
 */
export function buildTokenSendTransaction(p: {
  owner: Uint8Array;
  sourceAccount: Uint8Array;
  mint: Uint8Array;
  decimals: number;
  amount: bigint;
  recipient: Uint8Array;
  recipientAta: Uint8Array;
  tokenProgram?: Uint8Array;
  recentBlockhash: Uint8Array;
}): string {
  const program = p.tokenProgram ?? TOKEN_PROGRAM;
  return compileLegacyTransaction(
    p.owner,
    [
      createAtaIdempotentIx(p.owner, p.recipientAta, p.recipient, p.mint, program),
      transferCheckedIx(p.sourceAccount, p.mint, p.recipientAta, p.owner, p.amount, p.decimals, program),
    ],
    p.recentBlockhash,
  );
}

// -- associated token address (a program-derived address) -------------------

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** True when the 32 bytes decode to a point on the ed25519 curve. */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const num = (y2 - 1n + P) % P;
  const den = (D * y2 + 1n) % P;
  const x2 = (num * modPow(den, P - 2n, P)) % P;
  if (x2 === 0n) return true;
  // x2 is a square mod P iff x2^((P-1)/2) == 1 (Euler's criterion).
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

/** `findProgramAddress`: the first bump, from 255 down, whose hash is off the curve. */
export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Uint8Array> {
  const tag = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump -= 1) {
    const parts = [...seeds, Uint8Array.of(bump), programId, tag];
    const input = new Uint8Array(parts.reduce((n, s) => n + s.length, 0));
    let o = 0;
    for (const s of parts) {
      input.set(s, o);
      o += s.length;
    }
    const hash = new Uint8Array(await subtle.digest("SHA-256", input as BufferSource));
    if (!isOnCurve(hash)) return hash;
  }
  throw new Error("no program address found");
}

/** The associated token account of `owner` for `mint`. */
export function findAssociatedTokenAddress(
  owner: Uint8Array,
  mint: Uint8Array,
  tokenProgram: Uint8Array = TOKEN_PROGRAM,
  subtle?: SubtleCrypto,
): Promise<Uint8Array> {
  return findProgramAddress([owner, tokenProgram, mint], ATA_PROGRAM, subtle);
}
