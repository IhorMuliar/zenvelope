/**
 * Watching for the sender's payment, from the create page.
 *
 * A link made at creation carries the chain tip of that moment as its birthday,
 * and opening it scans every block from there to the tip of the day it is
 * opened (web/docs/PERF-2026-09-21.md: about 11 ms a block on four threads).
 * The blocks between "link made" and "payment mined" are pure waste for the
 * recipient. If the tab is still open when the payment lands, this module sees
 * it and the page can hand out a **final** link, `#<secret>.<H>`, whose
 * birthday is the height the note was mined at. Opened straight away that is
 * about one block of scanning; opened later it still skips everything before
 * the payment.
 *
 * The watch is a small state machine over injected timers, so the tests can
 * drive it with fake ones:
 *
 *   - the first look is {@link FIRST_POLL_MS} after the start (a wallet takes a
 *     while to send, and a block takes ~75 s to mine), then one every
 *     {@link POLL_EVERY_MS}, counted from the end of the previous round;
 *   - a round looks at every unpaid envelope **one at a time**: each look is an
 *     `open_envelope` in the one core worker, and fifty of them racing would only
 *     queue there and heat the machine;
 *   - it gives up after {@link WATCH_CAP_MS}; the page offers to look again;
 *   - a tab hidden for {@link HIDDEN_PAUSE_MS} pauses at its next tick and
 *     resumes {@link RESUME_MS} after it becomes visible again;
 *   - after a look that found nothing, the next look at that envelope starts
 *     {@link REORG_MARGIN} blocks below the tip that look reached, instead of at
 *     the birthday: the payment cannot be in a block already scanned clean,
 *     bar a reorg, so every look after the first is a handful of blocks.
 *
 * Nothing here is stored. The secrets live in the targets the caller passes in,
 * which live in React state; closing the tab ends the watch, and the original
 * links keep working exactly as before.
 */

export const FIRST_POLL_MS = 30_000;
export const POLL_EVERY_MS = 45_000;
export const WATCH_CAP_MS = 2 * 60 * 60 * 1000;
export const HIDDEN_PAUSE_MS = 10 * 60 * 1000;
export const RESUME_MS = 1_000;
/** How far below the last clean tip the next look starts, in case of a reorg. */
export const REORG_MARGIN = 10;

/** One envelope to watch. `id` is the row index; `secret` never leaves memory. */
export interface WatchTarget {
  id: number;
  secret: string;
  /** Where the first look starts: the link's birthday. */
  birthday: number;
}

/** A payment that arrived. `height` is the lowest note height when there are several. */
export interface Paid {
  height: number;
  zat: bigint;
}

/** What one look answers. `tip` is the chain tip the look scanned to. */
export interface CheckResult {
  paid: Paid | null;
  tip: number;
}

export type CheckFn = (target: WatchTarget, fromHeight: number) => Promise<CheckResult>;

export type WatchPhase =
  /** A look is scheduled for `nextAt`. */
  | "waiting"
  /** A round is in progress; `current` is the envelope being looked at. */
  | "checking"
  /** Hidden too long: no timers until the tab is visible again. */
  | "paused"
  /** Gave up after the cap. `restart()` looks again. */
  | "stopped"
  /** Every envelope is paid. */
  | "done";

export interface WatchSnapshot {
  phase: WatchPhase;
  /** Rounds finished. */
  rounds: number;
  /** The id being looked at, while `checking`. */
  current: number | null;
  /** Clock time the last round finished. */
  lastCheckedAt: number | null;
  /** Clock time the next round starts, while `waiting`. */
  nextAt: number | null;
  /** Looks that threw (both gateways down, say). The watch carries on. */
  errors: number;
  paid: ReadonlyMap<number, Paid>;
}

export interface WatchClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatchTiming {
  firstMs: number;
  everyMs: number;
  capMs: number;
  hiddenPauseMs: number;
  resumeMs: number;
}

export const DEFAULT_TIMING: WatchTiming = {
  firstMs: FIRST_POLL_MS,
  everyMs: POLL_EVERY_MS,
  capMs: WATCH_CAP_MS,
  hiddenPauseMs: HIDDEN_PAUSE_MS,
  resumeMs: RESUME_MS,
};

const realClock: WatchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WatchOptions {
  targets: readonly WatchTarget[];
  check: CheckFn;
  onChange: (s: WatchSnapshot) => void;
  clock?: WatchClock;
  timing?: Partial<WatchTiming>;
}

export interface PaymentWatch {
  start(): void;
  /** Tell the watch whether the tab is hidden (`document.hidden`). */
  setHidden(hidden: boolean): void;
  /** After a stop at the cap: start a fresh two hours, with a look in a second. */
  restart(): void;
  /** Stops for good. Results of a look still in flight are dropped. */
  dispose(): void;
  snapshot(): WatchSnapshot;
}

