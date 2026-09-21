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
  result: SweepResult | null;
  /** The error line, on the failed screen. */
  message: string | null;
}

export type SendEvent =
  | { type: "review" }
  | { type: "choose" }
  | { type: "send"; at: number }
  | { type: "stage"; stage: SweepStage; detail: string }
  | { type: "result"; result: SweepResult }
  | { type: "failed"; message: string };

export const initialSendState: SendState = {
  phase: "choose",
  stage: null,
  detail: null,
  done: [],
  startedAt: null,
  result: null,
  message: null,
};

export const SWEEP_FAILED_COPY =
  "We could not send it on. Nothing was spent, so the money is still in the envelope.";

/** Said on the error screen, under the message. */
export const FUNDS_SAFE_COPY =
  "The funds are still in the envelope. Nothing moved, and this link still works.";

/** An error_code of null or 0 is a success. Anything else means nothing moved. */
export function sweepFailure(result: SweepResult): string | null {
  const code = result.error_code;
  if (code === null || code === undefined || code === 0) return null;
  const message = result.error_message?.trim();
  return message && message !== "" ? message : SWEEP_FAILED_COPY;
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
          }
        : { ...state, phase: "failed", result: event.result, message: failure };
    }

    case "failed":
      return state.phase === "sending"
        ? { ...state, phase: "failed", message: event.message }
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
