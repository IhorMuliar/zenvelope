/**
 * Runs the private route from the router wallet's side, resumable from the link.
 *
 *   wait for the router to hold the funds  ->  create + broadcast the route
 *   -> poll until it settles  ->  empty the router into the recipient's wallet
 *
 * Everything it needs comes from three places: the link (the router key and the
 * externalId are both derived from the secret), MultiHopper (`byExternal`) and the
 * chain (the router's balances). No state is kept anywhere else, so closing the tab at
 * any point and opening the link again picks the run up where it stopped.
 *
 * It is plain async code over injected clients and a clock; the React component only
 * renders the events it emits.
 */

import {
  MhApiError,
  emptyRouter,
  realClock,
  startRoute,
  runBroadcast,
  type Clock,
  type MhClient,
  type MhTransfer,
  type SolRpc,
} from "./multihop";
import {
  fundingReached,
  phaseForTransfer,
  type FundingNeeds,
  type MhEvent,
  type RouterBalance,
} from "./multihopFlow";
import { routeSolFloor, solRouteAmount } from "./privateRoute";
import type { RouterKey } from "./router";
import { SOLANA_CLUSTER, WSOL_MINT, usdcMint, type SolanaCluster } from "./cluster";
import type { SolanaAsset } from "./oneclick";

export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;

export function mintFor(asset: SolanaAsset, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return asset === "sol" ? WSOL_MINT : usdcMint(cluster);
}

export function assetForMint(mint: string): SolanaAsset {
  return mint === WSOL_MINT ? "sol" : "usdc";
}

/** What the router wallet holds right now. */
export async function readHoldings(
  rpc: SolRpc,
  key: RouterKey,
  cluster: SolanaCluster = SOLANA_CLUSTER,
): Promise<RouterBalance> {
  const [lamports, tokenRaw] = await Promise.all([
    rpc.getBalance(key.address),
    rpc.getTokenBalance(key.address, usdcMint(cluster)),
  ]);
  if (!Number.isFinite(lamports)) throw new Error("the Solana relay did not answer with a balance");
  return { lamports, tokenRaw };
}

/** True when the router holds anything worth acting on: a token balance or real SOL. */
export function holdsFunds(b: RouterBalance): boolean {
  return b.tokenRaw > 0n || b.lamports > 5000 * 2;
}

/** USDC if it holds USDC, else SOL. Only for a link reopened with nothing else to go on. */
export function inferAsset(b: RouterBalance): SolanaAsset {
  return b.tokenRaw > 0n ? "usdc" : "sol";
}

export interface RoutePlan {
  amountRaw: bigint;
  needs: FundingNeeds;
  estimate: Awaited<ReturnType<MhClient["estimate"]>>;
}

function estimateBody(asset: SolanaAsset, amountRaw: bigint, cluster: SolanaCluster) {
  return {
    tokenMint: mintFor(asset, cluster),
    tokenDecimals: asset === "sol" ? SOL_DECIMALS : USDC_DECIMALS,
    tokenSymbol: asset === "sol" ? "SOL" : "USDC",
    amountRaw: amountRaw.toString(),
    hops: 3,
    arrivalSeconds: 120,
  };
}

/**
 * How much to route and what the router must hold for it, from its balance.
 *
 *   USDC: the whole token balance; SOL needed = the estimate's floor.
 *   SOL:  balance less the overhead reserve; SOL needed = the floor for that amount.
 *
 * null when the balance cannot carry a route yet (nothing to route, or the estimate
 * is refused for a tiny amount): the caller keeps waiting.
 */
export async function planRoute(
  asset: SolanaAsset,
  balance: RouterBalance,
  mh: Pick<MhClient, "estimate">,
  cluster: SolanaCluster = SOLANA_CLUSTER,
): Promise<RoutePlan | null> {
  if (asset === "usdc") {
    if (balance.tokenRaw <= 0n) return null;
    const estimate = await mh.estimate(estimateBody("usdc", balance.tokenRaw, cluster));
    return {
      amountRaw: balance.tokenRaw,
      estimate,
      needs: { lamports: routeSolFloor(estimate), tokenRaw: balance.tokenRaw },
    };
  }
  if (balance.lamports <= 0) return null;
  const probe = await mh.estimate(estimateBody("sol", BigInt(balance.lamports), cluster));
  const amount = solRouteAmount(balance.lamports, probe);
  if (amount <= 0) return null;
  const estimate = await mh.estimate(estimateBody("sol", BigInt(amount), cluster));
  return {
    amountRaw: BigInt(amount),
    estimate,
    needs: { lamports: routeSolFloor(estimate), tokenRaw: 0n },
  };
}

export interface RunInfo {
  asset?: SolanaAsset;
  recipient?: string;
  /** The router held the funds and a transfer exists. */
  funded?: boolean;
  /** The router has been emptied into the recipient's wallet. */
  arrived?: boolean;
  /** Signatures of the final sweep, for "See details". */
  finalSignatures?: string[];
  /** A soft problem on this poll; the run carries on. */
  note?: string | null;
}