export function createPaymentWatch(opts: WatchOptions): PaymentWatch {
  const clock = opts.clock ?? realClock;
  const t: WatchTiming = { ...DEFAULT_TIMING, ...opts.timing };
  const from = new Map<number, number>(opts.targets.map((x) => [x.id, x.birthday]));
  const paid = new Map<number, Paid>();

  let phase: WatchPhase = "waiting";
  let rounds = 0;
  let current: number | null = null;
  let lastCheckedAt: number | null = null;
  let nextAt: number | null = null;
  let errors = 0;
  let startedAt = 0;
  let hiddenSince: number | null = null;
  let timer: unknown = null;
  let disposed = false;
  let started = false;

  const snapshot = (): WatchSnapshot => ({
    phase,
    rounds,
    current,
    lastCheckedAt,
    nextAt,
    errors,
    paid: new Map(paid),
  });
  const emit = () => {
    if (!disposed) opts.onChange(snapshot());
  };

  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number) => {
    clear();
    phase = "waiting";
    nextAt = clock.now() + ms;
    timer = clock.setTimeout(() => void tick(), ms);
    emit();
  };

  const allPaid = () => opts.targets.every((x) => paid.has(x.id));

  async function tick(): Promise<void> {
    timer = null;
    nextAt = null;
    if (disposed) return;
    const now = clock.now();
    if (now - startedAt >= t.capMs) {
      phase = "stopped";
      emit();
      return;
    }
    if (hiddenSince !== null && now - hiddenSince >= t.hiddenPauseMs) {
      phase = "paused";
      emit();
      return;
    }

    phase = "checking";
    for (const target of opts.targets) {
      if (disposed) return;
      if (paid.has(target.id)) continue;
      current = target.id;
      emit();
      try {
        const start = from.get(target.id) ?? target.birthday;
        const r = await opts.check(target, start);
        if (disposed) return;
        if (r.paid) paid.set(target.id, r.paid);
        else from.set(target.id, Math.max(target.birthday, r.tip - REORG_MARGIN));
      } catch {
        if (disposed) return;
        errors += 1;
      }
    }
    current = null;
    rounds += 1;
    lastCheckedAt = clock.now();
    if (allPaid()) {
      phase = "done";
      emit();
      return;
    }
    schedule(t.everyMs);
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      startedAt = clock.now();
      if (opts.targets.length === 0) {
        phase = "done";
        emit();
        return;
      }
      schedule(t.firstMs);
    },
    setHidden(hidden: boolean) {
      if (disposed) return;
      if (hidden) {
        if (hiddenSince === null) hiddenSince = clock.now();
        return;
      }
      hiddenSince = null;
      if (phase === "paused") schedule(t.resumeMs);
    },
    restart() {
      if (disposed || phase !== "stopped") return;
      startedAt = clock.now();
      schedule(t.resumeMs);
    },
    dispose() {
      disposed = true;
      clear();
    },
    snapshot,
  };
}

/* ------------------------------------------------------------ the final link */

const LINK_RE = /^(.*#)([A-Za-z0-9_-]{43})(?:\.(\d+))?$/;

/** The secret and birthday inside an envelope link, or null when it is not one. */
export function linkParts(link: string): { secret: string; birthday: number | undefined } | null {
  const m = LINK_RE.exec(link);
  if (!m) return null;
  return { secret: m[2], birthday: m[3] === undefined ? undefined : Number(m[3]) };
}

/**
 * The same link with its birthday set to the funding height: `#<secret>.<H>`.
 *
 * No format change — it is an ordinary `<secret>.<birthday>` fragment — only a
 * birthday that happens to be the block the note is in, so the scan starts there.
 */
export function finalLink(link: string, height: number): string {
  const m = LINK_RE.exec(link);
  if (!m) throw new Error("not an envelope link");
  if (!Number.isInteger(height) || height < 0) throw new Error("height must be a block height");
  return `${m[1]}${m[2]}.${height}`;
}

/** An `OpenResult` as a look's answer: paid at the lowest note height, or not yet. */
export function toCheckResult(r: {
  found: boolean;
  notes: ReadonlyArray<{ height: number; amount_zat: string }>;
  total_zat: string;
  tip_height: number;
}): CheckResult {
  if (!r.found || r.notes.length === 0) return { paid: null, tip: r.tip_height };
  const height = Math.min(...r.notes.map((n) => n.height));
  return { paid: { height, zat: BigInt(r.total_zat) }, tip: r.tip_height };
}
