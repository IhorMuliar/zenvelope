/**
 * What a reopened link should show, decided from what the route's three witnesses say.
 *
 * The router wallet and the external id both come from the link, so any link can be
 * asked: does MultiHopper know a transfer for it, and does the router wallet hold money?
 * {@link probeRoute} asks (cheaply, in parallel, never throwing); {@link resumeScreen}
 * is the pure decision.
 */

import {
  createMhClient,
  createSolRpc,
  externalIdFor,
  type MhClient,
  type MhTransfer,
  type SolRpc,
} from "./multihop";
import { deriveRouterKey, secretBytesFromB64url } from "./router";
import { LEFTOVER_MIN_LAMPORTS, holdsFunds, readHoldings } from "./routeRun";
import type { RouterBalance } from "./multihopFlow";

export type ResumeScreen =
  /** A transfer exists: the tracker, to completion and the leftover sweep. */
  | "tracker"
  /** No transfer, but the router holds money: ask where it goes, then run the route. */
  | "finish"
  /** Spent a moment ago, nothing visible yet: the swap into the router may still be running. */
  | "swapping"
  /** Nothing to resume: the page behaves as it always did. */
  | "none";

/** A spend this recent may still be a swap on its way to the router wallet. */
export const SWAP_WINDOW_SECONDS = 30 * 60;

export interface ResumeInput {
  transfer: MhTransfer | null;
  /** null when the router balance could not be read. */
  held: RouterBalance | null;
  /** The envelope itself has been spent. */
  spent: boolean;
  /** Unix seconds of the spend; null when unknown. */
  spentAtSec?: number | null;
  nowSec?: number;
}

/** True when a spend at `spentAtSec` could still be a swap in flight. */
export function swapMayBeInFlight(spentAtSec: number | null | undefined, nowSec: number): boolean {
  if (!spentAtSec || spentAtSec <= 0) return false;
  const age = nowSec - spentAtSec;
  return age >= -300 && age <= SWAP_WINDOW_SECONDS;
}

export function resumeScreen(i: ResumeInput): ResumeScreen {
  if (i.transfer) return "tracker";
  if (i.held && holdsFunds(i.held)) return "finish";
  if (i.spent && swapMayBeInFlight(i.spentAtSec, i.nowSec ?? Math.floor(Date.now() / 1000))) return "swapping";
  return "none";
}

/** A completed route whose router still holds more than dust has a leftover to collect. */
export function leftoverPending(transfer: MhTransfer | null, held: RouterBalance | null): boolean {
  return (
    transfer !== null &&
    (transfer.status ?? "").toLowerCase() === "completed" &&
    held !== null &&
    held.lamports > LEFTOVER_MIN_LAMPORTS
  );
}

export interface RouteProbe {
  transfer: MhTransfer | null;
  held: RouterBalance | null;
}

export const PROBE_TIMEOUT_MS = 8000;

/**
 * Asks MultiHopper (by external id) and the chain (router balances) at once. Every failure
 * is a null, and the whole thing gives up after {@link PROBE_TIMEOUT_MS}: opening a link
 * must never wait on, or break because of, this.
 */
export async function probeRoute(
  secret: string,
  deps: { mh?: (externalId: string) => Pick<MhClient, "byExternal">; rpc?: SolRpc; timeoutMs?: number } = {},
): Promise<RouteProbe> {
  const none: RouteProbe = { transfer: null, held: null };
  const work = (async (): Promise<RouteProbe> => {
    const bytes = secretBytesFromB64url(secret);
    const [key, externalId] = await Promise.all([deriveRouterKey(bytes), externalIdFor(bytes)]);
    const mh = deps.mh ? deps.mh(externalId) : createMhClient(undefined, externalId);
    const [transfer, held] = await Promise.all([
      mh.byExternal(externalId).catch(() => null),
      readHoldings(deps.rpc ?? createSolRpc(), key).catch(() => null),
    ]);
    return { transfer, held };
  })().catch(() => none);
  const timeout = new Promise<RouteProbe>((r) => setTimeout(() => r(none), deps.timeoutMs ?? PROBE_TIMEOUT_MS));
  return Promise.race([work, timeout]);
}
