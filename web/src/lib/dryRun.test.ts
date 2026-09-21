import { describe, expect, it } from "vitest";
import { DRY_RUN_COPY, isDryRun, rawTxBytes } from "./dryRun";

describe("isDryRun", () => {
  it("is on for ?dry=1 and nothing else", () => {
    expect(isDryRun("?dry=1")).toBe(true);
    expect(isDryRun("dry=1")).toBe(true);
    expect(isDryRun("?net=main&dry=1")).toBe(true);
  });

  it("is off by default and for any other value", () => {
    expect(isDryRun("")).toBe(false);
    expect(isDryRun("?dry=0")).toBe(false);
    expect(isDryRun("?dry")).toBe(false);
    expect(isDryRun("?dry=true")).toBe(false);
    expect(isDryRun("?net=test")).toBe(false);
  });

  /**
   * The flag is a query-string flag. A fragment that happens to contain the text
   * must never switch it on: `window.location.search` stops at the `#`, and this
   * is the regression test for anyone who reaches for `location.href` instead.
   */
  it("ignores anything in the fragment", () => {
    const fragment = "#AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.3490437?dry=1";
    expect(isDryRun(new URL(`https://x.test/e${fragment}`).search)).toBe(false);
    expect(isDryRun(new URL("https://x.test/e?dry=1" + fragment).search)).toBe(true);
  });
});

describe("the copy", () => {
  it("says what happened, without promising that anything moved", () => {
    expect(DRY_RUN_COPY).toBe("Dry run: transaction built and proved, not sent");
    expect(DRY_RUN_COPY.toLowerCase()).not.toContain("claim");
    expect(DRY_RUN_COPY.toLowerCase()).not.toContain("sent.");
  });
});

describe("rawTxBytes", () => {
  it("counts two hex characters as one byte", () => {
    expect(rawTxBytes("00".repeat(9166))).toBe(9166);
    expect(rawTxBytes("deadbeef")).toBe(4);
  });

  it("is zero when there is no transaction to measure", () => {
    expect(rawTxBytes(null)).toBe(0);
    expect(rawTxBytes(undefined)).toBe(0);
    expect(rawTxBytes("   ")).toBe(0);
  });
});
