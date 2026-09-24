/**
 * Group envelopes: N links from one form submission, and the CSV that carries
 * them out of the tab.
 *
 * This is the cheap half of M6, shipped early because it costs nothing but the
 * loop: each envelope is an ordinary Zenvelope envelope with its own secret,
 * its own one-time address and its own single-output ZIP-321 URI. Nothing about
 * a group is shared except the amount and the message, and nothing on the chain
 * says the N envelopes belong together.
 *
 * From M4 the core lives in a Web Worker, so every derivation is a message round
 * trip and {@link generateGroup} is asynchronous: N envelopes are N awaited
 * round trips, reported one by one so the page can say which one it is on
 * instead of freezing on "Creating…".
 *
 * Every secret is generated in the core worker and lives in this module's return
 * value, in React state, and in the CSV the sender chooses to download. It is
 * never stored, never sent anywhere and never recoverable — losing it means the
 * envelope stays funded and unopenable, which is the honest trade for a design
 * where we hold nothing.
 */

import type { AsyncCore, Network } from "../core/types";
import { zatToZecString } from "../core/mock";

/** The most links one submission will make. Fifty QRs is already a lot of paper. */
export const MAX_ENVELOPES = 50;

export interface GroupEnvelope {
  /** 1-based, and the CSV's first column. */
  index: number;
  /** `https://host/e#<secret>[.<birthday>]`. This string is the money. */
  link: string;
  /** The one-time unified address the sender pays. */
  address: string;
  /**
   * The full viewing key for that address. Shown behind a disclosure on the
   * single-envelope screen and deliberately **not** a CSV column: it reveals
   * amounts and memos, and a spreadsheet is the wrong place to leave it.
   */
  ufvk: string;
  /** Zatoshi the person who opens this envelope receives. */
  envelopeZat: bigint;
  /** The same number as a ZEC decimal string: the CSV's `envelope_zec`. */
  envelopeZec: string;
  /** Zatoshi the sender must send: the envelope plus the flat service fee. */
  sendZat: bigint;
  /**
   * The same number as a ZEC decimal string: the CSV's `send_zec`, and exactly
   * the `amount=` the URI carries. Paying the URI and paying this column are
   * therefore the same act, which is the point of having both.
   */
  sendZec: string;
  /** The sender's message. The same for every envelope in a group; "" when none. */
  memo: string;
  /** Single-output ZIP-321, exactly what a wallet is handed. */
  uri: string;
  /**
   * The block the payment was mined in, once the create page has seen it arrive.
   * Undefined until then, and forever if the tab was closed first.
   */
  paidHeight?: number;
  /**
   * `link` with its birthday moved to `paidHeight`: `#<secret>.<paid_height>`.
   * Opens faster, because the scan starts at the payment instead of at creation.
   * The original `link` stays valid.
   */
  finalLink?: string;
}

export interface GroupRequest {
  /** How many envelopes. 1 to {@link MAX_ENVELOPES}. */
  count: number;
  /** What each envelope is worth, in zatoshi, before the service fee. */
  envelopeZat: bigint;
  /** The flat service fee per envelope, in zatoshi (DECISIONS D5). */
  feeZat: bigint;
  /** The sender's message, already trimmed. "" for none. */
  message: string;
  network: Network;
  /** Chain height at creation, so each link carries a birthday. */
  birthday?: number;
  /** `window.location.origin`, so the links point at the page they were made on. */
  origin: string;
}

export interface CountOk {
  ok: true;
  count: number;
}
export interface CountErr {
  ok: false;
  error: string;
}
export type CountResult = CountOk | CountErr;

/** Validates the "number of envelopes" field. Whole numbers, 1 to 50. */
export function validateCount(input: string): CountResult {
  const t = input.trim();
  if (t === "") return { ok: false, error: "Enter how many envelopes you want." };
  if (!/^\d+$/.test(t)) return { ok: false, error: "Use a whole number of envelopes." };
  const n = Number(t);
  if (n < 1) return { ok: false, error: "One envelope is the smallest group." };
  if (n > MAX_ENVELOPES) {
    return { ok: false, error: `${MAX_ENVELOPES} envelopes at a time is the limit.` };
  }
  return { ok: true, count: n };
}

/** Called after each envelope is finished, so the form can count up rather than freeze. */
export type GroupProgressFn = (made: number, total: number) => void;

/**
 * The part of the core a group needs: four calls, each a round trip to the core
 * worker. Narrower than the whole core on purpose, so the tests can hand this a
 * four-method object instead of a whole fake wasm module.
 */
export type GroupCore = Pick<
  AsyncCore,
  "generate_secret" | "derive" | "build_fragment" | "payment_uri"
>;

