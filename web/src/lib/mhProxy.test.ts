import { describe, expect, it, vi } from "vitest";
import {
  checkOrigin,
  createIdempotencyKey,
  handleMh,
  handleSol,
  matchMhRoute,
  memoryLimiter,
  validateTransferBody,
  type ProxyEnv,
} from "../../netlify/functions/_lib/mhProxy.ts";

const ORIGIN = "https://site.example";
const WSOL = "So11111111111111111111111111111111111111112";
const env: ProxyEnv = {
  MH_BASE_URL: "https://mh.example/",
  MH_API_KEY: "test-key",
  MH_ALLOWED_MINTS: `${WSOL}, UsdcMint1111`,
  SITE_ORIGINS: "https://other.example",
  SOLANA_RPC_URL: "https://rpc.example/?k=1",
};
const EXT = "e".repeat(32);
const goodBody = { tokenMint: WSOL, amountRaw: "100", sourceOwner: "a", recipientWallet: "b", hops: 3, externalId: EXT };

function upstream(status = 200, body: unknown = { ok: true }, type = "application/json") {
  return vi.fn(async (_u: string, _i?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": type, "set-cookie": "x=1", "x-secret": "s" } }),
  );
}
function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { origin: ORIGIN, "x-zenvelope-ext": EXT, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] ??= "application/json";
  }
  return new Request(`${ORIGIN}${path}`, init);
}
/** Answers by-external lookups as if `EXT` owned transfer `id`, and passes everything else to `f`. */
function withOwner<F extends (u: string, i?: RequestInit) => Promise<Response>>(f: F, id: number) {
  return vi.fn(async (u: string, i?: RequestInit) =>
    u.includes("/by-external/")
      ? new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } })
      : f(u, i),
  );
}
const call = (r: Request, f = upstream(), extra = {}) => handleMh(r, { env, fetch: f as never, ...extra });

describe("matchMhRoute", () => {
  it("allows exactly the six routes", () => {
    expect(matchMhRoute("POST", "transfers/estimate")).toEqual({ kind: "estimate" });
    expect(matchMhRoute("POST", "transfers")).toEqual({ kind: "create" });
    expect(matchMhRoute("POST", "transfers/12/prepare")).toEqual({ kind: "prepare", id: "12" });
    expect(matchMhRoute("POST", "transfers/12/confirm-broadcast")).toEqual({ kind: "confirm", id: "12" });
    expect(matchMhRoute("GET", "transfers/12")).toEqual({ kind: "get", id: "12" });
    expect(matchMhRoute("GET", "transfers/by-external/" + EXT)).toEqual({ kind: "byExternal", externalId: EXT });
  });
  it("rejects everything else", () => {
    for (const [m, p] of [
      ["GET", "transfers"],
      ["GET", "transfers/estimate"],
      ["POST", "transfers/abc/prepare"],
      ["POST", "transfers/1/rescue/prepare"],
      ["POST", "transfers/1/reclaim-rent/prepare"],
      ["GET", "transfers/1/prepare"],
      ["GET", "transfers/by-external/a.b"],
      ["GET", "transfers/by-external/short_guessable_id"],
      ["GET", "transfers/by-external/" + "a".repeat(65)],
      ["GET", "transfers/1/../2"],
      ["GET", "usage"],
      ["GET", "webhooks"],
      ["DELETE", "transfers/1"],
      ["PUT", "transfers"],
    ] as const) {
      expect(matchMhRoute(m, p), `${m} ${p}`).toBeNull();
    }
  });
});

