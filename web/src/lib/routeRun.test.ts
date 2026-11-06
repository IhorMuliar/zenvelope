import { describe, expect, it } from "vitest";
import byExternal from "./__fixtures__/mh-by-external-sol.json";
import polls from "./__fixtures__/mh-polls-sol.json";
import estimateSol from "./__fixtures__/mh-estimate-sol.json";
import vectors from "./__fixtures__/soltx-vectors.json";
import { WSOL_MINT, usdcMint } from "./cluster";
import type { Clock, MhClient, MhEstimate, MhTransfer, SolRpc } from "./multihop";
import type { MhEvent } from "./multihopFlow";
import { holdsFunds, inferAsset, planRoute, runRoute, type RunEnv, type RunInfo } from "./routeRun";
import { routerKeyFromSeed } from "./router";
import { base64ToBytes, parseTransaction } from "./soltx";

const seed = Uint8Array.from(Buffer.from(vectors.seedHex, "hex"));
const est = estimateSol as unknown as MhEstimate;
const done = byExternal as unknown as MhTransfer;
const active = polls[0] as unknown as MhTransfer;
const RECIPIENT = vectors.transfer.to;

const clock: Clock = { now: () => 0, sleep: async () => {} };

function fakeRpc(opts: { lamports: number; tokens?: { pubkey: string; amount: bigint }[] }) {
  const sent: string[] = [];
  const rpc: SolRpc = {
    call: async () => {
      throw new Error("unused");
    },
    getLatestBlockhash: async () => ({ blockhash: vectors.transfer.blockhash, lastValidBlockHeight: 1 }),
    sendTransaction: async (b64) => {
      sent.push(b64);
      return `sig${sent.length}`;
    },
    confirm: async () => {},
    getBalance: async (a) => (a === RECIPIENT ? 1_000_000_000 : opts.lamports),
    getTokenBalance: async () => (opts.tokens ?? []).reduce((s, t) => s + t.amount, 0n),
    getTokenAccounts: async () =>
      (opts.tokens ?? []).map((t) => ({
        pubkey: t.pubkey,
        program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        amount: t.amount,
        decimals: 6,
      })),
  };
  return { rpc, sent };
}

async function env(over: Partial<Omit<RunEnv, "mh">> & { rpc: SolRpc; mh: Partial<MhClient> }) {
  const key = await routerKeyFromSeed(seed);
  const events: MhEvent[] = [];
  const infos: RunInfo[] = [];
  const e: RunEnv = {
    key,
    externalId: "e".repeat(32),
    clock,
    pollMs: 10,
    alive: () => true,
    emit: (ev) => events.push(ev),
    info: (p) => infos.push(p),
    recipient: () => RECIPIENT,
    asset: null,
    ...over,
    mh: over.mh as MhClient,
  };
  return { e, events, infos, key };
}

describe("planRoute", () => {
  const mh = { estimate: async () => est } as unknown as MhClient;
  it("routes the whole USDC balance and needs the SOL floor", async () => {
    const plan = await planRoute("usdc", { lamports: 0, tokenRaw: 25_000_000n }, mh);
    expect(plan?.amountRaw).toBe(25_000_000n);
    expect(plan?.needs).toEqual({ lamports: est.sol.requiredSolUpFrontLamports + 150_000, tokenRaw: 25_000_000n });
  });
  it("waits (null) for USDC that has not arrived", async () => {
    expect(await planRoute("usdc", { lamports: 9e9, tokenRaw: 0n }, mh)).toBeNull();
  });
  it("routes a SOL balance less the overhead reserve", async () => {
    const plan = await planRoute("sol", { lamports: 1_000_000_000, tokenRaw: 0n }, mh);
    expect(plan).not.toBeNull();
    expect(plan!.amountRaw).toBeLessThan(1_000_000_000n);
    expect(plan!.amountRaw).toBeGreaterThan(900_000_000n);
  });
  it("waits when the SOL balance is smaller than the overhead", async () => {
    expect(await planRoute("sol", { lamports: 10_000_000, tokenRaw: 0n }, mh)).toBeNull();
  });
});

