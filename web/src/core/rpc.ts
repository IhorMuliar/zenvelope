/**
 * The message protocol between the page and the core worker.
 *
 * One rule shapes all of it: **the core runs in the worker and nowhere else.** The page
 * never holds a wasm module, so a 40-second proof cannot hold the page's main thread,
 * and the progress screen keeps painting and the elapsed clock keeps ticking while the
 * proof runs (M3-VERIFICATION §4 is the finding this exists to fix).
 *
 * Everything crossing the boundary is structured-cloneable: plain objects, strings,
 * numbers and BigInt. Functions are not, so the two callbacks the core takes
 * (`on_progress` for the scan, `on_stage` for the sweep) are dropped from the argument
 * list on the way out and rebuilt in the worker, which reports them back as `progress`
 * and `stage` messages carrying the id of the call they belong to.
 *
 * The link secret is an argument like any other: it is posted to the worker, used, and
 * kept nowhere. Neither side writes it to storage, and nothing here is persisted.
 */

import type { CoreBackend, CoreInfo, SweepStage } from "./types";

/** Every core entry point the page can reach. There is no other way in. */
export const CORE_METHODS = [
  "derive",
  "generate_secret",
  "parse_fragment",
  "build_fragment",
  "payment_uri",
  "zat_to_zec_string",
  "zec_string_to_zat",
  "open_envelope",
  "warm_proving_key",
  "classify_address",
  "new_wallet",
  "sweep_envelope",
] as const;

export type CoreMethod = (typeof CORE_METHODS)[number];

/** `CoreBackend` and `CoreInfo` are the loader's own vocabulary and live in ./types
 *  next to the rest of the core contract; they are re-exported here because the
 *  protocol is what carries them. */
export type { CoreBackend, CoreInfo };

/* ------------------------------------------------------------ page -> worker */

/** Load the wasm and report what got loaded. Answered once; later calls are cheap. */
export interface InitMessage {
  kind: "init";
  id: number;
  /** Upper bound on the thread pool, so the caller owns the policy, not the worker. */
  maxThreads: number;
}

export interface CallMessage {
  kind: "call";
  id: number;
  method: CoreMethod;
  /** The core's arguments, minus any callback. */
  args: unknown[];
}

export type ToWorker = InitMessage | CallMessage;

/* ------------------------------------------------------------ worker -> page */

export interface ResultMessage {
  kind: "result";
  id: number;
  value: unknown;
}

export interface ErrorMessage {
  kind: "error";
  id: number;
  message: string;
}

/** `open_envelope`'s `on_progress`, forwarded. */
export interface ProgressMessage {
  kind: "progress";
  id: number;
  scanned: number;
  total: number;
}

/** `sweep_envelope`'s `on_stage`, forwarded. */
export interface StageMessage {
  kind: "stage";
  id: number;
  stage: SweepStage;
  detail: string;
}

export type FromWorker = ResultMessage | ErrorMessage | ProgressMessage | StageMessage;

/** The narrowest slice of `Worker` the client needs, so a test can stand one in. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate?(): void;
}
