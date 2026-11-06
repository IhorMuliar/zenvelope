import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import create from "./__fixtures__/mh-create-sol.json";
import byExternal from "./__fixtures__/mh-by-external-sol.json";
import prepareSol from "./__fixtures__/mh-prepare-sol.json";
import vectors from "./__fixtures__/soltx-vectors.json";
import {
  ConfirmTimeoutError,
  MhApiError,
  createMhClient,
  createSolRpc,
  externalIdFor,
  isBlockhashExpired,
  runBroadcast,
  startRoute,
  sweepLeftoverSol,
  type Clock,
  type PreparedTxs,
} from "./multihop";
import { routerKeyFromSeed, type RouterKey } from "./router";
import { base58Decode } from "./solana";
import { base64ToBytes, buildTransferTransaction, signTransaction } from "./soltx";

const seed = Uint8Array.from(Buffer.from(vectors.seedHex, "hex"));
const T = vectors.txs;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mhErr = (status: number, code: string) => json(status, { error: { code, message: code } });

const fastClock = (): Clock & { t: number } => {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
};

const fullPrepared = (over: Partial<PreparedTxs> = {}): PreparedTxs => ({
  keeperFundingTx: T.keeper.patched,
  routeInitTxs: [{ base64: T.route0.patched }, { base64: T.route1.patched }],
  orchestratorInitTx: T.orch.patched,
  sessionInitTxs: [T.session0.patched],
  dispersionInitTxs: [],
  resume: { nothingToDo: false },
  ...over,
});

interface World {
  fetch: typeof fetch;
  log: string[];
  confirms: Record<string, unknown>[];
  sent: string[];
  prepared: (() => PreparedTxs)[];
  sendFailures: Set<number>;
  confirmResponses: (Response | null)[];
  transfer: Record<string, unknown>;
}

function world(key: RouterKey, transfer: Record<string, unknown> = {}): World {
  const w: World = {
    log: [],
    confirms: [],
    sent: [],
    prepared: [],
    sendFailures: new Set(),
    confirmResponses: [],
    transfer: { ...create, sourceOwner: key.address, ...transfer },
    fetch: undefined as unknown as typeof fetch,
  };
  let sendCount = 0;
  w.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url === "/api/sol") {
      w.log.push(body.method);
      if (body.method === "sendTransaction") {
        sendCount += 1;
        if (w.sendFailures.has(sendCount)) {
          return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Blockhash not found" } });
        }
        w.sent.push(body.params[0]);
        const bytes = base64ToBytes(body.params[0]);
        return json(200, { jsonrpc: "2.0", id: body.id, result: `sig${w.sent.length}-${bytes.length}` });
      }
      if (body.method === "getSignatureStatuses") {
        return json(200, { jsonrpc: "2.0", id: body.id, result: { value: [{ err: null, confirmationStatus: "confirmed" }] } });
      }
      throw new Error(`unexpected rpc ${body.method}`);
    }
    const path = url.replace("/api/mh/", "");
    w.log.push(`${init?.method} ${path}`);
    if (path.endsWith("/prepare")) {
      expect(body).toEqual({});
      const next = w.prepared.shift();
      if (!next) throw new Error("no more prepare responses");
      return json(200, { transfer: w.transfer, preparedTxs: next() });
    }
    if (path.endsWith("/confirm-broadcast")) {
      w.confirms.push(body);
      const forced = w.confirmResponses.shift();
      return forced ?? json(200, { transfer: { ...w.transfer, status: "active" } });
    }
    if (path === "transfers") return json(200, w.transfer);
    throw new Error(`unexpected ${path}`);
  }) as unknown as typeof fetch;
  return w;
}

async function setup(transfer: Record<string, unknown> = {}) {
  const key = await routerKeyFromSeed(seed);
  const w = world(key, transfer);
  const clock = fastClock();
  const opts = {
    mh: createMhClient({ fetch: w.fetch }),
    rpc: createSolRpc({ fetch: w.fetch }, clock),
    key,
    clock,
  };
  return { key, w, opts, clock };
}

const seq = (w: World) => w.log.filter((l) => l !== "getSignatureStatuses");

