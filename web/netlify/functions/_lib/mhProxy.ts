/**
 * Pure logic for the server-side proxies (MultiHopper and Solana RPC). No Netlify
 * imports and no `process.env` here: the two entry points (`../mh.ts`, `../sol.ts`)
 * pass the environment, `fetch` and the clock in, which is what the tests do too.
 *
 * What this code may do: forward six MultiHopper calls and seven Solana RPC methods,
 * adding the keys the page must not hold. What it may not do: see an envelope secret,
 * sign anything, or forward a field or path that is not listed below.
 */

export interface ProxyEnv {
  MH_BASE_URL?: string;
  MH_API_KEY?: string;
  MH_ALLOWED_MINTS?: string;
  SITE_ORIGINS?: string;
  SOLANA_RPC_URL?: string;
}

export interface ProxyDeps {
  env: ProxyEnv;
  /** Client address as the platform reports it; undefined when unknown. */
  ip?: string;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  limiter?: RateLimiter;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const CREATE_LIMIT = 5;
export const CREATE_WINDOW_MS = 60_000;

export const SOL_METHODS: ReadonlySet<string> = new Set([
  "getLatestBlockhash",
  "sendTransaction",
  "getSignatureStatuses",
  "getBalance",
  "getTokenAccountsByOwner",
  "getAccountInfo",
  "getMinimumBalanceForRentExemption",
]);

// externalId is the capability for a transfer: the client derives it from the envelope secret
// (SHA-256, 32 hex chars), so 32 is the floor. Shorter, guessable ids are refused everywhere.
const EXTERNAL_ID = /^[A-Za-z0-9_-]{32,64}$/;
/** Header that proves the caller knows a transfer's externalId on per-id routes. */
export const EXT_HEADER = "x-zenvelope-ext";
const NUMERIC_ID = /^[0-9]{1,18}$/;

const CREATE_FIELDS = [
  "tokenMint",
  "amountRaw",
  "amountTokens",
  "tokenDecimals",
  "tokenSymbol",
  "sourceOwner",
  "recipientWallet",
  "destinations",
  "hops",
  "arrivalSeconds",
  "externalId",
] as const;

// ---------------------------------------------------------------------------
// Responses

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  // The page is cross-origin isolated (COEP require-corp); same-origin responses
  // must say so or the browser drops them.
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

// ---------------------------------------------------------------------------
// Rate limiting

export interface RateLimiter {
  /** True when the call is allowed (and counted). */
  take(key: string, limit: number, windowMs: number, now: number): boolean;
}

/**
 * Best effort only. State lives in this function instance's memory, so it resets on a
 * cold start and is not shared between concurrent instances: it blunts one visitor
 * hammering create, it does not enforce a global budget. A shared counter (Netlify
 * Blobs or similar) would need a runtime dependency, which this phase avoids.
 */
export function memoryLimiter(): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, limit, windowMs, now) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

const sharedLimiter = memoryLimiter();

// ---------------------------------------------------------------------------
// Shared checks

