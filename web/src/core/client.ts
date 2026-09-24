/**
 * The typed RPC client for the core worker.
 *
 * Every method of the core becomes one message out and one message back. The two
 * callbacks stay where they are in the argument list — the pages call the core exactly
 * as they did in M3, only with an `await` in front — but they never cross the boundary:
 * the client keeps them, strips them from the posted arguments, and calls them when the
 * worker reports `progress` or `stage` for that call's id.
 *
 * Takes a {@link WorkerLike} rather than constructing a `Worker`, so the whole protocol
 * can be tested against a fake in Node (see ./client.test.ts). ./index.ts is what knows
 * about the real one.
 */

import type { CoreMethod, WorkerLike } from "./rpc";
import type { CoreInfo, LoadedCore, ProgressFn, ScanEvent, StageFn } from "./types";

/**
 * Where the callback sits in each core method's argument list. Anything not named here
 * takes no callback; anything named here has that slot replaced before posting.
 */
const CALLBACK_SLOT: Partial<Record<CoreMethod, number>> = {
  open_envelope: 4,
  sweep_envelope: 9,
};

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CoreClientOptions {
  /**
   * Upper bound on the proving thread pool. The worker asks rayon for at most this many
   * and reports back what it got. The caller owns the policy so the worker does not have
   * to guess at one.
   */
  maxThreads: number;
}

/**
 * Starts the core in `worker` and resolves with the page-facing core once it has said
 * what it loaded. A worker that dies takes every in-flight call with it.
 */
export function createCoreClient(
  worker: WorkerLike,
  opts: CoreClientOptions,
): Promise<LoadedCore> {
  let nextId = 1;
  let dead: Error | null = null;
  const pending = new Map<number, Pending>();
  const onProgress = new Map<number, ProgressFn>();
  const onStage = new Map<number, StageFn>();

  const settle = (id: number) => {
    pending.delete(id);
    onProgress.delete(id);
    onStage.delete(id);
  };

  worker.addEventListener("message", (event) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object") return;
    const id = msg.id as number;

    switch (msg.kind) {
      case "result": {
        const p = pending.get(id);
        settle(id);
        p?.resolve(msg.value);
        return;
      }
      case "error": {
        const p = pending.get(id);
        settle(id);
        p?.reject(new Error(String(msg.message ?? "the core worker failed")));
        return;
      }
      case "progress": {
        const cb = onProgress.get(id);
        const event = (msg.event as ScanEvent | null | undefined) ?? null;
        // The structured event rides along only when there is one, so a plain
        // count still reaches the callback as exactly two arguments.
        if (event) cb?.(msg.scanned as number, msg.total as number, event);
        else cb?.(msg.scanned as number, msg.total as number);
        return;
      }
      case "stage": {
        onStage.get(id)?.(msg.stage as Parameters<StageFn>[0], msg.detail as string);
        return;
      }
      default:
        return;
    }
  });

  worker.addEventListener("error", (event) => {
    const message =
      (event as { message?: string })?.message ?? "the core worker stopped unexpectedly";
    dead = new Error(message);
    for (const [id, p] of pending) {
      settle(id);
      p.reject(dead);
    }
  });

  function send(message: Record<string, unknown> & { id: number }): Promise<unknown> {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      try {
        worker.postMessage(message);
      } catch (err) {
        settle(message.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * One core call. `args` is the method's own argument list, callback and all; the
   * callback is pulled out here and never posted.
   */
  function call(method: CoreMethod, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    const slot = CALLBACK_SLOT[method];
    const posted = [...args];
    if (slot !== undefined) {
      const cb = posted[slot];
      posted[slot] = null;
      if (typeof cb === "function") {
        if (method === "open_envelope") onProgress.set(id, cb as ProgressFn);
        else onStage.set(id, cb as StageFn);
      }
    }
    return send({ kind: "call", id, method, args: posted });
  }

  const m =
    <T>(method: CoreMethod) =>
    (...args: unknown[]) =>
      call(method, args) as Promise<T>;

  return send({ kind: "init", id: nextId++, maxThreads: opts.maxThreads }).then((value) => {
    const info = value as CoreInfo;
    return {
      backend: info.backend,
      isMock: info.isMock,
      threads: info.threads,
      reason: info.reason ?? null,

      derive: m("derive"),
      generate_secret: m("generate_secret"),
      parse_fragment: m("parse_fragment"),
      build_fragment: m("build_fragment"),
      payment_uri: m("payment_uri"),
      zat_to_zec_string: m("zat_to_zec_string"),
      zec_string_to_zat: m("zec_string_to_zat"),
      open_envelope: m("open_envelope"),
      warm_proving_key: m("warm_proving_key"),
      classify_address: m("classify_address"),
      new_wallet: m("new_wallet"),
      sweep_envelope: m("sweep_envelope"),
    } as LoadedCore;
  });
}

/** The footer note: what is actually doing the proving. */
export function provingNote(info: CoreInfo): string {
  if (info.isMock) return "proving: mock core";
  return info.threads === 1 ? "proving: 1 thread" : `proving: ${info.threads} threads`;
}
