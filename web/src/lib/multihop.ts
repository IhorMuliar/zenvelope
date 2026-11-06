/**
 * MultiHopper client and driver, over the same-origin proxy.
 *
 *   /api/mh/...  mirrors MultiHopper /api/v1/...   (see netlify/functions/_lib/mhProxy.ts)
 *   /api/sol     is a JSON-RPC relay with a method allowlist
 *
 * Everything takes `fetch` and the clock as parameters so the tests run without a
 * network. The sequence is the one measured on devnet (docs/MULTIHOPPER-PLAN.md,
 * spike results):
 *
 *   create -> prepare ({} body) -> sign+send keeperFundingTx, confirm
 *          -> confirm-broadcast({keeperFundingSignature})        (single destination only)
 *          -> routeInitTxs, orchestratorInitTx, sessionInitTxs, dispersionInitTxs, in order,
 *             each confirmed on chain before the next
 *          -> confirm-broadcast with every signature
 *
 * Response shapes differ: create / get / byExternal are a flat transfer; prepare and
 * confirm-broadcast wrap it as `{ transfer }`.
 */

import { base58Decode } from "./solana";
import type { RouterKey } from "./router";
import { BASE_FEE_LAMPORTS, buildTransferTransaction, signTransaction } from "./soltx";

// ---------------------------------------------------------------------------
// Types (only the fields we read; the API returns more)

export interface MhHop {
  index: number;
  address: string;
  scheduledAt: string | null;
  executedAt: string | null;
  txSignature: string | null;
}

export interface MhTransfer {
  id: number;
  externalId: string | null;
  status: string;
  phase?: string | null;
  tokenMint: string;
  amountRaw: string;
  sourceOwner: string;
  recipientWallet: string | null;
  destinationCount: number | null;
  destinations?: unknown[] | null;
  hops: number;
  recipientReceivesRaw?: string;
  route?: { hops: MhHop[] } | null;
  progress?: { hopsCompleted: number; hopsTotal: number } | null;
  lastError?: unknown;
  recovery?: unknown;
  completedAt?: string | null;
}

export interface MhEstimate {
  tokens: { amountRaw: string; feeRaw: string; netDeliveredRaw: string; decimals: number };
  usdEquivalent?: number;
  sol: {
    requiredSolUpFrontLamports: number;
    refundableLamports: number;
    netCostLamports: number;
    minTransferAmountLamports?: number;
    breakdown?: Record<string, number>;
  };
  [k: string]: unknown;
}

export interface PreparedTxs {
  routeInitTxs: { base64: string }[];
  orchestratorInitTx: string | null;
  sessionInitTxs: string[];
  keeperFundingTx: string | null;
  dispersionInitTxs: string[];
  resume?: { nothingToDo?: boolean; keeperAlreadyFunded?: boolean; [k: string]: unknown };
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
}

export interface ConfirmBody {
  routeInitSignatures: string[];
  keeperFundingSignature?: string;
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  dispersionInitSignatures?: string[];
}

export interface CreateParams {
  tokenMint: string;
  tokenDecimals: number;
  tokenSymbol?: string;
  amountRaw: string;
  sourceOwner: string;
  /** Exactly one of these. */
  recipientWallet?: string;
  destinations?: { wallet: string; amountRaw: string }[];
  hops?: number;
  arrivalSeconds?: number;
  externalId: string;
}

// ---------------------------------------------------------------------------
// Errors

export class MhApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MhApiError";
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class TxFailedError extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`transaction ${signature} failed: ${JSON.stringify(err)}`);
    this.name = "TxFailedError";
  }
}

export class ConfirmTimeoutError extends Error {
  constructor(readonly signature: string) {
    super(`transaction ${signature} was not confirmed in time`);
    this.name = "ConfirmTimeoutError";
  }
}

/** True when a send/confirm failed because the prepared transaction went stale. */
export function isBlockhashExpired(e: unknown): boolean {
  if (e instanceof ConfirmTimeoutError) return true;
  if (e instanceof TxFailedError) return /BlockhashNotFound/i.test(JSON.stringify(e.err));
  if (e instanceof RpcError) return /blockhash not found|block height exceeded|BlockhashNotFound/i.test(e.message);
  if (e instanceof MhApiError) return /blockhash/i.test(e.message);
  return false;
}

/** MH_041: the server wants /prepare called again (e.g. destinations not bound yet). */
export function isPrepareAgain(e: unknown): boolean {
  return e instanceof MhApiError && e.code === "MH_041";
}

// ---------------------------------------------------------------------------
// HTTP

export interface Http {
  fetch: typeof fetch;
  /** Prefix for both proxies; "" means same origin. */
  base?: string;
}

const defaultHttp = (): Http => ({ fetch: (...a) => globalThis.fetch(...a) });

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "bad_response", message: text.slice(0, 200) } };
  }
}

function toApiError(status: number, body: unknown): MhApiError {
  const b = body as { error?: { code?: string; message?: string }; code?: string; message?: string };
  const code = b?.error?.code ?? b?.code ?? `http_${status}`;
  const message = b?.error?.message ?? b?.message ?? "request failed";
  return new MhApiError(status, String(code), String(message));
}