export interface RunEnv {
  mh: MhClient;
  rpc: SolRpc;
  key: RouterKey;
  externalId: string;
  clock?: Clock;
  pollMs: number;
  cluster?: SolanaCluster;
  alive(): boolean;
  emit(event: MhEvent): void;
  info(patch: RunInfo): void;
  /** Mutable on purpose: the recipient may arrive late, when a link is reopened. */
  recipient(): string | null;
  /** The asset the gift is in, when the page knows it; null to infer from holdings. */
  asset: SolanaAsset | null;
}

const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : "something went wrong");

/** Sweeps the router out after a completed route, twice: the keeper refunds rent late. */
export async function finishRoute(env: RunEnv, transfer: MhTransfer, recipient: string): Promise<string[]> {
  const clock = env.clock ?? realClock;
  const mint = transfer.tokenMint;
  const sigs: string[] = [];
  const pass = async () => {
    const r = await emptyRouter(env.key, recipient, mint, env.rpc, { sendTokens: true });
    sigs.push(...r.tokens, ...r.closed, ...(r.sol ? [r.sol] : []));
  };
  await pass();
  env.info({ arrived: true, finalSignatures: [...sigs] });
  // The keeper's rent refund can land a little after `completed`; a second pass sends it.
  await clock.sleep(Math.min(20_000, env.pollMs * 2));
  if (env.alive()) {
    try {
      await pass();
      env.info({ finalSignatures: [...sigs] });
    } catch {
      /* the first pass already delivered the money */
    }
  }
  return sigs;
}

/**
 * The whole run. Resolves when the route has reached an end (done, refunded, failed) or
 * `alive()` turns false. Throws nothing the caller should not show: every failure is
 * emitted as a `failed` event and the function returns, so "Try again" can call it anew.
 */
export async function runRoute(env: RunEnv): Promise<void> {
  const clock = env.clock ?? realClock;
  const cluster = env.cluster ?? SOLANA_CLUSTER;
  const onStep = (step: { index: number; total: number; label: string }) =>
    env.emit({ type: "step", ...step });
  try {
    let transfer = await env.mh.byExternal(env.externalId);

    if (!transfer) {
      // Phase A: wait until the router holds what a route needs.
      let plan: RoutePlan | null = null;
      let asset: SolanaAsset | null = env.asset;
      for (;;) {
        if (!env.alive()) return;
        let balance: RouterBalance | null = null;
        try {
          balance = await readHoldings(env.rpc, env.key, cluster);
          asset = env.asset ?? inferAsset(balance);
          env.emit({ type: "balance", balance });
          env.info({ asset, note: null });
          plan = holdsFunds(balance) ? await planRoute(asset, balance, env.mh, cluster) : null;
        } catch (e) {
          // The relay or the estimate hiccuped: say so softly and look again.
          env.info({ note: errMsg(e) });
        }
        if (plan && balance && asset) {
          env.emit({ type: "estimated", estimate: plan.estimate, needs: plan.needs });
          env.emit({ type: "balance", balance });
          if (fundingReached(plan.needs, balance)) break;
          plan = null;
        }
        await clock.sleep(env.pollMs);
      }
      const recipient = env.recipient();
      if (!recipient || !plan || !asset) return;
      env.info({ funded: true });
      transfer = await startRoute(
        {
          tokenMint: mintFor(asset, cluster),
          tokenDecimals: asset === "sol" ? SOL_DECIMALS : USDC_DECIMALS,
          tokenSymbol: asset === "sol" ? "SOL" : "USDC",
          amountRaw: plan.amountRaw.toString(),
          sourceOwner: env.key.address,
          recipientWallet: recipient,
          externalId: env.externalId,
        },
        { mh: env.mh, rpc: env.rpc, key: env.key, clock, onStep },
      );
      env.emit({ type: "broadcast", transfer });
    } else {
      env.info({ funded: true, asset: assetForMint(transfer.tokenMint) });
      env.emit({ type: "created", transfer });
      if (transfer.recipientWallet) env.info({ recipient: transfer.recipientWallet });
    }

    // Phase B: a transfer exists. Finish signing if it stopped halfway, then watch it.
    for (;;) {
      if (!env.alive()) return;
      const phase = phaseForTransfer(transfer);
      if (phase === "signing") {
        transfer = await runBroadcast(transfer.id, {
          mh: env.mh, rpc: env.rpc, key: env.key, clock, onStep,
        });
        env.emit({ type: "broadcast", transfer });
        continue;
      }
      if (phase === "done") {
        const to = transfer.recipientWallet ?? env.recipient();
        if (to) await finishRoute(env, transfer, to);
        return;
      }
      if (phase === "refunded" || phase === "failed") return;
      await clock.sleep(env.pollMs);
      if (!env.alive()) return;
      try {
        transfer = await env.mh.get(transfer.id);
        env.emit({ type: "polled", transfer });
        env.info({ note: null });
      } catch (e) {
        // Transient: the route does not need this page, so keep asking.
        if (e instanceof MhApiError && e.status === 403) throw e;
        env.info({ note: errMsg(e) });
      }
    }
  } catch (e) {
    if (env.alive()) env.emit({ type: "failed", message: errMsg(e) });
  }
}
