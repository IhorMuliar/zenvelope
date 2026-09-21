/**
 * The RPC wrapper, against a fake worker.
 *
 * No DOM, no wasm and no real Worker: the client takes a `WorkerLike`, so the whole
 * protocol — the init handshake, argument marshalling, the two forwarded callbacks,
 * errors, and a worker that dies — can be driven message by message from Node.
 *
 * What these guard is the thing the worker exists for: that a callback never crosses
 * the boundary (it is not cloneable, and posting one is a runtime TypeError in a real
 * browser), and that a late report from a superseded call cannot be mistaken for a
 * live one.
 */

import { describe, expect, it, vi } from "vitest";
import { createCoreClient, provingNote } from "./client";
import { fakeWorker, type FakeWorker as Fake } from "./fakeWorker";
import type { CoreInfo } from "./rpc";

const INFO: CoreInfo = { backend: "threads", isMock: false, threads: 4, reason: null };

/** A client whose init handshake has already been answered. */
async function connected(worker: Fake, info: CoreInfo = INFO) {
  const pending = createCoreClient(worker, { maxThreads: 4 });
  const init = worker.sent[0];
  worker.reply({ kind: "result", id: init.id, value: info });
  return pending;
}

describe("the init handshake", () => {
  it("asks for the pool it was given and reports back what loaded", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);

    expect(worker.sent[0]).toMatchObject({ kind: "init", maxThreads: 4 });
    expect(core.backend).toBe("threads");
    expect(core.threads).toBe(4);
    expect(core.isMock).toBe(false);
  });

  it("carries the MOCK verdict and the fallback reason through", async () => {
    const worker = fakeWorker();
    const core = await connected(worker, {
      backend: "mock",
      isMock: true,
      threads: 1,
      reason: "this page is not cross-origin isolated",
    });
    expect(core.isMock).toBe(true);
    expect(core.threads).toBe(1);
    expect(core.reason).toContain("cross-origin");
  });

  it("rejects when the worker cannot load a core at all", async () => {
    const worker = fakeWorker();
    const pending = createCoreClient(worker, { maxThreads: 4 });
    worker.reply({ kind: "error", id: worker.sent[0].id, message: "no core" });
    await expect(pending).rejects.toThrow("no core");
  });
});

describe("a plain call", () => {
  it("posts the method and its arguments and resolves with the result", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);

    const pending = core.derive("s".repeat(43), "main");
    const call = worker.sent[1];
    expect(call).toMatchObject({
      kind: "call",
      method: "derive",
      args: ["s".repeat(43), "main"],
    });

    worker.reply({
      kind: "result",
      id: call.id,
      value: { address: "u1abc", ufvk: "uview1", diversifier_index: 0 },
    });
    await expect(pending).resolves.toEqual({
      address: "u1abc",
      ufvk: "uview1",
      diversifier_index: 0,
    });
  });

  it("turns a worker error into a rejection with the worker's own message", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);
    const pending = core.parse_fragment("nope");
    worker.reply({ kind: "error", id: worker.sent[1].id, message: "that is not a fragment" });
    await expect(pending).rejects.toThrow("that is not a fragment");
  });

  it("gives every call its own id, so answers cannot be crossed", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);

    const a = core.classify_address("u1a", "main");
    const b = core.classify_address("t1b", "main");
    const [callA, callB] = [worker.sent[1], worker.sent[2]];
    expect(callA.id).not.toBe(callB.id);

    // Answered out of order on purpose.
    worker.reply({ kind: "result", id: callB.id, value: { kind: "transparent", reason: null } });
    worker.reply({ kind: "result", id: callA.id, value: { kind: "unified_orchard", reason: null } });

    await expect(a).resolves.toEqual({ kind: "unified_orchard", reason: null });
    await expect(b).resolves.toEqual({ kind: "transparent", reason: null });
  });
});

describe("the forwarded callbacks", () => {
  it("never posts on_progress, and calls it from the worker's messages", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);
    const onProgress = vi.fn();

    const pending = core.open_envelope("secret", 3_490_000, "main", "https://lwd", onProgress);
    const call = worker.sent[1];
    const args = call.args as unknown[];
    // The callback slot is posted as null: a function is not structured-cloneable and
    // posting one would be a DataCloneError in a browser.
    expect(args).toHaveLength(5);
    expect(args[4]).toBeNull();
    expect(args.some((a) => typeof a === "function")).toBe(false);

    worker.reply({ kind: "progress", id: call.id, scanned: 10, total: 100 });
    worker.reply({ kind: "progress", id: call.id, scanned: 60, total: 100 });
    expect(onProgress.mock.calls).toEqual([
      [10, 100],
      [60, 100],
    ]);

    worker.reply({ kind: "result", id: call.id, value: { found: false, notes: [] } });
    await expect(pending).resolves.toMatchObject({ found: false });
  });

  it("never posts on_stage, and calls it in order", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);
    const onStage = vi.fn();

    const pending = core.sweep_envelope(
      "secret",
      "main",
      "https://lwd",
      { txid: "ab", height: 1, action_index: 0 },
      "u1dest",
      "u1fee",
      "30000",
      null,
      false,
      onStage,
    );
    const call = worker.sent[1];
    const args = call.args as unknown[];
    expect(args).toHaveLength(10);
    expect(args[9]).toBeNull();
    // `broadcast: false` survives the trip exactly as given: a dry run must stay one.
    expect(args[8]).toBe(false);

    for (const stage of ["witness", "keys", "proving", "broadcast"]) {
      worker.reply({ kind: "stage", id: call.id, stage, detail: `${stage} detail` });
    }
    expect(onStage.mock.calls.map(([s]) => s)).toEqual([
      "witness",
      "keys",
      "proving",
      "broadcast",
    ]);

    worker.reply({ kind: "result", id: call.id, value: { txid: "cd", broadcast: false } });
    await expect(pending).resolves.toMatchObject({ broadcast: false });
  });

  it("drops reports for a call that has already been answered", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);
    const onProgress = vi.fn();

    const pending = core.open_envelope("secret", undefined, "main", "https://lwd", onProgress);
    const call = worker.sent[1];
    worker.reply({ kind: "result", id: call.id, value: { found: false, notes: [] } });
    await pending;

    worker.reply({ kind: "progress", id: call.id, scanned: 99, total: 100 });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("works when no callback is passed at all", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);
    const pending = core.open_envelope("secret", undefined, "main", "https://lwd");
    const call = worker.sent[1];
    expect((call.args as unknown[])[4]).toBeNull();
    worker.reply({ kind: "result", id: call.id, value: { found: false, notes: [] } });
    await expect(pending).resolves.toBeTruthy();
  });
});

describe("a worker that dies", () => {
  it("rejects everything in flight and everything after", async () => {
    const worker = fakeWorker();
    const core = await connected(worker);

    const inFlight = core.warm_proving_key();
    worker.die("worker crashed");

    await expect(inFlight).rejects.toThrow("worker crashed");
    await expect(core.generate_secret()).rejects.toThrow("worker crashed");
  });
});

describe("the footer note", () => {
  it("says how many threads are actually proving", () => {
    expect(provingNote({ ...INFO, threads: 4 })).toBe("proving: 4 threads");
    expect(provingNote({ ...INFO, backend: "single", threads: 1 })).toBe("proving: 1 thread");
    expect(provingNote({ ...INFO, threads: 2 })).toBe("proving: 2 threads");
  });

  it("never claims a thread count for the MOCK", () => {
    expect(provingNote({ backend: "mock", isMock: true, threads: 1, reason: null })).toBe(
      "proving: mock core",
    );
  });
});
