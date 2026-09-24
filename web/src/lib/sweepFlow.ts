/**
 * The send-it-on state machine: choosing a destination, reviewing the numbers,
 * the four stages of the sweep, and how it ends.
 *
 *   choose -> review -> sending -> sent
 *      ^        |          |
 *      +--------+          +------> failed --(send again)--> sending
 *
 * Kept out of the component so the stage handling can be tested without a DOM
 * and without a prover. Nothing here holds the secret: the component hands it
 * straight to the core, and this state only carries what is safe to render.
 */

import type { SweepResult, SweepStage } from "../core/types";

export type SendPhase = "choose" | "review" | "sending" | "sent" | "failed";

/** The working stages, in the order the core reports them. "done" ends the run. */
export const SEND_STAGES = ["witness", "keys", "proving", "broadcast"] as const;

export type WorkingStage = (typeof SEND_STAGES)[number];

/** What each stage is called on screen. Never a crate word, never "claim". */
export const STAGE_LABEL: Record<SweepStage, string> = {
  witness: "Building the proof of ownership",
  keys: "Preparing keys",
  proving: "Proving (this is the slow part)",
  broadcast: "Sending to the network",
  done: "Done",
};

/** When each stage started, by `Date.now()`. Missing means it was never reported. */
export type StageTimes = Partial<Record<SweepStage, number>>;

export interface SendState {
  phase: SendPhase;
  /** The stage running right now. null unless the sweep is under way. */
  stage: SweepStage | null;
  /** The core's one-line detail for that stage. */
  detail: string | null;
  /** Stages already finished, in order. */
  done: WorkingStage[];
  /** `Date.now()` when the sweep started, for the elapsed counter. */
  startedAt: number | null;
  /**
   * `Date.now()` at each stage the core reported, including the final "done".
   * First report wins, so a repeated stage cannot stretch a measurement. This is
   * what the Timing block on the done screen is made of.
   */
  stageAt: StageTimes;
  result: SweepResult | null;
  /** The error line, on the failed screen. */
  message: string | null;
  /**
   * True when the network refused the sweep because another transaction had
   * already spent the same note: someone else with this link got there first.
   * The failed screen then says so instead of promising the money is still here.
   */
  raced: boolean;
}

export type SendEvent =
  | { type: "review" }
  | { type: "choose" }
  | { type: "send"; at: number }
  | { type: "stage"; stage: SweepStage; detail: string; at: number }
  | { type: "result"; result: SweepResult; at: number }
  | { type: "failed"; message: string };

export const initialSendState: SendState = {
  phase: "choose",
  stage: null,
  detail: null,
  done: [],
  startedAt: null,
  stageAt: {},
  result: null,
  message: null,
  raced: false,
};

export const SWEEP_FAILED_COPY =
  "We could not send it on. Nothing was spent, so the money is still in the envelope.";

/** Said on the error screen, under the message. */
export const FUNDS_SAFE_COPY =
  "The funds are still in the envelope. Nothing moved, and this link still works.";

/**
 * Whether the swap's own lines belong on the screen.
 *
 * A reserved swap plan is only ever true of one destination: the Solana exit's
 * deposit address. When the recipient backs out of the exit and chooses a Zcash
 * address instead, the plan is thrown away — but the screens must not depend on
 * that having happened, because a review screen promising USDC on Solana above
 * a "Send it on" button that pays a unified address is a lie on an irreversible
 * action, and a Sent screen mounting the tracker polls an address nobody paid
 * (M3). Both conditions, in one place, checked by the review screen, the Sent
 * screen and the dry-run lines.
 */
export function showSwapUi(choice: string | null, swap: unknown): boolean {
  return choice === "solana" && swap !== null && swap !== undefined;
}

/**
 * Said on the failed screen when the network refused the sweep because the note
 * was already spent by another transaction (M3-VERIFICATION §11): the envelope
 * was opened on another device moments earlier. Nothing left this browser.
 */
export const RACE_LOST_COPY =
  "Someone opened this envelope moments ago on another device. Nothing was sent from here.";

/** The button under {@link RACE_LOST_COPY}: it runs the open again. */
export const RACE_CHECK_BUTTON = "Check the envelope";

/**
 * The mempool's double-spend refusal, as lightwalletd relays it: error_code -25,
 * or a message saying the inputs are already spent / "same effects". Matched on
 * both, because a thrown error carries only the text.
 */
export function isRaceLoss(code: number | null | undefined, message: string | null | undefined): boolean {
  if (code === -25) return true;
  const text = (message ?? "").toLowerCase();
  if (/error_code\s*-25\b/.test(text)) return true;
  return (
    text.includes("already spent") ||
    text.includes("already been spent") ||
    text.includes("same effects")
  );
}

