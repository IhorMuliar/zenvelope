import { describe, expect, it } from "vitest";
import type { MhTransfer } from "./multihop";
import { LEFTOVER_MIN_LAMPORTS } from "./routeRun";
import { SWAP_WINDOW_SECONDS, leftoverPending, probeRoute, resumeScreen, swapMayBeInFlight } from "./resume";

const transfer = (status: string) => ({ id: 1, status, tokenMint: "m", recipientWallet: "r" }) as unknown as MhTransfer;
const empty = { lamports: 0, tokenRaw: 0n };
const funded = { lamports: 400_000_000, tokenRaw: 0n };
const NOW = 1_800_000_000;

describe("resumeScreen", () => {
  it("a transfer shows the tracker, whatever else is true", () => {
    for (const spent of [true, false]) {
      for (const held of [null, empty, funded]) {
        expect(resumeScreen({ transfer: transfer("active"), held, spent, nowSec: NOW })).toBe("tracker");
      }
    }
  });

  it("no transfer but money in the router asks where it goes", () => {
    expect(resumeScreen({ transfer: null, held: funded, spent: true, nowSec: NOW })).toBe("finish");
    expect(resumeScreen({ transfer: null, held: funded, spent: false, nowSec: NOW })).toBe("finish");
    expect(resumeScreen({ transfer: null, held: { lamports: 0, tokenRaw: 5n }, spent: false })).toBe("finish");
  });

  it("dust in the router is not funds", () => {
    expect(resumeScreen({ transfer: null, held: { lamports: 5000, tokenRaw: 0n }, spent: false })).toBe("none");
  });

  it("a spend a moment ago with an empty router may be a swap in flight", () => {
    const at = NOW - 120;
    expect(resumeScreen({ transfer: null, held: empty, spent: true, spentAtSec: at, nowSec: NOW })).toBe("swapping");
    expect(resumeScreen({ transfer: null, held: null, spent: true, spentAtSec: at, nowSec: NOW })).toBe("swapping");
  });

  it("an old spend, an unknown spend time or an unspent envelope is not a swap", () => {
    const old = NOW - SWAP_WINDOW_SECONDS - 1;
    expect(resumeScreen({ transfer: null, held: empty, spent: true, spentAtSec: old, nowSec: NOW })).toBe("none");
    expect(resumeScreen({ transfer: null, held: empty, spent: true, spentAtSec: null, nowSec: NOW })).toBe("none");
    expect(resumeScreen({ transfer: null, held: empty, spent: false, spentAtSec: NOW - 5, nowSec: NOW })).toBe("none");
    expect(swapMayBeInFlight(0, NOW)).toBe(false);
  });

  it("nothing at all is the ordinary screen", () => {
    expect(resumeScreen({ transfer: null, held: null, spent: false })).toBe("none");
    expect(resumeScreen({ transfer: null, held: empty, spent: true, spentAtSec: null })).toBe("none");
  });
});

describe("leftoverPending", () => {
  it("is a completed route whose router still holds more than dust", () => {
    expect(leftoverPending(transfer("completed"), { lamports: LEFTOVER_MIN_LAMPORTS + 1, tokenRaw: 0n })).toBe(true);
    expect(leftoverPending(transfer("completed"), { lamports: LEFTOVER_MIN_LAMPORTS, tokenRaw: 0n })).toBe(false);
    expect(leftoverPending(transfer("active"), funded)).toBe(false);
    expect(leftoverPending(null, funded)).toBe(false);
    expect(leftoverPending(transfer("completed"), null)).toBe(false);
  });
});

describe("probeRoute", () => {
  it("never throws: a bad secret, or a relay that does not answer, is 'nothing found'", async () => {
    expect(await probeRoute("!!", { timeoutMs: 50 })).toEqual({ transfer: null, held: null });
    const rpc = { getBalance: async () => { throw new Error("down"); }, getTokenBalance: async () => 0n } as never;
    const p = await probeRoute("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", {
      rpc,
      mh: () => ({ byExternal: async () => { throw new Error("down"); } }),
      timeoutMs: 2000,
    });
    expect(p).toEqual({ transfer: null, held: null });
  });

  it("returns what both witnesses said", async () => {
    const t = transfer("active");
    const rpc = { getBalance: async () => 123_456_789, getTokenBalance: async () => 0n } as never;
    const p = await probeRoute("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", {
      rpc,
      mh: () => ({ byExternal: async () => t }),
    });
    expect(p.transfer).toBe(t);
    expect(p.held).toEqual({ lamports: 123_456_789, tokenRaw: 0n });
  });
});