describe("runBroadcast: the measured sequence", () => {
  it("sends keeper, confirms, then route, orchestrator, session in order, then confirms all", async () => {
    const { w, opts } = await setup();
    w.prepared.push(() => fullPrepared());
    const steps: string[] = [];
    const out = await runBroadcast(1583, { ...opts, onStep: (s) => steps.push(`${s.index}/${s.total}`) });
    expect(out.status).toBe("active");
    expect(seq(w)).toEqual([
      "POST transfers/1583/prepare",
      "sendTransaction",
      "POST transfers/1583/confirm-broadcast",
      "sendTransaction",
      "sendTransaction",
      "sendTransaction",
      "sendTransaction",
      "POST transfers/1583/confirm-broadcast",
    ]);
    expect(steps).toEqual(["1/5", "2/5", "3/5", "4/5", "5/5"]);
    // The txs sent were signed and carried the pre-signature through.
    expect(w.sent[1]).toBe((await signTransaction(T.route0.patched, await routerKeyFromSeed(seed))).base64);
    expect(w.confirms[0]).toEqual({ routeInitSignatures: [], keeperFundingSignature: "sig1-" + base64ToBytes(w.sent[0]).length });
    const fin = w.confirms[1] as Record<string, string[]>;
    expect(fin.routeInitSignatures).toHaveLength(2);
    expect(fin.sessionInitSignatures).toHaveLength(1);
    expect(fin.keeperFundingSignature).toBeDefined();
    expect(fin.orchestratorInitSignature).toBeDefined();
    expect(fin.dispersionInitSignatures).toBeUndefined();
  });

  it("each tx is confirmed before the next is sent", async () => {
    const { w, opts } = await setup();
    w.prepared.push(() => fullPrepared());
    await runBroadcast(1583, opts);
    const rpc = w.log.filter((l) => l === "sendTransaction" || l === "getSignatureStatuses");
    for (let i = 0; i < rpc.length; i += 2) expect(rpc.slice(i, i + 2)).toEqual(["sendTransaction", "getSignatureStatuses"]);
  });

  it("resumes after a partial broadcast: sends only what prepare still returns", async () => {
    const { w, opts } = await setup();
    w.prepared.push(() =>
      fullPrepared({
        keeperFundingTx: null,
        routeInitTxs: [],
        orchestratorInitTx: null,
        resume: { keeperAlreadyFunded: true },
      }),
    );
    await runBroadcast(1583, opts);
    expect(w.sent).toHaveLength(1);
    expect(w.confirms).toHaveLength(1);
    expect(w.confirms[0]).toEqual({ routeInitSignatures: [], sessionInitSignatures: [expect.any(String)] });
  });

  it("does nothing but read when prepare says nothingToDo", async () => {
    const { w, opts } = await setup();
    w.prepared.push(() => ({ ...fullPrepared(), keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [], resume: { nothingToDo: true } }));
    const fetchGet = opts.mh.get;
    opts.mh.get = async (id) => ({ ...(await fetchGet.call(opts.mh, id).catch(() => ({}))), id, status: "active" } as never);
    const out = await runBroadcast(1583, opts);
    expect(out.status).toBe("active");
    expect(w.sent).toHaveLength(0);
  });

  it("on a blockhash-expired send, prepares again and keeps earlier signatures", async () => {
    const { w, opts } = await setup();
    w.sendFailures.add(2); // route init 1 fails the first time
    w.prepared.push(() => fullPrepared());
    w.prepared.push(() => fullPrepared({ keeperFundingTx: null, resume: { keeperAlreadyFunded: true } }));
    await runBroadcast(1583, opts);
    expect(seq(w).filter((l) => l.endsWith("/prepare"))).toHaveLength(2);
    const fin = w.confirms.at(-1) as Record<string, unknown>;
    expect(fin.keeperFundingSignature).toBeDefined(); // from attempt 1
    expect(fin.routeInitSignatures).toHaveLength(2);
  });

  it("treats an unconfirmed (timed out) tx as stale and re-prepares", async () => {
    const { key, w, clock } = await setup();
    let polls = 0;
    const real = w.fetch;
    const fetchStuck = (async (url: string, init?: RequestInit) => {
      const b = init?.body ? JSON.parse(init.body as string) : null;
      if (url === "/api/sol" && b.method === "getSignatureStatuses" && polls++ < 200 && polls > 0 && w.sent.length === 1 && w.log.filter((l) => l.endsWith("/prepare")).length === 1) {
        return json(200, { jsonrpc: "2.0", id: b.id, result: { value: [null] } });
      }
      return real(url as never, init);
    }) as unknown as typeof fetch;
    w.prepared.push(() => fullPrepared({ routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }));
    w.prepared.push(() => fullPrepared({ keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }));
    const out = await runBroadcast(1583, {
      mh: createMhClient({ fetch: fetchStuck }),
      rpc: createSolRpc({ fetch: fetchStuck }, clock),
      key,
      clock,
    });
    expect(out.status).toBe("active");
    expect(w.log.filter((l) => l.endsWith("/prepare"))).toHaveLength(2);
  });

  it("gives up after maxAttempts of stale blockhashes", async () => {
    const { w, opts } = await setup();
    for (let i = 1; i <= 10; i += 1) w.sendFailures.add(i);
    for (let i = 0; i < 3; i += 1) w.prepared.push(() => fullPrepared());
    await expect(runBroadcast(1583, { ...opts, maxAttempts: 3 })).rejects.toThrow(/Blockhash/);
  });

  it("refuses a transfer owned by another wallet", async () => {
    const { w, opts } = await setup({ sourceOwner: "11111111111111111111111111111111" });
    w.prepared.push(() => fullPrepared());
    await expect(runBroadcast(1583, opts)).rejects.toThrow(/different wallet/);
    expect(w.sent).toHaveLength(0);
  });

  it("multi-destination: no intermediate confirm, dispersion sigs in their own field", async () => {
    const { w, opts } = await setup({ destinationCount: 2 });
    w.prepared.push(() => fullPrepared({ sessionInitTxs: [T.session0.patched], dispersionInitTxs: [T.dispersion0.patched] }));
    await runBroadcast(1583, opts);
    expect(w.confirms).toHaveLength(1);
    const fin = w.confirms[0] as Record<string, string[]>;
    expect(fin.dispersionInitSignatures).toHaveLength(1);
    expect(fin.sessionInitSignatures).toHaveLength(1);
    expect(fin.keeperFundingSignature).toBeDefined();
  });

  it("MH_041 on confirm means prepare again and send what it still returns", async () => {
    const { w, opts } = await setup();
    w.confirmResponses.push(mhErr(409, "MH_041")); // the intermediate keeper confirm
    w.prepared.push(() => fullPrepared());
    w.prepared.push(() =>
      fullPrepared({ keeperFundingTx: null, resume: { keeperAlreadyFunded: true } }),
    );
    const out = await runBroadcast(1583, opts);
    expect(out.status).toBe("active");
    expect(w.sent).toHaveLength(5); // keeper once, then the other four
    expect((w.confirms.at(-1) as Record<string, unknown>).keeperFundingSignature).toBeDefined();
  });

  it("surfaces other API errors", async () => {
    const { w, opts } = await setup();
    w.confirmResponses.push(mhErr(400, "MH_999"));
    w.prepared.push(() => fullPrepared());
    await expect(runBroadcast(1583, opts)).rejects.toBeInstanceOf(MhApiError);
  });
});

