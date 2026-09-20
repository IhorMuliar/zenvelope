/**
 * The open-flow state machine, kept out of the component so it can be tested
 * without a DOM.
 *
 * reading -> sealed -> scanning -> opened | empty | failed
 *                        ^                     |
 *                        +----- retry ---------+
 *
 * Nothing here holds the secret: the component passes it straight to the core
 * and the state only ever carries what is safe to render.
 */

import type { LoadedCore, Network, OpenResult, ProgressFn } from "../core/types";

export type OpenPhase =
  | "reading"
  | "invalid"
  | "sealed"
  | "scanning"
  | "opened"
  | "empty"
  | "failed";

export interface OpenState {
  phase: OpenPhase;
  /** Blocks scanned so far. */
  scanned: number;
  /** Blocks to scan, or 0 while the scanner does not know yet. */
  total: number;
  /** Which host this attempt is using: 0 primary, 1 failover. */
  attempt: number;
  result: OpenResult | null;
  message: string | null;
}

export type OpenEvent =
  | { type: "parsed" }
  | { type: "invalid"; message: string }
  | { type: "open" }
  | { type: "progress"; scanned: number; total: number }
  | { type: "attempt"; attempt: number }
  | { type: "result"; result: OpenResult }
  | { type: "failed"; message: string }
  | { type: "retry" };

export const initialOpenState: OpenState = {
  phase: "reading",
  scanned: 0,
  total: 0,
  attempt: 0,
  result: null,
  message: null,
};

const SCANNING: OpenState = {
  ...initialOpenState,
  phase: "scanning",
};

export const NOT_FOUND_COPY =
  "Nothing here yet. If the sender just paid, wait a minute and try again.";

export const SCAN_FAILED_COPY =
  "We could not reach a Zcash node from this browser. Your envelope is fine: nothing was sent anywhere. Check your connection and try again.";

export const NO_FRAGMENT_COPY =
  "This link has no envelope in it. Links look like /e#… and the part after the # is dropped by some chat apps, so copy the whole link and try again.";

export const BAD_FRAGMENT_COPY =
  "This link does not contain a valid envelope. Check that you copied all of it.";

export function openReducer(state: OpenState, event: OpenEvent): OpenState {
  switch (event.type) {
    case "parsed":
      return state.phase === "reading" ? { ...state, phase: "sealed" } : state;

    case "invalid":
      return { ...initialOpenState, phase: "invalid", message: event.message };

    case "open":
      return state.phase === "sealed" ? { ...SCANNING } : state;

    case "attempt":
      return state.phase === "scanning" ? { ...state, attempt: event.attempt } : state;

    case "progress": {
      if (state.phase !== "scanning") return state;
      // Progress only ever moves forward, and a late 0 total never erases a
      // span we already know.
      const total = event.total > 0 ? event.total : state.total;
      const scanned = Math.max(state.scanned, Math.max(0, event.scanned));
      return {
        ...state,
        total,
        scanned: total > 0 ? Math.min(scanned, total) : scanned,
      };
    }

    case "result": {
      if (state.phase !== "scanning") return state;
      const { result } = event;
      const got = result.found && result.notes.length > 0;
      return got
        ? { ...state, phase: "opened", result, message: null }
        : { ...state, phase: "empty", result, message: NOT_FOUND_COPY };
    }

    case "failed":
      return state.phase === "scanning"
        ? { ...state, phase: "failed", message: event.message }
        : state;

    case "retry":
      return state.phase === "empty" || state.phase === "failed" ? { ...SCANNING } : state;

    default:
      return state;
  }
}

/** True while the page should show the progress screen. */
export function isScanning(state: OpenState): boolean {
  return state.phase === "scanning";
}

/** The progress line, or null while the span is still unknown. */
export function progressLabel(state: OpenState, fmt: (n: number) => string): string | null {
  if (state.total <= 0) return null;
  return `block ${fmt(state.scanned)} of ${fmt(state.total)}`;
}

export interface RunOpenOptions {
  core: Pick<LoadedCore, "open_envelope">;
  secret: string;
  birthday: number | undefined;
  network: Network;
  /** Primary lightwalletd, then the failover host (DECISIONS D3). */
  hosts: readonly [string, string];
  onProgress: ProgressFn;
  /** Told which host is in use, so the UI can say so. */
  onAttempt?: (attempt: number) => void;
}

/**
 * Runs one scan: primary host, and on a thrown error exactly one retry against
 * the failover host. A second failure is surfaced as a retry-able error.
 */
export async function runOpen(opts: RunOpenOptions): Promise<OpenResult> {
  const { core, secret, birthday, network, hosts, onProgress, onAttempt } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt < hosts.length; attempt++) {
    onAttempt?.(attempt);
    try {
      return await core.open_envelope(secret, birthday, network, hosts[attempt], onProgress);
    } catch (err) {
      lastError = err;
    }
  }
  // The underlying message can carry a host or a URL; it never carries the
  // secret, but it is not recipient-facing copy either, so it is dropped.
  void lastError;
  throw new Error(SCAN_FAILED_COPY);
}
