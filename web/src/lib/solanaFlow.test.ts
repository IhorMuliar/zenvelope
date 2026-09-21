/**
 * The Solana exit state machine, and the two gates in it.
 *
 * Both gates are the point of the file: a recipient cannot reach a deposit
 * address without ticking the trust boundary, and cannot use a key this page
 * generated without saying they saved it. Everything else is bookkeeping.
 */

import { describe, expect, it } from "vitest";
import type { OneClickQuoteResponse } from "./oneclick";
import {
  SWAP_STAGES,
  canGetDeposit,
  canQuote,
  destinationReady,
  initialSolanaExitState,
  recipientAddress,
  refundAddress,
  solanaExitReducer,
  statusPollMs,
  swapChecklist,
  swapFinished,
  swapStatusLine,
  type SolanaExitEvent,
  type SolanaExitState,
} from "./solanaFlow";

const ADDRESS = "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS";
const ENVELOPE = "u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlq";

const QUOTE = {
  quote: {
    amountIn: "132000",
    amountInFormatted: "0.00132",
    amountInUsd: "1.99",
    minAmountIn: "132000",
    amountOut: "1669370",
    amountOutFormatted: "1.66937",
    amountOutUsd: "1.66",
    minAmountOut: "1652676",
    timeEstimate: 454,
    refundFee: "32000",
    withdrawFee: "298357",
  },
  quoteRequest: {
    dry: true,
    amount: "132000",
    originAsset: "nep141:zec.omft.near",
    destinationAsset: "nep141:sol-…",
    refundTo: ENVELOPE,
    recipient: ADDRESS,
  },
  signature: "ed25519:…",
  timestamp: "2026-09-21T02:33:27.939Z",
} as OneClickQuoteResponse;

function run(events: SolanaExitEvent[], from = initialSolanaExitState): SolanaExitState {
  return events.reduce(solanaExitReducer, from);
}

/** Everything up to a priced quote, with a pasted address. */
const TO_QUOTE: SolanaExitEvent[] = [
  { type: "ack", value: true },
  { type: "toAsset" },
  { type: "asset", asset: "usdc" },
  { type: "mode", mode: "paste" },
  { type: "pasted", value: ADDRESS },
  { type: "busy" },
  { type: "quote", quote: QUOTE },
];

describe("the trust-boundary gate", () => {
  it("starts on the trust boundary, unticked", () => {
    expect(initialSolanaExitState.phase).toBe("trust");
    expect(initialSolanaExitState.acknowledged).toBe(false);
  });

  it("does not move on while the box is unticked, however hard it is asked", () => {
    const state = run([{ type: "toAsset" }, { type: "toAsset" }, { type: "toAsset" }]);
    expect(state.phase).toBe("trust");
  });

  it("moves on once, and only once, the box is ticked", () => {
    expect(run([{ type: "ack", value: true }, { type: "toAsset" }]).phase).toBe("asset");
  });

  it("can be unticked again before continuing", () => {
    const state = run([
      { type: "ack", value: true },
      { type: "ack", value: false },
      { type: "toAsset" },
    ]);
    expect(state.phase).toBe("trust");
  });
});

describe("choosing what arrives", () => {
  it("goes straight to the destination once an asset is picked", () => {
    const state = run([
      { type: "ack", value: true },
      { type: "toAsset" },
      { type: "asset", asset: "sol" },
    ]);
    expect(state.asset).toBe("sol");
    expect(state.phase).toBe("destination");
  });
});

