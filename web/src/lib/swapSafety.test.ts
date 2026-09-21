/**
 * The four rules that stand between a quote and somebody's money.
 *
 *   M4  the refund address is classified before a quote may be asked for
 *   M5  the spread has a ceiling, and `minAmountOut` is enforced
 *   M6  the deposit address is a transparent one of ours, and the rail's echo
 *       of the request is compared with the request
 *   M3  a swap plan only ever describes the destination it belongs to
 *
 * All four are pure functions over the exit's state, which is why they are
 * tested here rather than clicked through: the browser half is in
 * `e2e/m5-solana.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { MAX_SPREAD_BPS } from "../config";
import { SOLANA_ASSETS, type OneClickQuote, type OneClickQuoteResponse } from "./oneclick";
import {
  canGetDeposit,
  canQuote,
  checkSwapPlan,
  initialSolanaExitState,
  quoteAcceptable,
  refundReady,
  solanaExitReducer,
  type SolanaExitEvent,
  type SolanaExitState,
} from "./solanaFlow";
import { showSwapUi } from "./sweepFlow";
import { solanaExit as copy } from "../copy/en";

const SOLANA = "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS";
const ENVELOPE = "u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlq";
const USDC = SOLANA_ASSETS.usdc.id;

/** A priced quote whose USD figures are a healthy 452 bps apart. */
const QUOTE: OneClickQuote = {
  amountIn: "132000",
  amountInFormatted: "0.00132",
  amountInUsd: "1.99",
  minAmountIn: "132000",
  amountOut: "1669370",
  amountOutFormatted: "1.66937",
  amountOutUsd: "1.90",
  minAmountOut: "1652676",
  timeEstimate: 454,
  refundFee: "32000",
  withdrawFee: "298357",
};

function run(events: SolanaExitEvent[], from = initialSolanaExitState): SolanaExitState {
  return events.reduce(solanaExitReducer, from);
}

/** Everything up to the destination screen, with a pasted Solana address. */
const AT_DESTINATION: SolanaExitEvent[] = [
  { type: "ack", value: true },
  { type: "toAsset" },
  { type: "asset", asset: "usdc" },
  { type: "mode", mode: "paste" },
  { type: "pasted", value: SOLANA },
];

/* ------------------------------------------- M4: the refund address is checked */

describe("M4: the refund override goes through the core", () => {
  it("needs no check while the box is empty: that is the envelope's own address", () => {
    const state = run(AT_DESTINATION);
    expect(state.refundStatus).toBe("default");
    expect(refundReady(state)).toBe(true);
    expect(canQuote(state)).toBe(true);
  });

  it("blocks the quote while the typed address has not been classified yet", () => {
    const state = run([...AT_DESTINATION, { type: "refund", value: "u1something" }]);
    expect(state.refundStatus).toBe("checking");
    expect(canQuote(state)).toBe(false);
  });

  it("allows the quote once the core says the address is payable", () => {
    const state = run([
      ...AT_DESTINATION,
      { type: "refund", value: "u1something" },
      { type: "refundVerdict", input: "u1something", ok: true, message: null },
    ]);
    expect(state.refundStatus).toBe("ok");
    expect(canQuote(state)).toBe(true);
  });

  it("blocks it, with the reason, when the core refuses the address", () => {
    const state = run([
      ...AT_DESTINATION,
      { type: "refund", value: "ztestsapling1nope" },
      {
        type: "refundVerdict",
        input: "ztestsapling1nope",
        ok: false,
        message: `${copy.refundInvalid} this is a Test address and the sweep is running on Main`,
      },
    ]);
    expect(state.refundStatus).toBe("bad");
    expect(state.refundMessage).toMatch(/Test address/);
    expect(refundReady(state)).toBe(false);
    expect(canQuote(state)).toBe(false);
  });

  it("puts the verdict back to unknown on the next keystroke", () => {
    const state = run([
      ...AT_DESTINATION,
      { type: "refund", value: "u1good" },
      { type: "refundVerdict", input: "u1good", ok: true, message: null },
      { type: "refund", value: "u1goodx" },
    ]);
    expect(state.refundStatus).toBe("checking");
    expect(canQuote(state)).toBe(false);
  });

  it("drops a verdict about text that has already been typed past", () => {
    const state = run([
      ...AT_DESTINATION,
      { type: "refund", value: "u1bad" },
      { type: "refund", value: "u1good" },
      // The slow answer about the earlier text lands last, and is ignored.
      { type: "refundVerdict", input: "u1bad", ok: true, message: null },
    ]);
    expect(state.refundStatus).toBe("checking");
  });

  it("emptying the box goes back to the envelope's own address", () => {
    const state = run([
      ...AT_DESTINATION,
      { type: "refund", value: "nonsense" },
      { type: "refundVerdict", input: "nonsense", ok: false, message: "no" },
      { type: "refund", value: "" },
    ]);
    expect(state.refundStatus).toBe("default");
    expect(canQuote(state)).toBe(true);
  });
});

