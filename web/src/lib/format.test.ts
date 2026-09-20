import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatZec,
  formatZecAmount,
  groupThousands,
  poolLabel,
  sumZat,
  truncateTxid,
} from "./format";

describe("formatZec", () => {
  it("keeps at least one decimal place", () => {
    expect(formatZec(0n)).toBe("0.0");
    expect(formatZec(100000000n)).toBe("1.0");
    expect(formatZec(250000000n)).toBe("2.5");
  });

  it("trims trailing zeros", () => {
    expect(formatZec(130000n)).toBe("0.0013");
    expect(formatZec(1030000n)).toBe("0.0103");
    expect(formatZec(10000n)).toBe("0.0001");
    expect(formatZec(123400000n)).toBe("1.234");
  });

  it("keeps all eight decimals when they are significant", () => {
    expect(formatZec(1n)).toBe("0.00000001");
    expect(formatZec(123456789n)).toBe("1.23456789");
  });

  it("groups the whole part in threes", () => {
    expect(formatZec(100000000000n)).toBe("1,000.0");
    expect(formatZec(1234567800000000n)).toBe("12,345,678.0");
    expect(formatZec(2099999999999999n)).toBe("20,999,999.99999999");
  });

  it("does not group below a thousand", () => {
    expect(formatZec(99900000000n)).toBe("999.0");
  });

  it("carries a sign without losing the grouping", () => {
    expect(formatZec(-130000n)).toBe("-0.0013");
    expect(formatZec(-100000000000n)).toBe("-1,000.0");
  });

  it("appends the unit as one string", () => {
    expect(formatZecAmount(130000n)).toBe("0.0013 ZEC");
    expect(formatZecAmount(100000000n)).toBe("1.0 ZEC");
  });
});

describe("groupThousands", () => {
  it("groups from the right", () => {
    expect(groupThousands("1")).toBe("1");
    expect(groupThousands("123")).toBe("123");
    expect(groupThousands("1234")).toBe("1,234");
    expect(groupThousands("1234567")).toBe("1,234,567");
  });
});

describe("formatCount", () => {
  it("groups block numbers", () => {
    expect(formatCount(12340)).toBe("12,340");
    expect(formatCount(12400)).toBe("12,400");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(3490472)).toBe("3,490,472");
  });

  it("never shows a negative or fractional count", () => {
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(9.7)).toBe("9");
  });
});

describe("truncateTxid", () => {
  const txid = "0b7e2a1c9d4f6835e1a0c72b5d9f4e6183a7c02d5be914f7308cd62a1f4b8e57";

  it("keeps both ends", () => {
    expect(truncateTxid(txid)).toBe("0b7e2a1c…1f4b8e57");
  });

  it("leaves a short id alone", () => {
    expect(truncateTxid("abcd")).toBe("abcd");
  });
});

describe("poolLabel", () => {
  it("names the pool in recipient words", () => {
    expect(poolLabel("ironwood")).toBe("shielded (Ironwood)");
    expect(poolLabel("orchard")).toBe("shielded (Orchard)");
    expect(poolLabel("sapling")).toBe("shielded (Sapling)");
  });
});

describe("sumZat", () => {
  it("adds decimal strings from the wasm boundary as bigints", () => {
    expect(sumZat(["130000", "70000"])).toBe(200000n);
    expect(sumZat([])).toBe(0n);
    expect(sumZat(["2099999999999999", "1"])).toBe(2100000000000000n);
  });
});
