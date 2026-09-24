/**
 * The NEAR Intents 1Click client: the only code in Zenvelope that talks to the
 * swap rail (DECISIONS D10).
 *
 * Four calls, nothing else: the token list, a **dry** quote (a price, binding
 * nothing and reserving nothing), a **real** quote (the same price plus a
 * transparent ZEC deposit address the rail watches for three days), and the
 * status of a deposit address once the sweep has paid it.
 *
 * Everything here is a fetch and a parse. This module never builds, signs or
 * broadcasts a Zcash transaction, never sees the envelope secret, and never
 * holds funds: the browser pays the quoted deposit address with the ordinary
 * sweep, and the rail pays out on Solana. Zenvelope is not the swap provider.
 *
 * Measured against the live API on 2026-09-21 (`web/docs/M5-VERIFICATION.md`):
 *
 *   - base `https://1click.chaindefuser.com/v0`, CORS `*`, no API key, and the
 *     only request header the preflight allows is `content-type`
 *   - the minimum is an HTTP 400 whose message is
 *     `Amount is too low for bridge, try at least 132000` — the floor is a
 *     moving ~$2 and is therefore read out of that text, never hard-coded
 *   - an unauthenticated quote silently carries an `appFees` entry (25 bps when
 *     measured) that is not ours and that we surface anyway ({@link appFeeBps})
 *   - `amountOut` is already net of `withdrawFee`, so the honest number to show
 *     is the USD spread between `amountInUsd` and `amountOutUsd`
 *   - a real quote answers with a transparent `t1…` deposit address and no
 *     memo, and the server replaces the deadline we ask for with one three days
 *     out
 */

import { solanaExit as copy } from "../copy/en";

/** The live base. There is no test network for this rail. */
export const ONECLICK_BASE = "https://1click.chaindefuser.com/v0";

/** Every request gives up after this long, connected or not. */
export const ONECLICK_TIMEOUT_MS = 10_000;

/** ZEC on the rail's asset namespace, the origin asset for every quote we ask for. */
export const ZEC_ASSET_ID = "nep141:zec.omft.near";

/**
 * The rail's own service fee, in basis points, read out of the quote.
 *
 * An unauthenticated quote has carried a 25 bps `appFees` entry that is not ours
 * (measured 2026-09-21), but that is the rail's choice and can change, so the
 * figure on screen is whatever the quote actually says: the sum of every
 * `{recipient, fee}` entry, looked for on the response and on its echoed
 * `quoteRequest`. null when neither carries the field, which is not the same as
 * zero: an absent field means we do not know.
 */
export function appFeeBps(response: unknown): number | null {
  const r = response as { appFees?: unknown; quoteRequest?: { appFees?: unknown } } | null;
  const list = Array.isArray(r?.appFees)
    ? r!.appFees
    : Array.isArray(r?.quoteRequest?.appFees)
      ? r!.quoteRequest!.appFees
      : null;
  if (list === null) return null;
  let total = 0;
  for (const entry of list as unknown[]) {
    const fee = Number((entry as { fee?: unknown } | null)?.fee);
    if (Number.isFinite(fee) && fee > 0) total += fee;
  }
  return total;
}

/** The one-line disclosure of the rail's service fee, shown next to the spread. */
export function appFeeDisclosure(bps: number | null): string {
  return copy.feeLine(bps);
}

/** Slippage we accept, in basis points. 1%. */
export const SLIPPAGE_BPS = 100;

/** How long the rail may take to settle on a price before answering. */
export const QUOTE_WAITING_TIME_MS = 3_000;

/**
 * The deadline we ask for. The server overrides it on a real quote with one about
 * three days out, which is how long the deposit address stays watched.
 */
export const QUOTE_DEADLINE_MS = 3 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ assets */

export type SolanaAsset = "usdc" | "sol";

export interface AssetSpec {
  /** The rail's asset id, sent as `destinationAsset`. */
  id: string;
  symbol: string;
  /** Decimal places of the smallest unit `amountOut` is denominated in. */
  decimals: number;
  /** What the card calls it. */
  label: string;
}

/** The two Solana destinations we offer. Checked against GET /tokens. */
export const SOLANA_ASSETS: Record<SolanaAsset, AssetSpec> = {
  usdc: {
    id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    symbol: "USDC",
    decimals: 6,
    label: "USDC on Solana",
  },
  sol: {
    id: "nep141:sol.omft.near",
    symbol: "SOL",
    decimals: 9,
    label: "SOL on Solana",
  },
};