describe("holdings", () => {
  it("tells USDC from SOL and dust from funds", () => {
    expect(inferAsset({ lamports: 5, tokenRaw: 1n })).toBe("usdc");
    expect(inferAsset({ lamports: 5, tokenRaw: 0n })).toBe("sol");
    expect(holdsFunds({ lamports: 2000, tokenRaw: 0n })).toBe(false);
    expect(holdsFunds({ lamports: 0, tokenRaw: 1n })).toBe(true);
  });
  it("knows the two mints", () => {
    expect(usdcMint("mainnet")).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(usdcMint("devnet")).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(WSOL_MINT).toMatch(/^So1111/);
  });
});

describe("runRoute: resume from the link", () => {
  it("a completed SOL route is emptied into the recipient, then the loop ends", async () => {
    const { rpc, sent } = fakeRpc({ lamports: 40_000_000 });
    const { e, events, infos } = await env({ rpc, mh: { byExternal: async () => done } });
    await runRoute(e);
    expect(events.map((x) => x.type)).toEqual(["created"]);
    expect(infos.some((i) => i.arrived)).toBe(true);
    // two passes of the SOL sweep (the keeper's refund can land late)
    expect(sent).toHaveLength(2);
  });

  it("a completed USDC route closes the empty token account before sweeping SOL", async () => {
    const usdcDone = { ...done, tokenMint: usdcMint(), tokenSymbol: "USDC" } as MhTransfer;
    // The router's own USDC ATA: anything else is refused by trustedTokenAccount.
    const { findAssociatedTokenAddress, TOKEN_PROGRAM } = await import("./soltx");
    const { base58Decode, base58Encode } = await import("./solana");
    const ata = base58Encode(
      await findAssociatedTokenAddress(base58Decode(vectors.address), base58Decode(usdcMint()), TOKEN_PROGRAM),
    );
    const { rpc, sent } = fakeRpc({ lamports: 40_000_000, tokens: [{ pubkey: ata, amount: 0n }] });
    const { e, key } = await env({ rpc, mh: { byExternal: async () => usdcDone } });
    await runRoute(e);
    // pass 1: close + sweep; pass 2: close again (account still listed by the fake) + sweep
    const kinds = sent.map((b64) => {
      const tx = parseTransaction(base64ToBytes(b64));
      return tx.accountKeys.length; // close has 3 keys (owner, account, token program), transfer has 3 too
    });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(kinds.every((n) => n === 3)).toBe(true);
    const first = base64ToBytes(sent[0]);
    // the close instruction data is the single byte 9, right before the end of the message
    expect(first[first.length - 1]).toBe(9);
    expect(key.address).toBe(vectors.address);
  });

  it("an active route is polled until it completes", async () => {
    const { rpc } = fakeRpc({ lamports: 40_000_000 });
    let gets = 0;
    const { e, events } = await env({
      rpc,
      mh: {
        byExternal: async () => active,
        get: async () => (++gets < 3 ? active : done),
      },
    });
    await runRoute(e);
    expect(gets).toBe(3);
    expect(events.filter((x) => x.type === "polled")).toHaveLength(3);
  });

  it("stops quietly on a refund and leaves the money in the router", async () => {
    const refunded = { ...active, status: "refunded", phase: "refunded" } as MhTransfer;
    const { rpc, sent } = fakeRpc({ lamports: 40_000_000 });
    const { e, infos } = await env({ rpc, mh: { byExternal: async () => refunded } });
    await runRoute(e);
    expect(sent).toHaveLength(0);
    expect(infos.some((i) => i.arrived)).toBe(false);
  });

  it("waits while the router is empty, and gives up cleanly when the tab goes", async () => {
    const { rpc } = fakeRpc({ lamports: 0 });
    let polls = 0;
    const { e, events } = await env({
      rpc,
      asset: "usdc",
      mh: { byExternal: async () => null },
      alive: () => ++polls < 4,
    });
    await runRoute(e);
    expect(events.some((x) => x.type === "failed")).toBe(false);
  });

  it("reports a failure as an event, not a throw", async () => {
    const { rpc } = fakeRpc({ lamports: 1 });
    const { e, events } = await env({
      rpc,
      mh: { byExternal: async () => { throw new Error("proxy down"); } },
    });
    await runRoute(e);
    expect(events).toEqual([{ type: "failed", message: "proxy down" }]);
  });
});