describe("the destination", () => {
  it("accepts a valid pasted address", () => {
    const state = run([...TO_QUOTE.slice(0, 5)]);
    expect(recipientAddress(state)).toBe(ADDRESS);
    expect(destinationReady(state)).toBe(true);
    expect(canQuote(state)).toBe(true);
  });

  it("refuses an invalid one", () => {
    const state = run([
      ...TO_QUOTE.slice(0, 4),
      { type: "pasted", value: "not-a-solana-address" },
    ]);
    expect(destinationReady(state)).toBe(false);
    expect(canQuote(state)).toBe(false);
  });

  it("will not use a generated key until it is saved", () => {
    const keypair = { address: ADDRESS, secretKeyBase58: "x".repeat(88) };
    const base = run([
      ...TO_QUOTE.slice(0, 3),
      { type: "mode", mode: "generate" },
      { type: "keypair", keypair },
    ]);
    expect(recipientAddress(base)).toBe(ADDRESS);
    expect(base.savedKey).toBe(false);
    expect(destinationReady(base)).toBe(false);
    expect(canQuote(base)).toBe(false);

    const saved = solanaExitReducer(base, { type: "savedKey", value: true });
    expect(destinationReady(saved)).toBe(true);
    expect(canQuote(saved)).toBe(true);

    // And it is a gate, not a one-way door.
    expect(destinationReady(solanaExitReducer(saved, { type: "savedKey", value: false }))).toBe(
      false,
    );
  });

  it("drops a generated key when the mode changes away from it", () => {
    const keypair = { address: ADDRESS, secretKeyBase58: "x".repeat(88) };
    const state = run([
      ...TO_QUOTE.slice(0, 3),
      { type: "mode", mode: "generate" },
      { type: "keypair", keypair },
      { type: "savedKey", value: true },
      { type: "mode", mode: "paste" },
    ]);
    expect(state.keypair).toBeNull();
    expect(state.savedKey).toBe(false);
    expect(recipientAddress(state)).toBe("");
  });

  it("reports a browser with no Ed25519 without losing the screen", () => {
    const state = run([
      ...TO_QUOTE.slice(0, 3),
      { type: "mode", mode: "generate" },
      { type: "keypairError", message: "no Ed25519 here" },
    ]);
    expect(state.keypair).toBeNull();
    expect(state.keypairError).toBe("no Ed25519 here");
    expect(state.phase).toBe("destination");
  });
});

describe("the quote", () => {
  it("lands on the review screen with the priced quote", () => {
    const state = run(TO_QUOTE);
    expect(state.phase).toBe("quote");
    expect(state.busy).toBe(false);
    expect(state.quote?.quote.amountOut).toBe("1669370");
    expect(canGetDeposit(state, 132000n)).toBe(true);
  });

  it("remembers the rail's floor and blocks the deposit under it", () => {
    const state = run([
      ...TO_QUOTE,
      { type: "busy" },
      { type: "quoteError", message: "too low", minAmountZat: 132000n },
    ]);
    expect(state.minAmountZat).toBe(132000n);
    expect(state.error).toBe("too low");
    expect(canGetDeposit(state, 115000n)).toBe(false);
    // The same envelope, once it is over the floor, is fine.
    expect(canGetDeposit(state, 132000n)).toBe(true);
  });

  it("keeps a floor it has already learnt across a later, unrelated failure", () => {
    const state = run([
      ...TO_QUOTE,
      { type: "quoteError", message: "too low", minAmountZat: 132000n },
      { type: "quoteError", message: "the rail is down" },
    ]);
    expect(state.minAmountZat).toBe(132000n);
    expect(state.error).toBe("the rail is down");
  });

  it("does not start a second request while one is in flight", () => {
    const state = run([...TO_QUOTE.slice(0, 5), { type: "busy" }]);
    expect(state.busy).toBe(true);
    expect(canQuote(state)).toBe(false);
  });
});

describe("the deposit address", () => {
  it("is the last step before the ordinary sweep takes over", () => {
    const state = run([
      ...TO_QUOTE,
      { type: "busy" },
      {
        type: "deposit",
        reservation: {
          address: "t1Yqx4HkL1F9CQRfgzG4h9PD1SyZsY96vmd",
          deadline: "2026-09-24T09:00:00.000Z",
          quote: QUOTE.quote,
        },
      },
    ]);
    expect(state.phase).toBe("deposit");
    expect(state.deposit?.address).toMatch(/^t1/);
    expect(state.deposit?.deadline).toBe("2026-09-24T09:00:00.000Z");
  });

  it("falls back to the review screen when reserving one fails", () => {
    const state = run([
      ...TO_QUOTE,
      { type: "busy" },
      {
        type: "deposit",
        reservation: { address: "t1x", deadline: null, quote: QUOTE.quote },
      },
      { type: "quoteError", message: "the rail refused" },
    ]);
    expect(state.phase).toBe("quote");
    expect(state.error).toBe("the rail refused");
  });
});