/** An error_code of null or 0 is a success. Anything else means nothing moved. */
export function sweepFailure(result: SweepResult): string | null {
  const code = result.error_code;
  if (code === null || code === undefined || code === 0) return null;
  const message = result.error_message?.trim();
  return message && message !== "" ? message : SWEEP_FAILED_COPY;
}

/** First report of a stage wins: a repeated one cannot stretch a measurement. */
function markStage(times: StageTimes, stage: SweepStage, at: number): StageTimes {
  if (times[stage] !== undefined || !Number.isFinite(at)) return times;
  return { ...times, [stage]: at };
}

/** The stages finished by the time `stage` is running. */
function priorStages(stage: SweepStage): WorkingStage[] {
  if (stage === "done") return [...SEND_STAGES];
  const i = SEND_STAGES.indexOf(stage);
  return i <= 0 ? [] : SEND_STAGES.slice(0, i);
}

export function sendReducer(state: SendState, event: SendEvent): SendState {
  switch (event.type) {
    case "review":
      return state.phase === "choose" ? { ...state, phase: "review" } : state;

    case "choose":
      return state.phase === "review" || state.phase === "failed"
        ? { ...initialSendState }
        : state;

    // Reachable from the review screen and from the retry button on the error
    // screen: a failed sweep spent nothing, so trying again is the same run.
    case "send":
      return state.phase === "review" || state.phase === "failed"
        ? { ...initialSendState, phase: "sending", startedAt: event.at }
        : state;

    case "stage": {
      if (state.phase !== "sending") return state;
      // Stages only move forward: a late report of an earlier stage is ignored.
      const seen = priorStages(event.stage).length;
      if (state.stage !== null && seen < state.done.length) return state;
      return {
        ...state,
        stage: event.stage,
        detail: event.detail,
        done: priorStages(event.stage),
        stageAt: markStage(state.stageAt, event.stage, event.at),
      };
    }

    case "result": {
      if (state.phase !== "sending") return state;
      const failure = sweepFailure(event.result);
      return failure === null
        ? {
            ...state,
            phase: "sent",
            stage: "done",
            done: [...SEND_STAGES],
            result: event.result,
            message: null,
            // A core that resolves without a final "done" stage still gets a
            // finish line: the moment its answer arrived.
            stageAt: markStage(state.stageAt, "done", event.at),
          }
        : {
            ...state,
            phase: "failed",
            result: event.result,
            message: failure,
            raced: isRaceLoss(event.result.error_code, event.result.error_message),
          };
    }

    case "failed":
      return state.phase === "sending"
        ? { ...state, phase: "failed", message: event.message, raced: isRaceLoss(null, event.message) }
        : state;

    default:
      return state;
  }
}

export type ChecklistState = "done" | "active" | "waiting";

export interface ChecklistRow {
  stage: WorkingStage;
  label: string;
  state: ChecklistState;
}

/** The four-line checklist on the progress screen. */
export function stageChecklist(state: SendState): ChecklistRow[] {
  return SEND_STAGES.map((stage) => {
    const isDone = state.done.includes(stage);
    const isActive = !isDone && state.stage === stage;
    return {
      stage,
      label: STAGE_LABEL[stage],
      state: isDone ? "done" : isActive ? "active" : "waiting",
    };
  });
}

/**
 * True while leaving the page would throw away work that cannot be resumed: the
 * proof, and the broadcast that follows it. Nothing else gets a beforeunload
 * warning, because nothing else costs the recipient anything.
 */
export function needsUnloadWarning(state: SendState): boolean {
  return state.phase === "sending" && (state.stage === "proving" || state.stage === "broadcast");
}

/** Elapsed time as m:ss, for the progress screen. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ timings */

/**
 * The Timing block on the done screen.
 *
 * Every number here is wall clock measured in this browser: the scan, the
 * background proving-key warm-up, each stage the core reported, and the whole
 * run from the tap on "Send it on" to the last stage. Nothing is sent anywhere —
 * it is on screen and behind a copy button, so a recipient (or we) can say what
 * a real device actually did with a real envelope.
 */
export interface TimingInput {
  state: SendState;
  /** How long the open scan took, or null when this page did not run one. */
  openMs: number | null;
  /** How long `warm_proving_key` took, or null when it never finished. */
  warmMs: number | null;
  /**
   * `Date.now()` when the background warm-up finished, or null while it has not.
   *
   * The warm-up and the sweep share one worker thread, and building the proving key
   * is one long call with no `await` in it. A recipient who taps "Send it on" before
   * the key is ready therefore waits for the rest of that build before the core reads
   * its first byte — and that wait used to appear nowhere at all: it fell between the
   * tap and the first stage the core reports, so no row on this block covered it and
   * only "total tap-to-done" moved. It gets its own line now (PERF-2026-09-21.md §9).
   */
  warmDoneAt: number | null;
}

