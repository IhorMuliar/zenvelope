/**
 * What the route tracker shows, as pure functions of what the page knows.
 *
 *   Swapping -> Packed -> Hop i of n -> Landing -> In your wallet
 *
 * Measured on devnet: `route.hops` lists every wallet the money visits *including the
 * recipient as the last entry*, and a hop's `executedAt` is set when the money has
 * left its predecessor and arrived there. So with n entries, n-1 intermediate hops
 * remain visible as "Hop i of n"; when only the last is left, the money is "Landing".
 */

import { privateRoute as copy } from "../copy/en";
import type { MhTransfer } from "./multihop";
import { hopProgress, type MhPhase } from "./multihopFlow";
import { ROUTE_SECONDS } from "./privateRoute";

export type RowState = "done" | "active" | "waiting" | "stopped";
export type RowKey = "swap" | "packed" | "hops" | "landing" | "arrived";

export interface TrackerRow {
  key: RowKey;
  label: string;
  state: RowState;
}

export interface TrackerInput {
  /** The swap into the router wallet has not landed yet (1Click still working). */
  swapping: boolean;
  phase: MhPhase;
  transfer: MhTransfer | null;
  /** The leftover SOL has been sent on: the recipient has it all. */
  arrived: boolean;
  /** The swap step is not part of this run (a devnet test, or a refund). */
  hideSwap?: boolean;
}

export function trackerRows(i: TrackerInput): TrackerRow[] {
  const { done, total } = i.transfer ? hopProgress(i.transfer) : { done: 0, total: 0 };
  const n = Math.max(total, 1);
  const stopped = i.phase === "refunded" || i.phase === "failed";
  // Not yet routing: nothing has been packed.
  const preRoute = i.swapping || ["estimating", "funding", "creating", "signing"].includes(i.phase);
  const routing = i.phase === "routing";
  const finished = i.phase === "done" || i.arrived;

  const packedState: RowState = i.swapping
    ? "waiting"
    : preRoute
      ? i.phase === "estimating" || i.phase === "funding"
        ? "waiting"
        : "active"
      : "done";

  const landingActive = routing && done >= n - 1;
  const hopsDone = finished || landingActive || (routing && done >= n - 1);
  const hopIndex = Math.min(done + 1, Math.max(n - 1, 1));

  const rows: TrackerRow[] = [];
  if (!i.hideSwap) {
    rows.push({ key: "swap", label: copy.swapping, state: i.swapping ? "active" : "done" });
  }
  rows.push({ key: "packed", label: copy.packed, state: stopped && i.transfer ? "done" : packedState });
  rows.push({
    key: "hops",
    label: routing && !hopsDone ? copy.hop(hopIndex, n) : copy.hopWaiting,
    state: stopped ? "stopped" : hopsDone ? "done" : routing ? "active" : "waiting",
  });
  rows.push({
    key: "landing",
    label: copy.landing,
    state: stopped ? "stopped" : finished ? "done" : landingActive ? "active" : "waiting",
  });
  rows.push({
    key: "arrived",
    label: copy.arrived,
    state: stopped ? "stopped" : i.arrived ? "done" : "waiting",
  });
  return rows;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export interface Eta {
  /** Seconds until the last hop is scheduled; null when unknown. */
  remainingSec: number | null;
  /** More than twice the expected duration has passed. */
  late: boolean;
}

/**
 * Expected duration = last hop's `scheduledAt` minus the transfer's creation time (about
 * two minutes). It is "late" once the route has run for more than twice that and is not
 * complete: the wording then is "taking longer than usual", never "failed".
 */
export function routeEta(t: MhTransfer | null, nowMs: number): Eta {
  if (!t) return { remainingSec: null, late: false };
  const start = ms(t.createdAt) ?? ms(t.quotedAt);
  const scheduled = (t.route?.hops ?? [])
    .map((h) => ms(h.scheduledAt))
    .filter((x): x is number => x !== null);
  const last = scheduled.length ? Math.max(...scheduled) : null;
  const expected = start !== null && last !== null && last > start ? (last - start) / 1000 : ROUTE_SECONDS;
  const over = start !== null && nowMs - start > 2 * expected * 1000;
  const complete = (t.status ?? "").toLowerCase() === "completed";
  return {
    remainingSec: last === null ? null : Math.max(0, Math.round((last - nowMs) / 1000)),
    late: over && !complete,
  };
}

/** "any moment now" or "in about N min". */
export function etaWords(remainingSec: number | null): string | null {
  if (remainingSec === null) return null;
  if (remainingSec < 45) return copy.etaSoon;
  return copy.etaIn(Math.ceil(remainingSec / 60));
}

/** How often to ask MultiHopper where a route stands: 15 s, or `?poll=` clamped for tests. */
export function routePollMs(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): number {
  try {
    const asked = Number(new URLSearchParams(search).get("poll"));
    if (!Number.isFinite(asked) || asked <= 0) return 15_000;
    return Math.max(100, Math.min(asked, 15_000));
  } catch {
    return 15_000;
  }
}
