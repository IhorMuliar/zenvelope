import { describe, expect, it } from "vitest";
import polls from "./__fixtures__/mh-polls-sol.json";
import create from "./__fixtures__/mh-create-sol.json";
import estimate from "./__fixtures__/mh-estimate-sol.json";
import type { MhEstimate, MhTransfer } from "./multihop";
import {
  fundingReached,
  hopProgress,
  initialMhState,
  mhReducer,
  overheadOk,
  phaseForTransfer,
  resumeFrom,
} from "./multihopFlow";

const est = estimate as unknown as MhEstimate;
const t = (o: object) => o as unknown as MhTransfer;
const needs = { lamports: 400, tokenRaw: 0n };

describe("hopProgress", () => {
  it("counts executedAt, not progress.hopsTotal (which is 2x)", () => {
    expect(hopProgress(t(polls[0]))).toEqual({ done: 0, total: 3 });
    expect(hopProgress(t(polls[1]))).toEqual({ done: 1, total: 3 });
    expect(hopProgress(t(polls[2]))).toEqual({ done: 3, total: 3 });
  });
  it("falls back to the requested hops before a route exists", () => {
    expect(hopProgress(t({ hops: 3, route: null }))).toEqual({ done: 0, total: 3 });
  });
});

describe("phaseForTransfer", () => {
  it.each([
    ["quote", "signing"],
    ["awaiting_signature", "signing"],
    ["processing", "signing"],
    ["active", "routing"],
    ["completed", "done"],
    ["refunded", "refunded"],
    ["failed", "failed"],
  ])("%s -> %s", (status, phase) => expect(phaseForTransfer(t({ status }))).toBe(phase));
  it("sees a refund in the phase", () => {
    expect(phaseForTransfer(t({ status: "failed", phase: "refunded" }))).toBe("refunded");
  });
});

describe("reducer", () => {
  it("walks the happy path", () => {
    let s = mhReducer(initialMhState, { type: "estimated", estimate: est, needs });
    expect(s.phase).toBe("funding");
    s = mhReducer(s, { type: "balance", balance: { lamports: 100, tokenRaw: 0n } });
    expect(s.phase).toBe("funding");
    s = mhReducer(s, { type: "balance", balance: { lamports: 400, tokenRaw: 0n } });
    expect(s.phase).toBe("creating");
    s = mhReducer(s, { type: "created", transfer: t(create) });
    expect(s.phase).toBe("signing");
    s = mhReducer(s, { type: "step", index: 2, total: 6, label: "route init 1" });
    expect(s.step?.index).toBe(2);
    s = mhReducer(s, { type: "broadcast", transfer: t(polls[0]) });
    expect(s.phase).toBe("routing");
    expect(s.step).toBeNull();
    s = mhReducer(s, { type: "polled", transfer: t(polls[1]) });
    expect(s.hops).toEqual({ done: 1, total: 3 });
    s = mhReducer(s, { type: "polled", transfer: t(polls[2]) });
    expect(s.phase).toBe("done");
    // a stale poll cannot undo it
    expect(mhReducer(s, { type: "polled", transfer: t(polls[0]) }).phase).toBe("done");
  });

  it("fails and retries", () => {
    let s = mhReducer(resumeFrom(t(create), { lamports: 0, tokenRaw: 0n }), { type: "failed", message: "boom" });
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("boom");
    s = mhReducer(s, { type: "retry" });
    expect(s.phase).toBe("signing");
  });

  it("needs both SOL and tokens for an SPL route", () => {
    const n = { lamports: 10, tokenRaw: 5n };
    expect(fundingReached(n, { lamports: 10, tokenRaw: 4n })).toBe(false);
    expect(fundingReached(n, { lamports: 10, tokenRaw: 5n })).toBe(true);
  });
});

describe("resumeFrom", () => {
  const empty = { lamports: 0, tokenRaw: 0n };
  it("fresh link", () => expect(resumeFrom(null, empty).phase).toBe("estimating"));
  it("partly funded", () => expect(resumeFrom(null, { lamports: 5, tokenRaw: 0n }).phase).toBe("funding"));
  it("funded with known needs", () => expect(resumeFrom(null, { lamports: 500, tokenRaw: 0n }, needs).phase).toBe("creating"));
  it("transfer awaiting signature", () => expect(resumeFrom(t(create), empty).phase).toBe("signing"));
  it("transfer active", () => {
    const s = resumeFrom(t(polls[1]), empty);
    expect(s.phase).toBe("routing");
    expect(s.hops?.done).toBe(1);
  });
  it("transfer completed", () => expect(resumeFrom(t(polls[2]), empty).phase).toBe("done"));
  it("transfer refunded", () => expect(resumeFrom(t({ status: "refunded" }), empty).phase).toBe("refunded"));
});

describe("overheadOk", () => {
  // Fixture: 0.3 SOL route, netCost 334,127,033 -> overhead 34,127,033 (+10% buffer).
  it("subtracts the principal on a SOL route", () => {
    const v = overheadOk(est, 1000, 90, { isSolRoute: true });
    expect(v.overheadLamports).toBe(Math.ceil(34_127_033 * 1.1));
    expect(v.overheadUsd).toBeCloseTo(3.378, 2);
    expect(v.ok).toBe(true);
  });
  it("is not ok for a small gift", () => {
    const v = overheadOk(est, 20, 90, { isSolRoute: true });
    expect(v.ok).toBe(false);
    expect(v.minGiftUsd).toBeCloseTo(v.overheadUsd / 0.05, 6);
  });
  it("uses netCost alone for SPL", () => {
    expect(overheadOk(est, 1e6, 90).overheadLamports).toBe(Math.ceil(334_127_033 * 1.1));
  });
  it("is the threshold at exactly 5%", () => {
    const v = overheadOk(est, 100, 90, { isSolRoute: true });
    expect(overheadOk(est, v.minGiftUsd, 90, { isSolRoute: true }).ok).toBe(true);
    expect(overheadOk(est, 0, 90, { isSolRoute: true }).ok).toBe(false);
  });
});