describe("validateTransferBody", () => {
  it("accepts a good body", () => expect(validateTransferBody(goodBody, env, true)).toBeNull());
  it("rejects unknown fields, mints, hops", () => {
    expect(validateTransferBody({ ...goodBody, webhookUrl: "x" }, env, true)).toMatch(/not allowed/);
    expect(validateTransferBody({ ...goodBody, tokenMint: "Evil" }, env, true)).toMatch(/tokenMint/);
    expect(validateTransferBody({ ...goodBody, hops: 2 }, env, true)).toMatch(/hops/);
    expect(validateTransferBody({ ...goodBody, hops: 6 }, env, true)).toMatch(/hops/);
    expect(validateTransferBody({ ...goodBody, hops: "3" }, env, true)).toMatch(/hops/);
    expect(validateTransferBody({ ...goodBody, externalId: "a b" }, env, true)).toMatch(/externalId/);
  });
  it("needs externalId on create only, and an empty mint list allows nothing", () => {
    const { externalId: _e, ...rest } = goodBody;
    expect(validateTransferBody(rest, env, true)).toMatch(/externalId/);
    expect(validateTransferBody(rest, env, false)).toBeNull();
    expect(validateTransferBody(goodBody, {}, true)).toMatch(/tokenMint/);
  });
  it("checks destinations shape", () => {
    expect(validateTransferBody({ ...goodBody, destinations: [{ wallet: "w", amountRaw: "1" }] }, env, true)).toBeNull();
    expect(validateTransferBody({ ...goodBody, destinations: [{ wallet: "w", amountRaw: "1", x: 1 }] }, env, true)).toBeTruthy();
    expect(validateTransferBody({ ...goodBody, destinations: [] }, env, true)).toBeTruthy();
  });
});

describe("origin", () => {
  it("allows own and listed origins, absent on GET", () => {
    expect(checkOrigin(req("GET", "/api/mh/transfers/1"), env)).toBeNull();
    expect(checkOrigin(req("GET", "/api/mh/transfers/1", undefined, { origin: "https://other.example" }), env)).toBeNull();
    const noOrigin = new Request(`${ORIGIN}/api/mh/transfers/1`);
    expect(checkOrigin(noOrigin, env)).toBeNull();
  });
  it("rejects foreign origins and origin-less POSTs", async () => {
    expect(checkOrigin(req("GET", "/x", undefined, { origin: "https://evil.example" }), env)?.status).toBe(403);
    const post = new Request(`${ORIGIN}/api/mh/transfers`, { method: "POST", body: "{}" });
    expect(checkOrigin(post, env)?.status).toBe(403);
  });
});

