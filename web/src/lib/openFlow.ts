/**
 * The open-flow state machine, kept out of the component so it can be tested
 * without a DOM.
 *
 * reading -> sealed -> scanning -> opened | spent | empty | failed
 *                        ^                     |
 *                        +----- retry ---------+
 *
 * Nothing here holds the secret: the component passes it straight to the core
 * and the state only ever carries what is safe to render.
 */

import type { FoundNote, LoadedCore, Network, OpenResult, ProgressFn } from "../core/types";

export type OpenPhase =
  | "reading"
  | "invalid"
  | "sealed"
  | "scanning"
  | "opened"
  | "spent"
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
  "This link has no envelope in it. Links look like /e#… and the part after the # is dropped by some chat apps, so copy the whole link and try again. This page forgets the link as soon as it has read it, so a reload lands here too: open the original link again.";

/**
 * Said on the open screens, because the address bar no longer shows the link.
 *
 * The secret is stripped out of the URL the moment it has been read (see
 * {@link stripSecretFromUrl}), which means a reload, a bookmark or a "share this
 * page" carries nothing — and also that the recipient has to keep the message
 * the link arrived in.
 */
export const LINK_FORGOTTEN_COPY =
  "Keep the original link: this page forgets it when reloaded.";

/** The parts of `window` {@link stripSecretFromUrl} touches. */
export interface UrlBar {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * Takes the secret out of the address bar and out of this history entry.
 *
 * A Zenvelope link is a bearer capability. Left in `location.hash` it sits in the
 * URL bar for the whole open → scan → prove flow, in the back/forward history, in
 * whatever the browser syncs between devices, and in anything the recipient taps
 * "share" on. Nothing needs it there: the flow reads the fragment once at mount
 * and every retry after that re-scans from the in-memory secret.
 *
 * `history.replaceState` rewrites the current entry rather than pushing a new
 * one, so there is no entry left holding the old URL and no navigation happens.
 * The cost is that a reload loses the secret; that is the trade, and the screens
 * say so ({@link LINK_FORGOTTEN_COPY}).
 *
 * Returns the URL that was written, or null when there was nothing to strip.
 */
export function stripSecretFromUrl(win: UrlBar): string | null {
  if (win.location.hash === "" || win.location.hash === "#") return null;
  const url = `${win.location.pathname}${win.location.search}`;
  try {
    win.history.replaceState(null, "", url);
  } catch {
    // Some embedded browsers refuse replaceState on an opaque origin. The secret
    // is already in memory and the flow does not read the hash again, so this is
    // a worse URL bar and nothing more: never a broken open.
    return null;
  }
  return url;
}

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
      if (!got) return { ...state, phase: "empty", result, message: NOT_FOUND_COPY };
      // Found, but every note was already swept: the "already opened" screen,
      // never the send-on controls. `all_spent` is the core's answer; the note
      // check is belt and braces for a result that says otherwise.
      if (result.all_spent || unspentNotes(result.notes).length === 0) {
        return { ...state, phase: "spent", result, message: null };
      }
      return { ...state, phase: "opened", result, message: null };
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

/**
 * The notes that are still there: the only ones the send-on flow may be handed.
 * A spent note in a sweep would be a nullifier the chain has already seen, and
 * no node accepts that.
 */
export function unspentNotes(notes: readonly FoundNote[]): FoundNote[] {
  return notes.filter((n) => !n.spent);
}

/** The notes someone already moved on. */
export function spentNotes(notes: readonly FoundNote[]): FoundNote[] {
  return notes.filter((n) => n.spent);
}

/** Where an envelope was swept: the latest spend among its notes. */
export interface SpendInfo {
  txid: string;
  height: number;
  /** Unix seconds, or null when the core did not report a block time. */
  time: number | null;
}

/**
 * The spend to show on the "already opened" screen. Notes are usually swept
 * together in one transaction; when they were not, the latest one is the moment
 * the envelope became empty.
 */
export function latestSpend(notes: readonly FoundNote[]): SpendInfo | null {
  let best: SpendInfo | null = null;
  for (const n of notes) {
    if (!n.spent || n.spent_txid === null || n.spent_height === null) continue;
    if (best === null || n.spent_height > best.height) {
      best = { txid: n.spent_txid, height: n.spent_height, time: n.spent_time || null };
    }
  }
  return best;
}

/**
 * A block time as a date, in UTC so every reader of a screenshot sees the same
 * day: "21 September 2026".
 */
export function formatSpendDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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
 * The gateway list the core is handed, as one string.
 *
 * `lightwalletd_url` has always been a single URL, and it still is: a string
 * with no comma in it means one gateway and behaves exactly as it did. Several,
 * comma-separated, mean "these, in preference order", which is what lets the
 * core race them for the chain tip and keep whichever answers first instead of
 * finding out the hard way that the primary is stalling.
 */
export function gatewayList(hosts: readonly string[]): string {
  return hosts.filter((h) => h.trim() !== "").join(",");
}

/**
 * Runs one scan.
 *
 * The first attempt hands the core every gateway at once, so the choice between
 * them is a 1.5 s race rather than a whole failed scan. The second attempt —
 * only reached when that threw, which means every gateway refused — pins the
 * failover on its own, because a gateway that answers slowly and one that
 * answers wrongly need different treatment and only the second attempt can tell
 * them apart. A second failure is surfaced as a retry-able error.
 */
export async function runOpen(opts: RunOpenOptions): Promise<OpenResult> {
  const { core, secret, birthday, network, hosts, onProgress, onAttempt } = opts;
  const tries = [gatewayList(hosts), ...hosts.slice(1)];
  let lastError: unknown;
  for (let attempt = 0; attempt < tries.length; attempt++) {
    onAttempt?.(attempt);
    try {
      return await core.open_envelope(secret, birthday, network, tries[attempt], onProgress);
    } catch (err) {
      lastError = err;
    }
  }
  // The underlying message can carry a host or a URL; it never carries the
  // secret, but it is not recipient-facing copy either, so it is dropped.
  void lastError;
  throw new Error(SCAN_FAILED_COPY);
}