export interface MhClient {
  estimate(body: Record<string, unknown>): Promise<MhEstimate>;
  create(params: CreateParams): Promise<MhTransfer>;
  prepare(id: number): Promise<{ transfer: MhTransfer; preparedTxs: PreparedTxs }>;
  confirmBroadcast(id: number, body: ConfirmBody): Promise<MhTransfer>;
  get(id: number): Promise<MhTransfer>;
  /** null when no transfer has that externalId. */
  byExternal(externalId: string): Promise<MhTransfer | null>;
}

export function createMhClient(http: Http = defaultHttp()): MhClient {
  const base = http.base ?? "";
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await http.fetch(`${base}/api/mh/${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      // `{}`, never an empty body: the API answers FST_ERR_CTP_EMPTY_JSON_BODY to a bodyless POST.
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = await readJson(res);
    if (!res.ok) throw toApiError(res.status, json);
    return json;
  };
  return {
    async estimate(body) {
      return (await call("POST", "transfers/estimate", body)) as MhEstimate;
    },
    async create(params) {
      const amountTokens = String(Number(params.amountRaw) / 10 ** params.tokenDecimals);
      return (await call("POST", "transfers", {
        hops: 3,
        arrivalSeconds: 120,
        amountTokens,
        ...params,
      })) as MhTransfer;
    },
    async prepare(id) {
      return (await call("POST", `transfers/${id}/prepare`, {})) as {
        transfer: MhTransfer;
        preparedTxs: PreparedTxs;
      };
    },
    async confirmBroadcast(id, body) {
      const r = (await call("POST", `transfers/${id}/confirm-broadcast`, body)) as { transfer: MhTransfer };
      return r.transfer;
    },
    async get(id) {
      return (await call("GET", `transfers/${id}`)) as MhTransfer;
    },
    async byExternal(externalId) {
      try {
        return (await call("GET", `transfers/by-external/${encodeURIComponent(externalId)}`)) as MhTransfer;
      } catch (e) {
        if (e instanceof MhApiError && e.status === 404) return null;
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Solana RPC over /api/sol

export interface Clock {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const realClock: Clock = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export interface SolRpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Base64 transaction, preflight on. Returns the signature. */
  sendTransaction(base64: string): Promise<string>;
  /** Polls until confirmed/finalized; throws TxFailedError or ConfirmTimeoutError. */
  confirm(signature: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<void>;
  getBalance(address: string): Promise<number>;
  /** Raw token units held by `owner` in `mint`, summed over accounts. */
  getTokenBalance(owner: string, mint: string): Promise<bigint>;
}

export function createSolRpc(http: Http = defaultHttp(), clock: Clock = realClock): SolRpc {
  const base = http.base ?? "";
  let nextId = 1;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await http.fetch(`${base}/api/sol`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const json = (await readJson(res)) as { result?: T; error?: { code?: number | string; message?: string } };
    if (!res.ok && !json?.error) throw toApiError(res.status, json);
    if (json?.error) {
      const code = typeof json.error.code === "number" ? json.error.code : null;
      throw new RpcError(code, String(json.error.message ?? json.error.code ?? "rpc error"));
    }
    return json.result as T;
  };
  return {
    call,
    async getLatestBlockhash() {
      const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
        "getLatestBlockhash",
        [{ commitment: "confirmed" }],
      );
      return r.value;
    },
    sendTransaction(base64) {
      return call<string>("sendTransaction", [
        base64,
        { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 },
      ]);
    },
    async confirm(signature, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const pollMs = opts.pollMs ?? 800;
      const start = clock.now();
      for (;;) {
        const r = await call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
          "getSignatureStatuses",
          [[signature], { searchTransactionHistory: true }],
        );
        const s = r.value?.[0];
        if (s?.err) throw new TxFailedError(signature, s.err);
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
        if (clock.now() - start >= timeoutMs) throw new ConfirmTimeoutError(signature);
        await clock.sleep(pollMs);
      }
    },
    async getBalance(address) {
      const r = await call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
      return r.value;
    },
    async getTokenBalance(owner, mint) {
      const r = await call<{
        value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
      }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      let sum = 0n;
      for (const a of r.value ?? []) sum += BigInt(a.account.data.parsed.info.tokenAmount.amount);
      return sum;
    },
  };
}

// ---------------------------------------------------------------------------
// Identity of a route

/** Stable id for this envelope's route: hex(SHA-256(secret || "mh-ext-v1")), 32 chars. */
export async function externalIdFor(
  secret: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const tag = new TextEncoder().encode("mh-ext-v1");
  const input = new Uint8Array(secret.length + tag.length);
  input.set(secret, 0);
  input.set(tag, secret.length);
  const digest = new Uint8Array(await subtle.digest("SHA-256", input as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Driver

export interface DriveOptions {
  mh: MhClient;
  rpc: SolRpc;
  key: RouterKey;
  clock?: Clock;
  /** Called before each transaction: step `index` of `total`, 1-based. */
  onStep?: (step: { index: number; total: number; label: string }) => void;
  /** prepare -> broadcast attempts before giving up on stale blockhashes. Default 4. */
  maxAttempts?: number;
  /** Pause after route-init and orchestrator-init, which the spike used. Default 3000. */
  settleMs?: number;
}

interface Collected {
  keeper?: string;
  routeInit: string[];
  orchestrator?: string;
  session: string[];
  dispersion: string[];
}

const isMulti = (t: MhTransfer) => (t.destinationCount ?? 0) > 0 || (t.destinations?.length ?? 0) > 0;

/**
 * Runs create's follow-up: prepare, sign, send, confirm, until MultiHopper has every
 * signature. Resumable: `prepare` only returns what is still missing, so calling this
 * again after a crash, a reload or a stale blockhash continues where it stopped.
 * Returns the transfer as the final confirm-broadcast saw it (or a fresh GET when
 * there was nothing left to do).
 */
export async function runBroadcast(transferId: number, o: DriveOptions): Promise<MhTransfer> {
  const clock = o.clock ?? realClock;
  const maxAttempts = o.maxAttempts ?? 4;
  const settle = o.settleMs ?? 3000;
  const got: Collected = { routeInit: [], session: [], dispersion: [] };
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await clock.sleep(1000);
    const { transfer, preparedTxs: p } = await o.mh.prepare(transferId);
    if (transfer.sourceOwner !== o.key.address) {
      throw new Error("this transfer belongs to a different wallet than the router");
    }
    if (p.resume?.nothingToDo) return o.mh.get(transferId);

    const keeper = p.keeperFundingTx ? [p.keeperFundingTx] : [];
    const route = p.routeInitTxs ?? [];
    const sess = p.sessionInitTxs ?? [];
    const disp = p.dispersionInitTxs ?? [];
    const total = keeper.length + route.length + (p.orchestratorInitTx ? 1 : 0) + sess.length + disp.length;
    let n = 0;
    const send = async (b64: string, label: string): Promise<string> => {
      n += 1;
      o.onStep?.({ index: n, total, label });
      const signed = await signTransaction(b64, o.key);
      if (signed.unsignedSlots.length > 0) throw new Error(`${label}: a required signature is missing`);
      const sig = await o.rpc.sendTransaction(signed.base64);
      await o.rpc.confirm(sig);
      return sig;
    };

    try {
      if (p.keeperFundingTx) {
        got.keeper = await send(p.keeperFundingTx, "keeper funding");
        // Multi-destination: this intermediate confirm answers 409 MH_041. Skip it.
        if (!isMulti(transfer)) {
          await o.mh.confirmBroadcast(transferId, {
            routeInitSignatures: [],
            keeperFundingSignature: got.keeper,
          });
        }
      }
      for (const [i, tx] of route.entries()) got.routeInit.push(await send(tx.base64, `route init ${i + 1}`));
      if (route.length > 0 && settle > 0) await clock.sleep(settle);
      if (p.orchestratorInitTx) {
        got.orchestrator = await send(p.orchestratorInitTx, "orchestrator init");
        if (settle > 0) await clock.sleep(settle);
      }
      for (const [i, tx] of sess.entries()) got.session.push(await send(tx, `session init ${i + 1}`));
      for (const [i, tx] of disp.entries()) got.dispersion.push(await send(tx, `dispersion init ${i + 1}`));

      const body: ConfirmBody = { routeInitSignatures: got.routeInit };
      if (got.keeper) body.keeperFundingSignature = got.keeper;
      if (got.orchestrator) body.orchestratorInitSignature = got.orchestrator;
      if (got.session.length) body.sessionInitSignatures = got.session;
      if (got.dispersion.length) body.dispersionInitSignatures = got.dispersion;
      return await o.mh.confirmBroadcast(transferId, body);
    } catch (e) {
      if (isBlockhashExpired(e) || isPrepareAgain(e)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("could not broadcast the route");
}

/**
 * Whole start: create (idempotent per externalId, so a reopened link gets the same
 * transfer), then broadcast.
 */
export async function startRoute(params: CreateParams, o: DriveOptions): Promise<MhTransfer> {
  const t = await o.mh.create(params);
  return runBroadcast(t.id, o);
}

// ---------------------------------------------------------------------------
// After completion: sweep what is left

/**
 * Sends the router's remaining SOL (balance minus the 5000-lamport fee) to `to`.
 * Returns the signature, or null when there is not enough to be worth sending.
 * Only call once the route is done: the router must still hold nothing MultiHopper needs.
 */
export async function sweepLeftoverSol(
  key: RouterKey,
  to: string,
  rpc: SolRpc,
): Promise<string | null> {
  const balance = await rpc.getBalance(key.address);
  const amount = balance - BASE_FEE_LAMPORTS;
  if (amount <= 0) return null;
  const { blockhash } = await rpc.getLatestBlockhash();
  const unsigned = buildTransferTransaction(key.publicKey, base58Decode(to), BigInt(amount), base58Decode(blockhash));
  const signed = await signTransaction(unsigned, key);
  const sig = await rpc.sendTransaction(signed.base64);
  await rpc.confirm(sig);
  return sig;
}
