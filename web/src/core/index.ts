/**
 * Core loader.
 *
 * From M4 the core runs in a dedicated Web Worker (./worker.ts) and the page holds only
 * the RPC client (./client.ts). The reason is measured, not theoretical: M3 proved on
 * the main thread, and 42 seconds of single-threaded halo2 with no `await` in it froze
 * the progress screen and stopped the elapsed clock (web/docs/M3-VERIFICATION.md §4).
 *
 * The exported surface is the same one the pages have always used — `loadCore()`,
 * resolving with a core that has every method of the contract in ./types — except that
 * every method is now a promise, because every call is a message round trip.
 *
 * The worker decides which wasm package to run (threaded or single-threaded) and reports
 * it back; `threads` and `backend` on the returned core are what the footer note shows.
 */

import { createCoreClient } from "./client";
import type { LoadedCore } from "./types";

/**
 * The ceiling on the proving pool.
 *
 * The M4 spike measured the Ironwood proof at 52.1 s on 1 thread, 20.3 s on 4 and 18.8 s
 * on 8: almost the whole win is in the first four threads, because only halo2's MSM and
 * FFT are parallel. Four is where the curve flattens, and leaving the rest of the
 * machine alone keeps the page responsive and the phone cooler.
 */
export const MAX_PROVING_THREADS = 4;

let cached: Promise<LoadedCore> | null = null;

function spawn(): Worker {
  // `new URL(..., import.meta.url)` with a literal path is the form Vite recognises: it
  // gives the worker its own build, with the single-threaded wasm package inside it.
  return new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "zenvelope-core",
  });
}

/**
 * How many threads to ask the worker for.
 *
 * `?threads=N` in the query string caps it, which is how the two rows of the M4 timing
 * table are measured against one build: `?threads=1` sends the worker down the
 * single-threaded path, because a pool of one costs more than it saves. It is a
 * measurement and debugging knob and nothing reads it but this function.
 */
export function provingThreads(search = window.location.search): number {
  const detected = Math.max(1, Math.floor(navigator.hardwareConcurrency || 1));
  const asked = Number(new URLSearchParams(search).get("threads"));
  const ceiling =
    Number.isFinite(asked) && asked >= 1 ? Math.min(asked, MAX_PROVING_THREADS) : MAX_PROVING_THREADS;
  return Math.min(detected, ceiling);
}

export function loadCore(): Promise<LoadedCore> {
  if (!cached) {
    cached = createCoreClient(spawn(), { maxThreads: provingThreads() });
  }
  return cached;
}

export { provingNote } from "./client";
export type { LoadedCore, ZenvelopeCore } from "./types";