/* ------------------------------------------------------------------ errors */

export type OneClickErrorKind =
  /** The request did not answer inside {@link ONECLICK_TIMEOUT_MS}. */
  | "timeout"
  /** The request never reached the rail at all. */
  | "network"
  /** HTTP 400 with the "try at least N" message: {@link OneClickError.minAmountZat}. */
  | "min_amount"
  /** Any other non-2xx. */
  | "http"
  /** A 2xx whose body is not the shape this module knows. */
  | "malformed";

/**
 * Anything that went wrong talking to the rail, with the reason kept separate
 * from the sentence, so the screen can say something different about a floor
 * than about a dead network.
 */
export class OneClickError extends Error {
  readonly kind: OneClickErrorKind;
  readonly status: number | null;
  /** Set only when `kind` is `min_amount`: the floor the rail named, in zatoshi. */
  readonly minAmountZat: bigint | null;

  constructor(
    kind: OneClickErrorKind,
    message: string,
    status: number | null = null,
    minAmountZat: bigint | null = null,
  ) {
    super(message);
    this.name = "OneClickError";
    this.kind = kind;
    this.status = status;
    this.minAmountZat = minAmountZat;
  }
}

/**
 * The floor out of a 400 body.
 *
 * The rail's minimum is a moving ~$2 in ZEC, so the only honest source for it is
 * the error it hands back when an amount is under it. Anything that does not
 * match this shape is not a min-amount error.
 */
