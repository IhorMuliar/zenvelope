import { describe, expect, it } from "vitest";
import { breakdownLines, feeBreakdown, validateAmount } from "./amount";
import { FLAT_FEE_ZAT } from "../config";

describe("validateAmount", () => {
  it("accepts a plain amount", () => {
    const r = validateAmount("0.01");
    expect(r).toEqual({ ok: true, zat: 1000000n });
  });

  it("accepts exactly 8 decimal places", () => {
    const r = validateAmount("1.23456789");
    expect(r.ok && r.zat).toBe(123456789n);
  });

  it("accepts the minimum", () => {
    const r = validateAmount("0.0001");
    expect(r.ok && r.zat).toBe(10000n);
  });

  it("trims surrounding whitespace", () => {
    const r = validateAmount("  0.5 ");
    expect(r.ok && r.zat).toBe(50000000n);
  });

  it("rejects an empty amount", () => {
    expect(validateAmount("")).toEqual({ ok: false, error: "Enter an amount in ZEC." });
  });

  it("rejects 9 decimal places", () => {
    const r = validateAmount("0.123456789");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/8 decimal places/);
  });

  it("rejects below the minimum", () => {
    const r = validateAmount("0.00009999");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/0.0001 ZEC/);
  });

  it("rejects zero", () => {
    expect(validateAmount("0").ok).toBe(false);
    expect(validateAmount("0.00000000").ok).toBe(false);
  });

  it("rejects negatives, letters and junk", () => {
    for (const bad of ["-1", "abc", "1,5", "1.2.3", "0x10", "1e8", "."]) {
      expect(validateAmount(bad).ok, bad).toBe(false);
    }
  });

  it("does not lose precision on large amounts", () => {
    const r = validateAmount("20999999.99999999");
    expect(r.ok && r.zat).toBe(2099999999999999n);
  });
});

describe("feeBreakdown", () => {
  it("adds the flat fee in zatoshi", () => {
    const b = feeBreakdown(1000000n);
    expect(b.feeZat).toBe(30000n);
    expect(b.feeZat).toBe(FLAT_FEE_ZAT);
    expect(b.totalZat).toBe(1030000n);
    expect(b.envelope).toBe("0.01");
    expect(b.fee).toBe("0.0003");
    expect(b.total).toBe("0.0103");
  });

  it("asks the sender for 0.0013 ZEC for a 0.001 envelope", () => {
    const b = feeBreakdown(100000n);
    expect(b.total).toBe("0.0013");
    expect(breakdownLines(b)).toEqual([
      "Envelope 0.001 ZEC + service fee 0.0003 ZEC",
      "= 0.0013 ZEC",
    ]);
  });

  it("formats whole ZEC without a decimal part", () => {
    const b = feeBreakdown(100000000n);
    expect(b.envelope).toBe("1");
    expect(b.total).toBe("1.0003");
  });

  it("stays exact where floating point would not", () => {
    const b = feeBreakdown(10000n);
    expect(b.totalZat).toBe(40000n);
    expect(b.total).toBe("0.0004");
  });

  it("renders the two-line breakdown", () => {
    const lines = breakdownLines(feeBreakdown(1000000n));
    expect(lines).toEqual(["Envelope 0.01 ZEC + service fee 0.0003 ZEC", "= 0.0103 ZEC"]);
    expect(lines.join(" ")).toBe("Envelope 0.01 ZEC + service fee 0.0003 ZEC = 0.0103 ZEC");
  });
});
