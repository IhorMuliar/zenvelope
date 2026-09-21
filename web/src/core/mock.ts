/**
 * MOCK core.
 *
 * Used only when no WASM build is present under web/src/wasm/core. It is
 * deliberately obvious: every address it returns contains the string "mock" and
 * the UI shows a MOCK badge. It does no real Zcash key derivation and the
 * addresses it produces are not spendable.
 */

import type {
  AddressClass,
  Derived,
  SyncCore,
  Network,
  NewWallet,
  NotesToSpend,
  OpenResult,
  ParsedFragment,
  ProgressFn,
  StageFn,
  SweepResult,
  SweepStage,
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

/**
 * What the mock says served it. It is deliberately not a real host: a timing
 * line that reads `gateway mock` can never be mistaken for a mainnet run.
 */
export const MOCK_GATEWAY = "mock";
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
          gateway: MOCK_GATEWAY,
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

/* ------------------------------------------------------------ M3: the spend */

/**
 * MOCK proving-key warm-up. Three seconds, so the UI's background warm is a real
 * wait to test against. The real core spends about 35 s here on a desktop and up
 * to four times that on a slow phone.
 */
export const MOCK_WARM_MS = 3000;

let warmStarted: Promise<number> | null = null;

export function warmProvingKey(): Promise<number> {
  if (!warmStarted) {
    const t0 = Date.now();
    warmStarted = new Promise((resolve) =>
      setTimeout(() => resolve(Date.now() - t0), MOCK_WARM_MS),
    );
  }
  return warmStarted;
}

const UA_PREFIX: Record<Network, string> = { main: "u1", test: "utest1" };
const SAPLING_PREFIX: Record<Network, string> = { main: "zs1", test: "ztestsapling1" };
const TRANSPARENT_RE: Record<Network, RegExp> = {
  main: /^t[13][1-9A-HJ-NP-Za-km-z]{20,}$/,
  test: /^t[mn][1-9A-HJ-NP-Za-km-z]{20,}$/,
};

/**
 * MOCK address classification, by prefix and shape only. No Bech32m checksum is
 * verified and no receiver is parsed, so this is a shape check, not a validation.
 *
 * The real core decodes the address and looks for an Orchard receiver. The mock
 * cannot, so it uses one documented stand-in: a unified address containing the
 * substring `noorchard` is reported as `unified_no_orchard`, which is how the
 * "no Orchard receiver" screen is exercised without a real such address.
 */
export function classifyAddress(addr: string, network: Network): AddressClass {
  const a = addr.trim();
  if (a === "") return { kind: "invalid", reason: "empty" };
  if (a.startsWith(SAPLING_PREFIX[network])) {
    return { kind: "sapling", reason: "Sapling receiver only" };
  }
  if (a.startsWith(UA_PREFIX[network])) {
    if (a.length < 40) return { kind: "invalid", reason: "unified address is too short" };
    return a.includes("noorchard")
      ? { kind: "unified_no_orchard", reason: "no Orchard receiver in this unified address" }
      : { kind: "unified_orchard", reason: null };
  }
  if (TRANSPARENT_RE[network].test(a)) return { kind: "transparent", reason: null };
  return { kind: "invalid", reason: "not a Zcash address for this network" };
}

/**
 * 24 words for the MOCK wallet. These are real BIP-39 words in a fixed order, but
 * the mock does no ZIP-32 derivation, so the wallet they describe holds nothing
 * and restores nothing. The address it comes with says `mock`, and the page says
 * so too.
 */
const MOCK_WORDS = [
  "abandon", "ability", "absent", "absorb", "abstract", "absurd",
  "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "action", "actor", "actress",
  "adapt", "addict", "address", "adjust", "admit", "adult",
  "advance", "advice", "aerobic", "affair", "afford", "afraid",
  "again", "agent",
];

export function newWallet(network: Network, birthday: number): NewWallet {
  if (!Number.isInteger(birthday) || birthday < 0) {
    throw new Error("birthday must be a height");
  }
  const seed = new Uint8Array(16);
  crypto.getRandomValues(seed);
  const words: string[] = [];
  let h = fnv1a(seed, 7) || 1;
  for (let i = 0; i < 24; i++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    words.push(MOCK_WORDS[(h >>> 9) % MOCK_WORDS.length]);
  }
  return {
    mnemonic: words.join(" "),
    address: `${UA_PREFIX[network]}mock${mockBody(seed, 3, 54)}`,
    ufvk: `${network === "main" ? "uview" : "uviewtest"}1mock${mockBody(seed, 4, 64)}`,
    birthday,
  };
}

/**
 * MOCK sweep. Four stages of its own length, then a made-up txid.
 *
 * It touches no network and signs nothing: `lightwalletd_url` and the secret are
 * accepted and ignored so the call shape matches the real core exactly. Every note
 * handed to it is worth one MOCK note, so the amounts are the review screen's
 * arithmetic on the number of notes it was given — which is what the done screen
 * then reports.
 */
/**
 * What each stage costs, in milliseconds.
 *
 * They used to be a flat second each. They are deliberately different now: the
 * done screen reports a duration per stage, and a block of four identical
 * numbers cannot tell a right mapping from a wrong one. They still add up to the
 * four seconds the flow has always taken, and none is short enough for a test to
 * miss the stage while it is on screen.
 */
export const MOCK_STAGE_TIMES: Record<Exclude<SweepStage, "done">, number> = {
  witness: 800,
  keys: 700,
  proving: 1300,
  broadcast: 1200,
};

/** The whole mock sweep, tap to done. */
export const MOCK_SWEEP_MS = Object.values(MOCK_STAGE_TIMES).reduce((a, b) => a + b, 0);

/** ZIP-317, two actions. The transparent destination costs one more logical action. */
export const MOCK_NETWORK_FEE_ZAT = 10000n;
export const MOCK_NETWORK_FEE_TRANSPARENT_ZAT = 15000n;
/** ZIP-317's marginal fee: what a third, fourth or fifth note costs. */
export const MOCK_MARGINAL_FEE_ZAT = 5000n;

const MOCK_STAGES: readonly [Exclude<SweepStage, "done">, string][] = [
  ["witness", "reading the note's position in the commitment tree"],
  ["keys", "building the Ironwood proving key"],
  ["proving", "one Ironwood spend proof, single-threaded"],
  ["broadcast", "handing the signed transaction to lightwalletd"],
];

/** A stable, obviously made-up 64-hex txid, so the done screen has something real-shaped. */
export function mockTxid(destination: string): string {
  const bytes = new TextEncoder().encode(destination);
  let out = "";
  let h = fnv1a(bytes, 11) || 1;
  for (let i = 0; i < 64; i++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    out += "0123456789abcdef"[(h >>> 12) % 16];
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sweepEnvelope(
  secret_b64url: string,
  network: Network,
  _lightwalletd_url: string,
  notes: NotesToSpend,
  destination: string,
  fee_address: string,
  fee_zat: string,
  _memo: string | null,
  broadcast: boolean,
  on_stage: StageFn,
): Promise<SweepResult> {
  // Derive first, so a bad secret fails the same way the real core would.
  derive(secret_b64url, network);
  const kind = classifyAddress(destination, network).kind;
  if (kind !== "unified_orchard" && kind !== "transparent") {
    throw new Error("this destination cannot receive the envelope");
  }
  // A bare note object is the M3 form and still means one note, exactly as it does
  // in the real core.
  const spending = Array.isArray(notes) ? notes : [notes];
  if (spending.length === 0) throw new Error("a sweep needs at least one note");
  const seen = new Set<string>();
  for (const n of spending) {
    const key = `${n.txid}:${n.action_index}`;
    if (seen.has(key)) throw new Error("a transaction cannot spend the same note twice");
    seen.add(key);
  }

  for (const [stage, detail] of MOCK_STAGES) {
    on_stage(stage, detail);
    await sleep(MOCK_STAGE_TIMES[stage]);
  }

  // Ironwood charges max(spends, outputs) actions, padded to two, so the first two
  // notes are free and the third is not: the same rule the real core applies.
  const networkFee =
    spending.length <= 2
      ? kind === "transparent"
        ? MOCK_NETWORK_FEE_TRANSPARENT_ZAT
        : MOCK_NETWORK_FEE_ZAT
      : MOCK_MARGINAL_FEE_ZAT * (BigInt(spending.length) + (kind === "transparent" ? 1n : 0n));
  const fee = fee_address.trim() === "" ? 0n : BigInt(fee_zat.trim() || "0");
  const inEnvelope = BigInt(MOCK_NOTE.amount_zat) * BigInt(spending.length);
  const toDestination = inEnvelope - networkFee - fee;

  on_stage("done", "the envelope is empty");
  return {
    txid: mockTxid(destination),
    raw_tx_hex: broadcast ? null : "00".repeat(16),
    amount_to_destination_zat: toDestination.toString(),
    fee_zat: fee.toString(),
    network_fee_zat: networkFee.toString(),
    anchor_height: MOCK_TIP_HEIGHT,
    broadcast,
    error_code: null,
    error_message: null,
    gateway: MOCK_GATEWAY,
  };
}

export const mockCore: SyncCore = {
  isMock: true,
  derive,
  generate_secret: generateSecret,
  parse_fragment: parseFragment,
  build_fragment: buildFragment,
  payment_uri: paymentUri,
  zat_to_zec_string: zatToZecString,
  zec_string_to_zat: zecStringToZat,
  open_envelope: openEnvelope,
  warm_proving_key: warmProvingKey,
  classify_address: classifyAddress,
  new_wallet: newWallet,
  sweep_envelope: sweepEnvelope,
};