/**
 * Makes `count` envelopes with the given core.
 *
 * The chain height is fetched once by the caller and passed in, so N links cost
 * N derivations and no extra network. The derivations themselves are sequential
 * rather than a `Promise.all`: the worker is one thread holding one wasm module,
 * so racing them would only queue them out of order and lose the running count.
 * A duplicate secret would be a catastrophic core bug, so it is checked rather
 * than assumed.
 */
export async function generateGroup(
  core: GroupCore,
  req: GroupRequest,
  onProgress?: GroupProgressFn,
): Promise<GroupEnvelope[]> {
  const count = Math.floor(req.count);
  if (count < 1 || count > MAX_ENVELOPES) {
    throw new Error(`count must be 1 to ${MAX_ENVELOPES}`);
  }
  if (req.envelopeZat <= 0n) throw new Error("the envelope amount must be positive");

  const envelopeZat = req.envelopeZat;
  const envelopeZec = zatToZecString(envelopeZat);
  const sendZat = envelopeZat + req.feeZat;
  const sendZec = zatToZecString(sendZat);
  const seen = new Set<string>();
  const out: GroupEnvelope[] = [];

  for (let i = 1; i <= count; i++) {
    const secret = await core.generate_secret();
    if (seen.has(secret)) throw new Error("the core produced the same secret twice");
    seen.add(secret);

    const derived = await core.derive(secret, req.network);
    const fragment = await core.build_fragment(secret, req.birthday);
    const uri = await core.payment_uri(
      derived.address,
      sendZat,
      req.message === "" ? undefined : req.message,
    );
    out.push({
      index: i,
      link: `${req.origin}/e#${fragment}`,
      address: derived.address,
      ufvk: derived.ufvk,
      envelopeZat,
      envelopeZec,
      sendZat,
      sendZec,
      memo: req.message,
      uri,
    });
    onProgress?.(i, count);
  }
  return out;
}

/* --------------------------------------------------------------------- CSV */

/**
 * The header row, in order. Fixed: a spreadsheet somewhere will depend on it.
 *
 * Two amount columns, because they answer two different questions and conflating
 * them is how somebody underpays fifty envelopes at once. `envelope_zec` is what
 * the person who opens that link receives; `send_zec` is what the sender must
 * actually send for it — the envelope plus the flat service fee — and it is the
 * same number the `payment_uri` carries in its `amount=`.
 */
export const CSV_COLUMNS = [
  "index",
  "link",
  "address",
  "envelope_zec",
  "send_zec",
  "memo",
  "payment_uri",
  // Filled in as payments arrive while the create page is open; empty otherwise.
  // Appended rather than inserted, so a sheet built on the first seven still reads.
  "paid_height",
  "final_link",
] as const;

/** Characters that make a spreadsheet treat a cell as a formula instead of text. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One RFC 4180 cell.
 *
 * Two jobs. The first is ordinary quoting: a cell containing a comma, a quote
 * or a newline is wrapped in quotes and its own quotes are doubled. The second
 * is CSV injection, which matters here because the memo is text a stranger may
 * have typed: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage
 * return is a formula to Excel, Sheets and LibreOffice, so it gets a leading
 * apostrophe and is always quoted. Nothing in this file is worth an RCE in
 * somebody's payroll spreadsheet.
 */
export function csvCell(value: string): string {
  const neutralised = FORMULA_START.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralised) || neutralised !== value) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/**
 * The whole file: a header row and one row per envelope, CRLF terminated per
 * RFC 4180 so Excel on Windows reads it without a fight.
 */
export function buildCsv(rows: readonly GroupEnvelope[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(String(r.index)),
        csvCell(r.link),
        csvCell(r.address),
        csvCell(r.envelopeZec),
        csvCell(r.sendZec),
        csvCell(r.memo),
        csvCell(r.uri),
        csvCell(r.paidHeight === undefined ? "" : String(r.paidHeight)),
        csvCell(r.finalLink ?? ""),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** `zenvelope-3-envelopes-2026-09-21.csv`. No secret in the name. */
export function csvFilename(count: number, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `zenvelope-${count}-envelopes-${date}.csv`;
}

/** The sum the sender is about to pay, as a ZEC string. */
export function groupTotal(rows: readonly GroupEnvelope[]): string {
  return zatToZecString(rows.reduce((acc, r) => acc + r.sendZat, 0n));
}

/**
 * N payments of the same size, as a ZEC string, for the running total on the
 * form before anything has been generated. bigint throughout: 50 x 0.01 must
 * not go anywhere near a float.
 */
export function zecMultiple(perEnvelopeZat: bigint, n: number): string {
  return zatToZecString(perEnvelopeZat * BigInt(Math.max(0, Math.floor(n))));
}