describe("startRoute", () => {
  it("creates, then prepares", async () => {
    const { w, opts } = await setup();
    w.prepared.push(() => fullPrepared());
    await startRoute(
      { tokenMint: "m", tokenDecimals: 9, amountRaw: "300000000", sourceOwner: opts.key.address, recipientWallet: "r", externalId: "e" },
      opts,
    );
    expect(seq(w)[0]).toBe("POST transfers");
    expect(seq(w)[1]).toBe("POST transfers/1583/prepare");
  });
});

describe("client", () => {
  it("handles flat vs wrapped shapes and 404 by-external", async () => {
    const f = (async (url: string) =>
      url.endsWith("/missing") ? mhErr(404, "MH_404") : json(200, byExternal)) as unknown as typeof fetch;
    const mh = createMhClient({ fetch: f });
    expect((await mh.byExternal("abc"))?.id).toBe(1583);
    expect(await mh.byExternal("missing")).toBeNull();
  });
  it("create adds defaults and amountTokens", async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return json(200, create);
    }) as unknown as typeof fetch;
    await createMhClient({ fetch: f }).create({ tokenMint: "m", tokenDecimals: 9, amountRaw: "300000000", sourceOwner: "s", recipientWallet: "r", externalId: "e" });
    expect(sent).toMatchObject({ hops: 3, arrivalSeconds: 120, amountTokens: "0.3" });
  });
  it("sends {} for bodyless POST and maps API errors", async () => {
    let body: unknown;
    const f = (async (_u: string, init: RequestInit) => {
      body = init.body;
      return mhErr(409, "MH_082");
    }) as unknown as typeof fetch;
    await expect(createMhClient({ fetch: f }).prepare(1)).rejects.toMatchObject({ code: "MH_082", status: 409 });
    expect(body).toBe("{}");
  });
  it("keeps the prepare fixture shape we rely on", () => {
    expect(prepareSol.preparedTxs.routeInitTxs[0].base64).toBeTypeOf("string");
  });
});