describe("going back", () => {
  it("walks the steps in reverse and always reaches the trust boundary", () => {
    let state = run([
      ...TO_QUOTE,
      {
        type: "deposit",
        reservation: { address: "t1x", deadline: null, quote: QUOTE.quote },
      },
    ]);
    expect(state.phase).toBe("deposit");
    for (const expected of ["quote", "destination", "asset", "trust", "trust"] as const) {
      state = solanaExitReducer(state, { type: "back" });
      expect(state.phase).toBe(expected);
    }
  });

  it("resets to a closed gate", () => {
    const state = solanaExitReducer(run(TO_QUOTE), { type: "reset" });
    expect(state).toEqual(initialSolanaExitState);
    expect(state.acknowledged).toBe(false);
  });
});

describe("the refund address (D14)", () => {
  it("is the envelope's own address by default", () => {
    expect(refundAddress(initialSolanaExitState, ENVELOPE)).toBe(ENVELOPE);
  });

  it("is the override when one is typed, whitespace ignored", () => {
    const state = solanaExitReducer(initialSolanaExitState, {
      type: "refund",
      value: "  u1mine  ",
    });
    expect(refundAddress(state, ENVELOPE)).toBe("u1mine");
  });

  it("goes back to the envelope when the override is cleared", () => {
    const state = run([
      { type: "refund", value: "u1mine" },
      { type: "refund", value: "   " },
    ]);
    expect(refundAddress(state, ENVELOPE)).toBe(ENVELOPE);
  });
});

describe("watching the swap", () => {
  it("has three stages", () => {
    expect(SWAP_STAGES).toEqual(["deposit", "swap", "payout"]);
  });

  it("waits on the deposit first", () => {
    const rows = swapChecklist("PENDING_DEPOSIT");
    expect(rows.map((r) => r.state)).toEqual(["active", "waiting", "waiting"]);
    expect(swapStatusLine("PENDING_DEPOSIT")).toMatch(/has not seen the ZEC yet/);
  });

  it("moves to the swap once the deposit is known", () => {
    expect(swapChecklist("PROCESSING").map((r) => r.state)).toEqual(["done", "active", "waiting"]);
    expect(swapChecklist("KNOWN_DEPOSIT_TX").map((r) => r.state)).toEqual([
      "done",
      "active",
      "waiting",
    ]);
  });

  it("finishes on SUCCESS", () => {
    expect(swapChecklist("SUCCESS").map((r) => r.state)).toEqual(["done", "done", "done"]);
    expect(swapStatusLine("SUCCESS")).toBe("Paid out on Solana.");
  });

  it("stops, rather than completes, on a refund or a failure", () => {
    expect(swapChecklist("REFUNDED").map((r) => r.state)).toEqual(["done", "stopped", "stopped"]);
    expect(swapChecklist("FAILED").map((r) => r.state)).toEqual(["done", "stopped", "stopped"]);
    expect(swapStatusLine("REFUNDED")).toMatch(/sent back to the refund address/);
  });

  it("treats a status it has never heard of as work in progress", () => {
    expect(swapChecklist("SOMETHING_NEW").map((r) => r.state)).toEqual([
      "done",
      "active",
      "waiting",
    ]);
    expect(swapStatusLine("SOMETHING_NEW")).toBe("The swap service reports: SOMETHING_NEW.");
  });

  it("asks every 20 seconds, and lets a test ask faster within limits", () => {
    expect(statusPollMs("")).toBe(20_000);
    expect(statusPollMs("?poll=250")).toBe(250);
    // Not a flood, and not slower than the default either.
    expect(statusPollMs("?poll=1")).toBe(100);
    expect(statusPollMs("?poll=999999")).toBe(20_000);
    expect(statusPollMs("?poll=nonsense")).toBe(20_000);
  });

  it("knows when to stop asking", () => {
    expect(swapFinished(null)).toBe(false);
    expect(swapFinished({ status: "PROCESSING", updatedAt: "now" })).toBe(false);
    expect(swapFinished({ status: "SUCCESS", updatedAt: "now" })).toBe(true);
    expect(swapFinished({ status: "REFUNDED", updatedAt: "now" })).toBe(true);
  });
});