export function parseMinAmount(message: string): bigint | null {
  const m = /try at least\s+(\d+)/i.exec(message);
  if (!m) return null;
  try {
    return BigInt(m[1]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the transport */

/** What the rail said, when it said anything at all. */
interface ErrorBody {
  message?: unknown;
}

function errorMessage(body: unknown, status: number): string {
  const m = (body as ErrorBody | null)?.message;
  return typeof m === "string" && m.trim() !== "" ? m.trim() : `The swap service answered ${status}.`;
}

/**
 * One request, with a hard {@link ONECLICK_TIMEOUT_MS} ceiling and every failure
 * turned into a {@link OneClickError}. Nothing else in this module calls `fetch`.
 */
async function request<T>(
  path: string,
  init: RequestInit,
  timeoutMs = ONECLICK_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${ONECLICK_BASE}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new OneClickError(
        "timeout",
        `The swap service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    }
    throw new OneClickError("network", `Could not reach the swap service: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = errorMessage(body, response.status);
    const floor = response.status === 400 ? parseMinAmount(message) : null;
    if (floor !== null) {
      throw new OneClickError("min_amount", message, response.status, floor);
    }
    throw new OneClickError("http", message, response.status);
  }

  if (body === null || typeof body !== "object") {
    throw new OneClickError("malformed", "The swap service sent something we could not read.");
  }
  return body as T;
}

/* ------------------------------------------------------------------- tokens */

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  /** USD, as the rail's own price feed has it. */
  price?: number;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

/** GET /tokens. Used to prove the three asset ids we hard-code are still live. */
export async function oneClickTokens(timeoutMs = ONECLICK_TIMEOUT_MS): Promise<OneClickToken[]> {
  const body = await request<unknown>("/tokens", { method: "GET" }, timeoutMs);
  if (!Array.isArray(body)) {
    throw new OneClickError("malformed", "The swap service did not send a token list.");
  }
  return body as OneClickToken[];
}

/** The USD price of one ZEC, out of the token list. null when it is not there. */
export function zecPriceUsd(tokens: OneClickToken[]): number | null {
  const zec = tokens.find((t) => t.assetId === ZEC_ASSET_ID);
  return typeof zec?.price === "number" ? zec.price : null;
}

/* ------------------------------------------------------------------- quotes */

export interface QuoteInput {
  /** true asks a price and reserves nothing. false reserves a deposit address. */
  dry: boolean;
  asset: SolanaAsset;
  /** What the sweep would actually pay in, in zatoshi. */
  amountZat: bigint;
  /** Where a failed swap sends the ZEC back. A Zcash address, t1 or unified. */
  refundTo: string;
  /** The Solana address that receives the payout. */
  recipient: string;
  slippageBps?: number;
  /** Injectable so the request body is deterministic under test. */
  now?: Date;
}

/** The priced part of a quote response. */
export interface OneClickQuote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  /** Already net of `withdrawFee`. */
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Seconds the rail expects the whole swap to take. */
  timeEstimate: number;
  /** Zatoshi charged if the swap refunds. */
  refundFee: string;
  /** Destination-chain withdrawal fee, in the destination asset's smallest unit. */
  withdrawFee: string;
  /** Real quotes only: the transparent ZEC address to pay. */
  depositAddress?: string;
  /** Real quotes only: about three days out, set by the server. */
  deadline?: string;
  timeWhenInactive?: string;
}

export interface OneClickAppFee {
  recipient: string;
  /** Basis points. */
  fee: number;
}

export interface OneClickQuoteResponse {
  quote: OneClickQuote;
  quoteRequest: {
    dry: boolean;
    amount: string;
    originAsset: string;
    destinationAsset: string;
    refundTo: string;
    recipient: string;
    appFees?: OneClickAppFee[];
  };
  /** Some responses carry the fee list at the top level rather than in the echo. */
  appFees?: OneClickAppFee[];
  signature: string;
  timestamp: string;
  correlationId?: string;
}

/** The exact JSON body a quote is asked for with. Exported so a test can read it. */
export function quoteBody(input: QuoteInput): Record<string, unknown> {
  const now = input.now ?? new Date();
  return {
    dry: input.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageBps ?? SLIPPAGE_BPS,
    originAsset: ZEC_ASSET_ID,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: SOLANA_ASSETS[input.asset].id,
    amount: input.amountZat.toString(),
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + QUOTE_DEADLINE_MS).toISOString(),
    quoteWaitingTimeMs: QUOTE_WAITING_TIME_MS,
  };
}

/**
 * POST /quote.
 *
 * With `dry: true` this is a price and nothing more. With `dry: false` the rail
 * reserves a transparent deposit address for about three days; that is the only
 * side effect, and it is harmless — an address nobody pays simply expires.
 */
export async function oneClickQuote(
  input: QuoteInput,
  timeoutMs = ONECLICK_TIMEOUT_MS,
): Promise<OneClickQuoteResponse> {
  const body = await request<OneClickQuoteResponse>(
    "/quote",
    {
      method: "POST",
      // `content-type` is the only header the rail's preflight allows.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quoteBody(input)),
    },
    timeoutMs,
  );
  if (!body || typeof body.quote !== "object" || body.quote === null) {
    throw new OneClickError("malformed", "The swap service sent a quote we could not read.");
  }
  if (!input.dry && typeof body.quote.depositAddress !== "string") {
    throw new OneClickError("malformed", "The swap service did not send a deposit address.");
  }
  return body;
}

/* ------------------------------------------------------------------- status */

/**
 * The stages a swap goes through, as the rail reports them. The rail may add
 * more, so {@link isFinalStatus} decides when to stop polling rather than a
 * closed list.
 */
export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED"
  | "INCOMPLETE_DEPOSIT";

export interface OneClickStatusResponse {
  status: OneClickStatus | string;
  updatedAt: string;
  swapDetails?: {
    amountOut?: string | null;
    amountOutFormatted?: string | null;
    amountOutUsd?: string | null;
    refundedAmount?: string | null;
    refundReason?: string | null;
    originChainTxHashes?: Array<{ hash?: string } | string> | null;
    destinationChainTxHashes?: Array<{ hash?: string } | string> | null;
  } | null;
}

/** GET /status. A deposit address the rail has never seen answers 404. */
export async function oneClickStatus(
  depositAddress: string,
  timeoutMs = ONECLICK_TIMEOUT_MS,
): Promise<OneClickStatusResponse> {
  return request<OneClickStatusResponse>(
    `/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    { method: "GET" },
    timeoutMs,
  );
}

/** How often the open page asks again while a swap is in flight. */
export const STATUS_POLL_MS = 20_000;

/** True once there is nothing left to wait for. */
export function isFinalStatus(status: string): boolean {
  return status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";
}

/** The Solana transaction id, once the rail has paid out. null until then. */
export function solanaTxid(status: OneClickStatusResponse): string | null {
  const list = status.swapDetails?.destinationChainTxHashes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  const hash = typeof first === "string" ? first : first?.hash;
  return typeof hash === "string" && hash.trim() !== "" ? hash.trim() : null;
}

/**
 * What the rail actually paid out, once it says SUCCESS, as "14.400612 USDC".
 *
 * The final `GET /status` carries it in `swapDetails.amountOutFormatted` (and
 * the raw `swapDetails.amountOut` in the asset's smallest unit): on the live
 * run of 2026-09-24 that was 14.400612 USDC against 14.384176 quoted
 * (M5-VERIFICATION §7). null before SUCCESS, and null when the field is absent,
 * so the screen falls back to the quoted figure rather than inventing one.
 */
export function paidOutAmount(status: OneClickStatusResponse | null, asset: SolanaAsset): string | null {
  if (!status || status.status !== "SUCCESS") return null;
  const d = status.swapDetails;
  if (!d) return null;
  const spec = SOLANA_ASSETS[asset];
  const formatted = typeof d.amountOutFormatted === "string" ? d.amountOutFormatted.trim() : "";
  if (formatted !== "" && Number.isFinite(Number(formatted)) && Number(formatted) > 0) {
    return `${formatted} ${spec.symbol}`;
  }
  const raw = typeof d.amountOut === "string" ? d.amountOut.trim() : "";
  if (/^\d+$/.test(raw) && BigInt(raw) > 0n) {
    const padded = raw.padStart(spec.decimals + 1, "0");
    const whole = padded.slice(0, padded.length - spec.decimals);
    const frac = padded.slice(padded.length - spec.decimals);
    return `${whole}.${frac} ${spec.symbol}`;
  }
  return null;
}

/* --------------------------------------------------- what it actually costs */

export interface EffectiveCost {
  amountInUsd: number;
  amountOutUsd: number;
  /** 1 - out/in, as a fraction. Negative would mean the rail paid us. */
  spread: number;
  spreadBps: number;
  /** "10.69%", for the screen. */
  spreadPct: string;
  /** The USD the recipient does not get: `amountInUsd - amountOutUsd`. */
  costUsd: number;
  /** The rail's service fee from the quote's `appFees`, or null when absent. */
  appFeeBps: number | null;
  disclosure: string;
  /** False when the rail sent USD figures we cannot do arithmetic on. */
  ok: boolean;
}

/** A figure the rail sent, as a number. An empty or absent one is NaN, not 0. */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v !== "string" || v.trim() === "") return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * What the swap really costs, from the two USD figures the quote carries.
 *
 * `amountOut` is already net of the destination withdrawal fee, so the spread
 * computed here is the whole cost of leaving: the rail's rate, its withdrawal
 * fee and the rail's service fee (`appFees`), all in one number. The house fee is restated
 * separately anyway, because a fee folded into a spread is a fee nobody sees.
 *
 * The Zcash miner fee is **not** in here. It is the sweep's, it is shown on the
 * same screen by `sweepAmounts`, and double-counting it would overstate the rail.
 */
export function effectiveCost(quote: OneClickQuote, feeBps: number | null = null): EffectiveCost {
  const amountInUsd = num(quote.amountInUsd);
  const amountOutUsd = num(quote.amountOutUsd);
  const ok = Number.isFinite(amountInUsd) && Number.isFinite(amountOutUsd) && amountInUsd > 0;
  const spread = ok ? 1 - amountOutUsd / amountInUsd : Number.NaN;
  return {
    amountInUsd,
    amountOutUsd,
    spread,
    spreadBps: ok ? Math.round(spread * 10_000) : Number.NaN,
    spreadPct: ok ? `${(spread * 100).toFixed(2)}%` : "—",
    costUsd: ok ? amountInUsd - amountOutUsd : Number.NaN,
    appFeeBps: feeBps,
    disclosure: appFeeDisclosure(feeBps),
    ok,
  };
}

/** "$1.67". Two decimals, because these are small numbers and a cent matters. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** "1.671255 USDC", from the rail's own formatted figure. */
export function formatAssetAmount(quote: OneClickQuote, asset: SolanaAsset): string {
  const spec = SOLANA_ASSETS[asset];
  const formatted = quote.amountOutFormatted?.trim();
  if (formatted && formatted !== "") return `${formatted} ${spec.symbol}`;
  const raw = num(quote.amountOut);
  if (!Number.isFinite(raw)) return `— ${spec.symbol}`;
  return `${(raw / 10 ** spec.decimals).toFixed(spec.decimals)} ${spec.symbol}`;
}

/** "about 8 minutes", from `timeEstimate` in seconds. */
export function formatTimeEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a few minutes";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}