describe("rpc", () => {
  it("sums token accounts", async () => {
    const f = (async () =>
      json(200, {
        result: { value: [1, 2].map((n) => ({ account: { data: { parsed: { info: { tokenAmount: { amount: String(n * 1_000_000) } } } } } })) },
      })) as unknown as typeof fetch;
    expect(await createSolRpc({ fetch: f }).getTokenBalance("o", "m")).toBe(3_000_000n);
  });
  it("throws on tx error and on timeout", async () => {
    const failing = (async () => json(200, { result: { value: [{ err: { InstructionError: [0, "x"] } }] } })) as unknown as typeof fetch;
    await expect(createSolRpc({ fetch: failing }).confirm("s")).rejects.toThrow(/failed/);
    const none = (async () => json(200, { result: { value: [null] } })) as unknown as typeof fetch;
    const c = fastClock();
    await expect(createSolRpc({ fetch: none }, c).confirm("s", { timeoutMs: 5000 })).rejects.toBeInstanceOf(ConfirmTimeoutError);
  });
  it("classifies expiry", () => {
    expect(isBlockhashExpired(new Error("x"))).toBe(false);
  });
});

describe("externalIdFor", () => {
  it("is the first 32 hex chars of SHA-256(secret || mh-ext-v1)", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
    const expected = createHash("sha256").update(secret).update("mh-ext-v1").digest("hex").slice(0, 32);
    expect(await externalIdFor(secret)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("sweepLeftoverSol", () => {
  const to = vectors.transfer.to;
  async function run(balance: number) {
    const key = await routerKeyFromSeed(seed);
    const sent: string[] = [];
    const bh = vectors.transfer.blockhash;
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      switch (b.method) {
        case "getBalance":
          return json(200, { result: { value: balance } });
        case "getLatestBlockhash":
          return json(200, { result: { value: { blockhash: bh, lastValidBlockHeight: 1 } } });
        case "sendTransaction":
          sent.push(b.params[0]);
          return json(200, { result: "txsig" });
        default:
          return json(200, { result: { value: [{ err: null, confirmationStatus: "finalized" }] } });
      }
    }) as unknown as typeof fetch;
    const sig = await sweepLeftoverSol(key, to, createSolRpc({ fetch: f }, fastClock()));
    return { sig, sent, key, bh };
  }
  it("sends balance minus the 5000 fee", async () => {
    const { sig, sent, key, bh } = await run(1_000_000);
    expect(sig).toBe("txsig");
    const expected = await signTransaction(buildTransferTransaction(key.publicKey, base58Decode(to), 995_000n, base58Decode(bh)), key);
    expect(sent).toEqual([expected.base64]);
  });
  it("sends nothing when the balance cannot cover the fee", async () => {
    expect((await run(5000)).sent).toEqual([]);
    expect((await run(0)).sig).toBeNull();
  });
});
