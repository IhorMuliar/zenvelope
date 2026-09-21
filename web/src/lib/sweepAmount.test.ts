/**
 * The M3 arithmetic: envelope minus the miner fee minus the flat Zenvelope fee.
 * Every number here is a bigint zatoshi, and the point of most of these cases is
 * that the same sum in floating point would be wrong.
 */

import { describe, expect, it } from "vitest";
import { networkFeeFor, sweepAmounts } from "./amount";
import { formatZecAmount } from "./format";
import {
  FLAT_FEE_ZAT,
  NETWORK_FEE_TRANSPARENT_ZAT,
  NETWORK_FEE_ZAT,
  SWEEP_FEE_ZAT,
  FEE_ENABLED,
} from "../config";
import { MOCK_NOTE } from "../core/mock";

describe("the network fee", () => {
  it("is 0.0001 ZEC for a shielded destination, two ZIP-317 actions", () => {
    expect(NETWORK_FEE_ZAT).toBe(10000n);
    expect(formatZecAmount(NETWORK_FEE_ZAT)).toBe("0.0001 ZEC");
    expect(networkFeeFor("unified_orchard")).toBe(10000n);
  });

  it("is 0.00015 ZEC when the destination is transparent", () => {
    expect(NETWORK_FEE_TRANSPARENT_ZAT).toBe(15000n);
    expect(formatZecAmount(NETWORK_FEE_TRANSPARENT_ZAT)).toBe("0.00015 ZEC");
    expect(networkFeeFor("transparent")).toBe(15000n);
  });
});

describe("several notes in one envelope", () => {
  it("costs nothing extra for a second note", () => {
    // Ironwood actions are max(spends, outputs), padded to two: the second note
    // rides in an action the destination and the fee output had already paid for.
    expect(networkFeeFor("unified_orchard", 1)).toBe(10000n);
    expect(networkFeeFor("unified_orchard", 2)).toBe(10000n);
  });

  it("charges one marginal fee per note beyond the second", () => {
    expect(networkFeeFor("unified_orchard", 3)).toBe(15000n);
    expect(networkFeeFor("unified_orchard", 4)).toBe(20000n);
    expect(networkFeeFor("transparent", 3)).toBe(20000n);
  });

  it("takes the fees off the summed notes once, not once per note", () => {
    const a = sweepAmounts(130000n * 2n, "unified_orchard", 0n, 2);
    expect(a.inEnvelopeZat).toBe(260000n);
    expect(a.networkFeeZat).toBe(10000n);
    expect(a.receiveZat).toBe(250000n);
    expect(a.ok).toBe(true);
  });

  it("refuses a pile of dust notes that only pay for their own actions", () => {
    // Three 5,000-zatoshi notes are worth 15,000, which is exactly the fee for
    // three actions: there would be nothing left to send.
    const a = sweepAmounts(15000n, "unified_orchard", 0n, 3);
    expect(a.networkFeeZat).toBe(15000n);
    expect(a.ok).toBe(false);
    expect(a.receiveZat).toBe(0n);
  });
});

describe("what the recipient receives", () => {
  it("takes the miner fee off the envelope", () => {
    const a = sweepAmounts(130000n, "unified_orchard", 0n);
    expect(a.receiveZat).toBe(120000n);
    expect(a.ok).toBe(true);
    expect(formatZecAmount(a.receiveZat)).toBe("0.0012 ZEC");
  });

  it("takes the flat Zenvelope fee off too, when there is one", () => {
    const a = sweepAmounts(130000n, "unified_orchard", FLAT_FEE_ZAT);
    expect(a.serviceFeeZat).toBe(30000n);
    expect(a.receiveZat).toBe(90000n);
    expect(a.inEnvelopeZat - a.networkFeeZat - a.serviceFeeZat).toBe(a.receiveZat);
  });

  it("costs more to leave the shielded pool", () => {
    const shielded = sweepAmounts(130000n, "unified_orchard", 0n);
    const transparent = sweepAmounts(130000n, "transparent", 0n);
    expect(shielded.receiveZat - transparent.receiveZat).toBe(5000n);
  });

  it("charges no fee while there is no fee address", () => {
    expect(FEE_ENABLED).toBe(false);
    expect(SWEEP_FEE_ZAT).toBe(0n);
    const a = sweepAmounts(BigInt(MOCK_NOTE.amount_zat), "unified_orchard");
    expect(a.serviceFeeZat).toBe(0n);
    expect(a.receiveZat).toBe(120000n);
  });

  it("never lets a negative fee add money", () => {
    const a = sweepAmounts(130000n, "unified_orchard", -50000n);
    expect(a.serviceFeeZat).toBe(0n);
    expect(a.receiveZat).toBe(120000n);
  });
});

describe("when the envelope is too small", () => {
  it("refuses an envelope that cannot cover the miner fee", () => {
    const a = sweepAmounts(9000n, "unified_orchard", 0n);
    expect(a.ok).toBe(false);
    expect(a.receiveZat).toBe(0n);
    expect(a.shortfallZat).toBe(1001n);
  });

  it("refuses an envelope that lands exactly on zero", () => {
    const a = sweepAmounts(10000n, "unified_orchard", 0n);
    expect(a.ok).toBe(false);
    expect(a.shortfallZat).toBe(1n);
  });

  it("accepts one zatoshi over the fee", () => {
    const a = sweepAmounts(10001n, "unified_orchard", 0n);
    expect(a.ok).toBe(true);
    expect(a.receiveZat).toBe(1n);
    expect(formatZecAmount(a.receiveZat)).toBe("0.00000001 ZEC");
  });

  it("counts the flat fee in the shortfall", () => {
    const a = sweepAmounts(30000n, "unified_orchard", FLAT_FEE_ZAT);
    expect(a.ok).toBe(false);
    expect(a.shortfallZat).toBe(10001n);
  });
});

describe("exactness", () => {
  it("holds a whole-ZEC envelope to the zatoshi", () => {
    const a = sweepAmounts(100000000n, "unified_orchard", 30000n);
    expect(a.receiveZat).toBe(99960000n);
    expect(formatZecAmount(a.receiveZat)).toBe("0.9996 ZEC");
  });

  it("handles the whole money supply without losing a zatoshi", () => {
    const big = 21000000n * 100000000n; // MAX_MONEY, in zatoshi
    const a = sweepAmounts(big, "unified_orchard", 30000n);
    expect(a.receiveZat).toBe(2099999999960000n);
    expect(formatZecAmount(a.receiveZat)).toBe("20,999,999.9996 ZEC");
    // The same sum in ZEC floats drifts; in zatoshi it cannot.
    expect(21000000 - 0.0001 - 0.0003).not.toBe(20999999.9996);
  });

  it("does the 0.1 + 0.2 sum that floating point gets wrong", () => {
    const a = sweepAmounts(30000000n, "unified_orchard", 20000000n);
    expect(a.receiveZat).toBe(9990000n);
    expect(formatZecAmount(a.receiveZat)).toBe("0.0999 ZEC");
  });
});