/** Same-origin only. No CORS headers are ever sent, this is the server-side half. */
export function checkOrigin(req: Request, env: ProxyEnv): Response | null {
  const origin = req.headers.get("origin");
  const post = req.method !== "GET" && req.method !== "HEAD";
  if (origin === null) {
    // Browsers always send Origin on a POST; only same-origin GETs may omit it.
    return post ? errorResponse(403, "origin_required", "Origin header required") : null;
  }
  const allowed = new Set(
    (env.SITE_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* unparsable request URL: only the list applies */
  }
  if (!allowed.has(origin)) return errorResponse(403, "bad_origin", "Cross-origin requests are not allowed");
  return null;
}

type Body = { ok: true; text: string } | { ok: false; res: Response };

async function readCapped(req: Request): Promise<Body> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  const tooBig = { ok: false as const, res: errorResponse(413, "too_large", "Body too large") };
  if (declared > MAX_BODY_BYTES) return tooBig;
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return tooBig;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** Reads a size-capped JSON object body. Empty body yields `{}` when `allowEmpty`. */
async function readJsonObject(
  req: Request,
  allowEmpty: boolean,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }> {
  const body = await readCapped(req);
  if (!body.ok) return body;
  if (body.text.trim() === "") {
    return allowEmpty
      ? { ok: true, value: {} }
      : { ok: false, res: errorResponse(400, "bad_body", "JSON body required") };
  }
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, res: errorResponse(415, "bad_content_type", "Content-Type must be application/json") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, res: errorResponse(400, "bad_json", "Body is not valid JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: errorResponse(400, "bad_body", "Body must be a JSON object") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function forward(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const up = await doFetch(url, { ...init, signal: ctl.signal, redirect: "manual" });
    const type = up.headers.get("content-type") ?? "";
    if (!/^application\/(.+\+)?json/i.test(type)) {
      return errorResponse(502, "bad_upstream", "Upstream did not answer with JSON");
    }
    // Status and body unchanged; every upstream header except content-type is dropped.
    return new Response(await up.text(), {
      status: up.status,
      headers: { ...BASE_HEADERS, "Content-Type": type },
    });
  } catch (e) {
    if (ctl.signal.aborted) return errorResponse(504, "upstream_timeout", "Upstream timed out");
    void e;
    return errorResponse(502, "upstream_error", "Upstream request failed");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MultiHopper

export type MhRoute =
  | { kind: "estimate" }
  | { kind: "create" }
  | { kind: "prepare"; id: string }
  | { kind: "confirm"; id: string }
  | { kind: "get"; id: string }
  | { kind: "byExternal"; externalId: string };

/** Maps method + path (after `/api/mh/`) onto the allowlist, or null (404). */
export function matchMhRoute(method: string, rest: string): MhRoute | null {
  const parts = rest.replace(/\/+$/, "").split("/");
  if (parts[0] !== "transfers") return null;
  if (method === "POST") {
    if (parts.length === 2 && parts[1] === "estimate") return { kind: "estimate" };
    if (parts.length === 1) return { kind: "create" };
    if (parts.length === 3 && NUMERIC_ID.test(parts[1])) {
      if (parts[2] === "prepare") return { kind: "prepare", id: parts[1] };
      if (parts[2] === "confirm-broadcast") return { kind: "confirm", id: parts[1] };
    }
    return null;
  }
  if (method === "GET") {
    if (parts.length === 2 && NUMERIC_ID.test(parts[1])) return { kind: "get", id: parts[1] };
    if (parts.length === 3 && parts[1] === "by-external" && EXTERNAL_ID.test(parts[2])) {
      return { kind: "byExternal", externalId: parts[2] };
    }
  }
  return null;
}

/** Returns an error message, or null when the create/estimate body is acceptable. */
export function validateTransferBody(
  body: Record<string, unknown>,
  env: ProxyEnv,
  requireExternalId: boolean,
): string | null {
  for (const k of Object.keys(body)) {
    if (!(CREATE_FIELDS as readonly string[]).includes(k)) return `Field not allowed: ${k.slice(0, 40)}`;
  }
  const mints = (env.MH_ALLOWED_MINTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (typeof body.tokenMint !== "string" || !mints.includes(body.tokenMint)) return "tokenMint not allowed";
  if (!Number.isInteger(body.hops) || (body.hops as number) < 3 || (body.hops as number) > 5) {
    return "hops must be an integer from 3 to 5";
  }
  for (const k of ["tokenSymbol", "sourceOwner", "recipientWallet"] as const) {
    if (k in body && typeof body[k] !== "string") return `${k} must be a string`;
  }
  for (const k of ["amountRaw", "amountTokens"] as const) {
    if (k in body && typeof body[k] !== "string" && typeof body[k] !== "number") return `${k} must be a string or number`;
  }
  for (const k of ["tokenDecimals", "arrivalSeconds"] as const) {
    if (k in body && !Number.isInteger(body[k])) return `${k} must be an integer`;
  }
  if ("destinations" in body) {
    const d = body.destinations;
    if (!Array.isArray(d) || d.length < 1 || d.length > 20) return "destinations must have 1 to 20 items";
    for (const item of d) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "bad destination";
      const keys = Object.keys(item);
      if (keys.some((k) => k !== "wallet" && k !== "amountRaw")) return "bad destination field";
      const it = item as Record<string, unknown>;
      if (typeof it.wallet !== "string") return "destination wallet must be a string";
      if (typeof it.amountRaw !== "string" && typeof it.amountRaw !== "number") return "destination amountRaw invalid";
    }
  }
  if ("externalId" in body && (typeof body.externalId !== "string" || !EXTERNAL_ID.test(body.externalId))) {
    return "externalId must match [A-Za-z0-9_-]{1,64}";
  }
  if (requireExternalId && !("externalId" in body)) return "externalId required";
  return null;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create is idempotent per externalId upstream; the key says the same thing. */
export async function createIdempotencyKey(externalId: string): Promise<string> {
  // MultiHopper accepts 8-64 chars of [a-zA-Z0-9._-] (MH_070, measured): "zv-create-" + 48 hex = 58.
  return `zv-create-${(await sha256Hex(externalId)).slice(0, 48)}`;
}

/** Null when the transfer found by externalId has this numeric id; otherwise the error response. */
async function ownerCheck(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  id: string,
): Promise<Response | null> {
  const res = await forward(doFetch, url, { method: "GET", headers });
  if (!res.ok) return errorResponse(403, "capability_mismatch", "Transfer capability does not match");
  let found: unknown;
  try {
    const j = (await res.json()) as Record<string, unknown>;
    found = (j.transfer as Record<string, unknown> | undefined)?.id ?? j.id;
  } catch {
    return errorResponse(502, "bad_upstream", "Upstream did not answer with JSON");
  }
  return String(found) === id ? null : errorResponse(403, "capability_mismatch", "Transfer capability does not match");
}

export async function handleMh(req: Request, deps: ProxyDeps): Promise<Response> {
  const { env } = deps;
  const bad = checkOrigin(req, env);
  if (bad) return bad;

  const url = new URL(req.url);
  const prefix = "/api/mh/";
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  const route = matchMhRoute(req.method, rest);
  if (!route) return errorResponse(404, "not_found", "Not found");

  const base = (env.MH_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.MH_API_KEY) return errorResponse(503, "not_configured", "Proxy not configured");

  const headers: Record<string, string> = { "x-api-key": env.MH_API_KEY, accept: "application/json" };
  const api = `${base}/api/v1`;
  let target: string;
  let init: RequestInit;

  // Per-id routes are gated on the externalId capability: without it anyone could walk the
  // numeric ids and read every transfer of this integration (wallets, amounts, timing).
  if (route.kind === "get" || route.kind === "prepare" || route.kind === "confirm") {
    const ext = req.headers.get(EXT_HEADER) ?? "";
    if (!EXTERNAL_ID.test(ext)) return errorResponse(403, "capability_required", "Transfer capability required");
    const owner = await ownerCheck(deps.fetch ?? fetch, `${api}/transfers/by-external/${ext}`, headers, route.id);
    if (owner) return owner;
  }

  if (route.kind === "get" || route.kind === "byExternal") {
    target =
      route.kind === "get"
        ? `${api}/transfers/${route.id}`
        : `${api}/transfers/by-external/${route.externalId}`;
    init = { method: "GET", headers };
  } else {
    const parsed = await readJsonObject(req, route.kind === "prepare" || route.kind === "confirm");
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;
    const fresh = (deps.uuid ?? (() => crypto.randomUUID()))();
    let key = fresh;
    if (route.kind === "estimate" || route.kind === "create") {
      const problem = validateTransferBody(body, env, route.kind === "create");
      if (problem) return errorResponse(400, "bad_request", problem);
    }
    if (route.kind === "create") {
      const limiter = deps.limiter ?? sharedLimiter;
      const now = (deps.now ?? Date.now)();
      if (!limiter.take(deps.ip ?? "unknown", CREATE_LIMIT, CREATE_WINDOW_MS, now)) {
        const res = errorResponse(429, "rate_limited", "Too many transfers; try again in a minute");
        res.headers.set("Retry-After", "60");
        return res;
      }
      key = await createIdempotencyKey(body.externalId as string);
    }
    target =
      route.kind === "estimate"
        ? `${api}/transfers/estimate`
        : route.kind === "create"
          ? `${api}/transfers`
          : route.kind === "prepare"
            ? `${api}/transfers/${route.id}/prepare`
            : `${api}/transfers/${route.id}/confirm-broadcast`;
    init = {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    };
  }
  return forward(deps.fetch ?? fetch, target, init);
}

// ---------------------------------------------------------------------------
// Solana RPC relay

export async function handleSol(req: Request, deps: ProxyDeps): Promise<Response> {
  const { env } = deps;
  const bad = checkOrigin(req, env);
  if (bad) return bad;
  if (req.method !== "POST") return errorResponse(404, "not_found", "Not found");
  if (!env.SOLANA_RPC_URL) return errorResponse(503, "not_configured", "Proxy not configured");

  const parsed = await readJsonObject(req, false);
  if (!parsed.ok) return parsed.res; // arrays (batches) land here as 400
  const b = parsed.value;
  if (typeof b.method !== "string" || !SOL_METHODS.has(b.method)) {
    return errorResponse(403, "method_not_allowed", "RPC method not allowed");
  }
  if (b.params !== undefined && !Array.isArray(b.params)) return errorResponse(400, "bad_request", "params must be an array");
  const id = b.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return errorResponse(400, "bad_request", "id must be a string, number or null");
  }
  const rpc = { jsonrpc: "2.0", id, method: b.method, params: b.params ?? [] };
  return forward(deps.fetch ?? fetch, env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(rpc),
  });
}