describe("handleMh", () => {
  it("proxies GET with the key and strips upstream headers", async () => {
    const f = upstream(200, { id: 5 });
    const res = await call(req("GET", "/api/mh/transfers/5?x=1"), withOwner(f, 5));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 5 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://mh.example/api/v1/transfers/5");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("passes upstream error status and body unchanged", async () => {
    const res = await call(req("GET", "/api/mh/transfers/5"), withOwner(upstream(409, { code: "MH_035" }), 5));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "MH_035" });
  });
  it("create uses a deterministic idempotency key from externalId", async () => {
    const f1 = upstream();
    const f2 = upstream();
    await call(req("POST", "/api/mh/transfers", goodBody), f1, { limiter: memoryLimiter() });
    await call(req("POST", "/api/mh/transfers", goodBody), f2, { limiter: memoryLimiter() });
    const k = (f: typeof f1) => (f.mock.calls[0][1]!.headers as Record<string, string>)["idempotency-key"];
    expect(k(f1)).toBe(k(f2));
    expect(k(f1)).toBe(await createIdempotencyKey(EXT));
    expect(await createIdempotencyKey("ext_2")).not.toBe(k(f1));
    // MultiHopper's rule for the header (MH_070 on the live API): 8-64 chars of [a-zA-Z0-9._-].
    expect(k(f1)).toMatch(/^[a-zA-Z0-9._-]{8,64}$/);
  });
  it("prepare and confirm use fresh keys and send {} for an empty body", async () => {
    const f = upstream();
    let n = 0;
    const uuid = () => `u${++n}`;
    await call(req("POST", "/api/mh/transfers/7/prepare"), withOwner(f, 7), { uuid });
    await call(req("POST", "/api/mh/transfers/7/confirm-broadcast", { signatures: ["s"] }), withOwner(f, 7), { uuid });
    const h = (i: number) => f.mock.calls[i][1]!.headers as Record<string, string>;
    expect(f.mock.calls[0][1]!.body).toBe("{}");
    expect(f.mock.calls[0][0]).toBe("https://mh.example/api/v1/transfers/7/prepare");
    expect(h(0)["idempotency-key"]).toBe("u1");
    expect(h(1)["idempotency-key"]).toBe("u2");
    expect(f.mock.calls[1][1]!.body).toBe('{"signatures":["s"]}');
  });
  it("404s off-list paths without calling upstream", async () => {
    const f = upstream();
    expect((await call(req("GET", "/api/mh/usage"), f)).status).toBe(404);
    expect((await call(req("POST", "/api/mh/transfers/1/rescue/prepare", {}), f)).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects bad content type, bad json, oversize, bad shape", async () => {
    const f = upstream();
    const lim = { limiter: memoryLimiter() };
    expect((await call(req("POST", "/api/mh/transfers", JSON.stringify(goodBody), { "content-type": "text/plain" }), f, lim)).status).toBe(415);
    expect((await call(req("POST", "/api/mh/transfers", "{nope"), f, lim)).status).toBe(400);
    expect((await call(req("POST", "/api/mh/transfers", { ...goodBody, pad: "x".repeat(70_000) }), f, lim)).status).toBe(413);
    expect((await call(req("POST", "/api/mh/transfers", { ...goodBody, tokenMint: "Evil" }), f, lim)).status).toBe(400);
    expect((await call(req("POST", "/api/mh/transfers", [1]), f, lim)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects a cross-origin request before anything else", async () => {
    const f = upstream();
    const res = await call(req("GET", "/api/mh/transfers/1", undefined, { origin: "https://evil.example" }), f);
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
  it("rate-limits create per IP, 5 a minute", async () => {
    const limiter = memoryLimiter();
    let t = 0;
    const run = (ip: string) => call(req("POST", "/api/mh/transfers", goodBody), upstream(), { limiter, ip, now: () => t });
    for (let i = 0; i < 5; i++) expect((await run("1.1.1.1")).status).toBe(200);
    expect((await run("1.1.1.1")).status).toBe(429);
    expect((await run("2.2.2.2")).status).toBe(200);
    t = 61_000;
    expect((await run("1.1.1.1")).status).toBe(200);
  });
  it("maps a timeout to 504 and a non-JSON upstream to 502", async () => {
    vi.useFakeTimers();
    const hang = vi.fn((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    const p = call(req("GET", "/api/mh/transfers/1"), withOwner(hang, 1) as never);
    await vi.advanceTimersByTimeAsync(20_001);
    const res = await p;
    vi.useRealTimers();
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
    expect((await call(req("GET", "/api/mh/transfers/1"), withOwner(upstream(200, "x", "text/html"), 1))).status).toBe(502);
  });
  it("refuses per-id routes without the externalId capability", async () => {
    const f = upstream(200, { id: 9 });
    const noCap = await call(req("GET", "/api/mh/transfers/9", undefined, { "x-zenvelope-ext": "" }), f);
    expect(noCap.status).toBe(403);
    const short = await call(req("POST", "/api/mh/transfers/9/prepare", undefined, { "x-zenvelope-ext": "abc" }), f);
    expect(short.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
  it("refuses a capability that belongs to another transfer, without forwarding", async () => {
    const target = upstream(200, { id: 9 });
    const f = withOwner(target, 8);
    for (const r of [
      req("GET", "/api/mh/transfers/9"),
      req("POST", "/api/mh/transfers/9/prepare"),
      req("POST", "/api/mh/transfers/9/confirm-broadcast", { s: 1 }),
    ]) {
      const res = await call(r, f);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("capability_mismatch");
    }
    expect(target).not.toHaveBeenCalled();
  });
  it("503s when unconfigured", async () => {
    const res = await handleMh(req("GET", "/api/mh/transfers/1"), { env: {}, fetch: upstream() as never });
    expect(res.status).toBe(503);
  });
});

describe("handleSol", () => {
  const rpc = (b: unknown, headers = {}) => handleSol(req("POST", "/api/sol", b, headers), { env, fetch: sf as never });
  const sf = upstream(200, { jsonrpc: "2.0", id: 1, result: 1 });
  it("relays an allowed method with only the known fields", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["a"], extra: 1 });
    expect(res.status).toBe(200);
    const [url, init] = sf.mock.calls[0];
    expect(url).toBe("https://rpc.example/?k=1");
    expect(JSON.parse(init!.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["a"] });
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
  it("blocks other methods, batches and non-POST", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] })).status).toBe(403);
    expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "getBalance" }])).status).toBe(400);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: {} })).status).toBe(400);
    expect((await handleSol(req("GET", "/api/sol"), { env })).status).toBe(404);
    expect((await handleSol(req("POST", "/api/sol", {}, { origin: "https://evil.example" }), { env })).status).toBe(403);
  });
});