export interface TimingRow {
  key: string;
  label: string;
  /** null when the run never produced the pair of timestamps it needs. */
  ms: number | null;
  value: string;
}

/** One decimal, always, and an em dash where there is no measurement. */
export function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * How much of the sweep was spent waiting for the background warm-up to finish.
 *
 * Zero when the key was already built when the recipient tapped, which is the case
 * every measurement run arranges for and the case a recipient who reads the screen for
 * half a minute gets for free. It is never negative and never longer than the run.
 */
export function warmWaitMs(state: SendState, warmDoneAt: number | null): number | null {
  const started = state.startedAt;
  if (started === null) return null;
  if (warmDoneAt === null) return null;
  const waited = warmDoneAt - started;
  if (waited <= 0) return 0;
  // It cannot have lasted past the first thing the core reported.
  const firstReport = state.stageAt.witness;
  return firstReport === undefined ? waited : Math.min(waited, Math.max(0, firstReport - started));
}

/** The gap between two reported stages, or null when either is missing. */
export function stageSpan(times: StageTimes, from: SweepStage, to: SweepStage): number | null {
  const a = times[from];
  const b = times[to];
  if (a === undefined || b === undefined || b < a) return null;
  return b - a;
}

/**
 * The six lines, in the order they happened. "send" is the broadcast stage, and
 * on a dry run it is the time the core spent stopping short of one.
 */
export function timingRows(input: TimingInput): TimingRow[] {
  const { state, openMs, warmMs, warmDoneAt } = input;
  const t = state.stageAt;
  const doneAt = t.done;
  const total =
    state.startedAt !== null && doneAt !== undefined && doneAt >= state.startedAt
      ? doneAt - state.startedAt
      : null;
  const rows: [string, string, number | null][] = [
    ["open", "open/scan", openMs],
    ["keys", "keys (warm)", warmMs],
    ["waitkeys", "waiting for keys", warmWaitMs(state, warmDoneAt)],
    ["witness", "witness", stageSpan(t, "witness", "keys")],
    ["proving", "proving", stageSpan(t, "proving", "broadcast")],
    ["send", "send", stageSpan(t, "broadcast", "done")],
    ["total", "total tap-to-done", total],
  ];
  return rows.map(([key, label, ms]) => ({ key, label, ms, value: formatSeconds(ms) }));
}

/** What the page knows about the machine that did the proving. */
export interface DeviceInfo {
  /** Threads the core reported for the proving pool. */
  threads: number;
  hardwareConcurrency: number;
  userAgent: string;
  /** `navigator.brave` says so: Brave's user agent is Chrome's, to the letter. */
  brave?: boolean;
  /**
   * Which gRPC-web gateway the core raced and won with, as a host name.
   *
   * Two runs of the same envelope on the same machine can differ by tens of
   * seconds purely because one of the public gateways was stalling, so a timing
   * report that does not say which server answered is not a measurement. Absent
   * or empty, the line leaves it out rather than inventing one.
   */
  gateway?: string;
}

/**
 * Which browser, from the user agent — plus the one flag a user agent cannot
 * carry. This is for reading a timing report, not for deciding anything, so an
 * unknown engine is simply "unknown" rather than a guess.
 */
export function browserFamily(ua: string, brave = false): string {
  if (brave) return "Brave";
  if (/\b(Firefox|FxiOS)\//.test(ua)) return "Firefox";
  if (/\b(Edg|EdgiOS)\//.test(ua)) return "Edge";
  // `HeadlessChrome/` has no word boundary before "Chrome", and it is what our
  // own measurement runs send: a timing report that called them Safari would be
  // wrong about the only browser we drive ourselves.
  if (/(HeadlessChrome|Chrome|CriOS|Chromium)\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /AppleWebKit\//.test(ua)) return "Safari";
  return "unknown";
}

/** Which platform, from the user agent. */
export function platformName(ua: string): string {
  if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/(Macintosh|Mac OS X)/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/(Linux|CrOS|X11)/.test(ua)) return "Linux";
  return "unknown";
}

/** "proving: 4 threads · hardwareConcurrency 8 · Chrome on macOS · gateway zjs.zec.rocks". */
export function deviceLine(info: DeviceInfo): string {
  const threads = `proving: ${info.threads} thread${info.threads === 1 ? "" : "s"}`;
  const cores = `hardwareConcurrency ${info.hardwareConcurrency}`;
  const where = `${browserFamily(info.userAgent, info.brave)} on ${platformName(info.userAgent)}`;
  const gateway = info.gateway?.trim();
  const parts = [threads, cores, where];
  if (gateway) parts.push(`gateway ${gateway}`);
  return parts.join(" · ");
}

/** What the "Copy timing" button puts on the clipboard: the block, as text. */
export function timingText(rows: TimingRow[], device: string): string {
  return [...rows.map((r) => `${r.label} ${r.value}`), device].join("\n");
}