/* ------------------------------- M5: a ceiling on the spread, and minAmountOut */

describe("M5: the quote has to be one worth acting on", () => {
  it("accepts a healthy spread", () => {
    expect(quoteAcceptable(QUOTE)).toEqual({ ok: true, reason: null });
  });

  it("refuses a spread over the cap, and says the number", () => {
    // 1 - 1.66/1.99 = 16.58%, which is what a floor-sized swap really costs.
    const verdict = quoteAcceptable({ ...QUOTE, amountOutUsd: "1.66" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/16\.58%/);
    expect(verdict.reason).toMatch(/15\.00%/);
  });

  it("refuses the near-total loss this exists to stop", () => {
    // The shape of a broken or hostile answer: a price that is not a price.
    expect(quoteAcceptable({ ...QUOTE, amountOut: "1", amountOutUsd: "0.0000001" }).ok).toBe(false);
  });

  it("holds the cap at the documented default", () => {
    expect(MAX_SPREAD_BPS).toBe(1500);
    // Exactly at the cap is acceptable; one basis point over is not.
    const atCap = { ...QUOTE, amountInUsd: "100", amountOutUsd: "85" };
    expect(quoteAcceptable(atCap).ok).toBe(true);
    expect(quoteAcceptable({ ...atCap, amountOutUsd: "84.99" }).ok).toBe(false);
  });

  it("refuses figures it cannot do arithmetic on, instead of showing a dash", () => {
    for (const bad of [{ amountInUsd: "" }, { amountOutUsd: "n/a" }, { amountInUsd: "0" }]) {
      const verdict = quoteAcceptable({ ...QUOTE, ...bad });
      expect(verdict.ok, JSON.stringify(bad)).toBe(false);
      expect(verdict.reason).toBe(copy.quoteUnreadable);
    }
  });

  it("enforces the rail's own minAmountOut", () => {
    const short = quoteAcceptable({ ...QUOTE, amountOut: "1652675", minAmountOut: "1652676" });
    expect(short.ok).toBe(false);
    expect(short.reason).toBe(copy.quoteShortfall);
    // Equal is fine: minAmountOut is a floor, not a strict bound.
    expect(quoteAcceptable({ ...QUOTE, amountOut: "1652676" }).ok).toBe(true);
  });

  it("refuses an amountOut that is not a number at all", () => {
    expect(quoteAcceptable({ ...QUOTE, amountOut: "" }).ok).toBe(false);
    expect(quoteAcceptable({ ...QUOTE, minAmountOut: "lots" }).ok).toBe(false);
    expect(quoteAcceptable({ ...QUOTE, amountOut: "0" }).ok).toBe(false);
  });

  it("keeps the deposit button off for a quote it refuses", () => {
    const at = (quote: OneClickQuote) =>
      run([
        ...AT_DESTINATION,
        { type: "quote", quote: { quote, quoteRequest: {} } as OneClickQuoteResponse },
      ]);
    expect(canGetDeposit(at(QUOTE), 132000n)).toBe(true);
    expect(canGetDeposit(at({ ...QUOTE, amountOutUsd: "1.66" }), 132000n)).toBe(false);
    expect(canGetDeposit(at({ ...QUOTE, amountOut: "1" }), 132000n)).toBe(false);
  });
});

/* ------------------------- M6: the deposit address and the rail's own echo */

describe("M6: the reservation is checked before anything is swept to it", () => {
  const sound = {
    depositKind: "transparent" as const,
    quoteRequest: {
      dry: false,
      amount: "132000",
      originAsset: "nep141:zec.omft.near",
      destinationAsset: USDC,
      refundTo: ENVELOPE,
      recipient: SOLANA,
    },
    asset: "usdc" as const,
    recipient: SOLANA,
    refundTo: ENVELOPE,
  };

  it("passes a transparent address with a faithful echo", () => {
    expect(checkSwapPlan(sound)).toBeNull();
  });

  it("refuses anything but a transparent address of this network", () => {
    for (const kind of ["unified_orchard", "sapling", "unified_no_orchard", "invalid"] as const) {
      expect(checkSwapPlan({ ...sound, depositKind: kind }), kind).toBe(
        copy.depositNotTransparent,
      );
    }
    // An address the core could not classify at all is not a destination either.
    expect(checkSwapPlan({ ...sound, depositKind: null })).toBe(copy.depositNotTransparent);
  });

  it("refuses a payout address that is not the one we asked for", () => {
    const swapped = {
      ...sound,
      quoteRequest: { ...sound.quoteRequest, recipient: "7Ncx1MipyrmGMD5YhGYZaHcdFN9NtcDBiKk9pBaMr2yL" },
    };
    expect(checkSwapPlan(swapped)).toMatch(/payout address/);
  });

  it("refuses a refund address that is not the one we asked for", () => {
    const swapped = { ...sound, quoteRequest: { ...sound.quoteRequest, refundTo: "u1somebodyelse" } };
    expect(checkSwapPlan(swapped)).toMatch(/refund address/);
  });

  it("refuses an asset that is not the one we asked for", () => {
    const swapped = {
      ...sound,
      quoteRequest: { ...sound.quoteRequest, destinationAsset: SOLANA_ASSETS.sol.id },
    };
    expect(checkSwapPlan(swapped)).toMatch(/asset/);
  });

  it("refuses a response that echoed nothing back at all", () => {
    expect(checkSwapPlan({ ...sound, quoteRequest: undefined })).toMatch(/quote/);
    expect(checkSwapPlan({ ...sound, quoteRequest: null })).toMatch(/quote/);
  });

  it("is not fussed by the whitespace either side of an address", () => {
    const padded = {
      ...sound,
      quoteRequest: { ...sound.quoteRequest, recipient: ` ${SOLANA} ` },
    };
    expect(checkSwapPlan(padded)).toBeNull();
  });

  it("says nothing was sent, on every refusal", () => {
    const refusals = [
      checkSwapPlan({ ...sound, depositKind: "unified_orchard" }),
      checkSwapPlan({ ...sound, quoteRequest: undefined }),
    ];
    for (const line of refusals) expect(line).toMatch(/Nothing was sent/);
  });
});

/* ---------------------- M3: a swap plan belongs to one destination only */

describe("M3: the swap's lines only show on the destination they belong to", () => {
  const plan = { reservation: {}, asset: "usdc", recipient: SOLANA, refundTo: ENVELOPE };

  it("shows them for the Solana exit with a plan", () => {
    expect(showSwapUi("solana", plan)).toBe(true);
  });

  it("hides them the moment the destination is something else", () => {
    // The M3 finding: a stale plan survived "Choose somewhere else", and the
    // review screen went on promising USDC above a button that paid a u1.
    expect(showSwapUi("address", plan)).toBe(false);
    expect(showSwapUi("wallet", plan)).toBe(false);
    expect(showSwapUi(null, plan)).toBe(false);
  });

  it("hides them when there is no plan, whatever the destination is", () => {
    expect(showSwapUi("solana", null)).toBe(false);
    expect(showSwapUi("solana", undefined)).toBe(false);
  });
});
