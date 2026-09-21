/**
 * A core worker that is not a worker: the test double behind every unit test that
 * exercises the M4 RPC path.
 *
 * Test-only, and imported by nothing the app ships. It exists because the real thing
 * cannot be unit tested: `new Worker(new URL("./worker.ts", import.meta.url))` needs a
 * bundler and a browser, and the wasm inside it needs a build. `createCoreClient` takes
 * a {@link WorkerLike} precisely so this can stand in.
 *
 * Two of them:
 *
 *   - {@link fakeWorker} answers nothing. The test drives the protocol message by
 *     message, which is how the handshake, out-of-order answers, the forwarded
 *     callbacks and a worker that dies are all reachable from Node.
 *   - {@link coreBackedWorker} answers for real, out of a {@link SyncCore} (the MOCK by
 *     default), speaking exactly the protocol web/src/core/worker.ts speaks. Code that
 *     calls the core — the group builder, the open flow — can then be tested against a
 *     genuine promise-per-call client rather than against a hand-written stub that
 *     happens to be `async`.
 *
 * Answers are delivered in a microtask, never synchronously, so a test that passes only
 * because the "round trip" resolved before the next line would fail here too.
 */

import { mockCore } from "./mock";
import type { CallMessage, InitMessage, ToWorker, WorkerLike } from "./rpc";
import type { CoreInfo, ProgressFn, StageFn, SyncCore } from "./types";

export interface FakeWorker extends WorkerLike {
  /** Everything the client posted, in order. */
  sent: Array<Record<string, unknown>>;
  /** Pushes a message back to the client, as the worker would. */
  reply(message: unknown): void;
  /** Fires the worker's `error` event. */
  die(message: string): void;
}

export function fakeWorker(): FakeWorker {
  const listeners: Record<string, Array<(e: unknown) => void>> = { message: [], error: [] };
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    postMessage(message: unknown) {
      sent.push(message as Record<string, unknown>);
    },
    addEventListener(type: string, listener: (e: never) => void) {
      listeners[type].push(listener as (e: unknown) => void);
    },
    reply(message: unknown) {
      for (const l of listeners.message) l({ data: message });
    },
    die(message: string) {
      for (const l of listeners.error) l({ message });
    },
  };
}

/** What a checkout with no wasm build reports back from the init handshake. */
export const MOCK_CORE_INFO: CoreInfo = {
  backend: "mock",
  isMock: true,
  threads: 1,
  reason: "no wasm build in this checkout",
};

/**
 * A fake worker that runs `core` behind the real protocol: init, one result or error per
 * call, and the two callbacks rebuilt on this side and reported back as `progress` and
 * `stage` messages tagged with the call's id — the same contract as worker.ts.
 */
export function coreBackedWorker(
  core: SyncCore = mockCore,
  info: CoreInfo = MOCK_CORE_INFO,
): FakeWorker {
  const worker = fakeWorker();
  const post = worker.postMessage.bind(worker);

  const messageOf = (err: unknown): string => {
    const m = (err as Error)?.message;
    return typeof m === "string" && m.trim() !== "" ? m : String(err);
  };

  const answerCall = async (msg: CallMessage): Promise<void> => {
    try {
      const args = [...msg.args];
      if (msg.method === "open_envelope") {
        const onProgress: ProgressFn = (scanned, total) =>
          worker.reply({ kind: "progress", id: msg.id, scanned, total });
        args[4] = onProgress;
      } else if (msg.method === "sweep_envelope") {
        const onStage: StageFn = (stage, detail) =>
          worker.reply({ kind: "stage", id: msg.id, stage, detail });
        args[9] = onStage;
      }
      const fn = (core as unknown as Record<string, (...a: unknown[]) => unknown>)[msg.method];
      if (typeof fn !== "function") throw new Error(`the core has no ${msg.method}()`);
      const value = await fn.apply(core, args);
      worker.reply({ kind: "result", id: msg.id, value });
    } catch (err) {
      worker.reply({ kind: "error", id: msg.id, message: messageOf(err) });
    }
  };

  worker.postMessage = (message: unknown) => {
    post(message);
    const msg = message as ToWorker;
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "init") {
      const init = msg as InitMessage;
      queueMicrotask(() => worker.reply({ kind: "result", id: init.id, value: info }));
    } else if (msg.kind === "call") {
      queueMicrotask(() => void answerCall(msg as CallMessage));
    }
  };

  return worker;
}
