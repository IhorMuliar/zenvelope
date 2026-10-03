import { describe, expect, it } from "vitest";
import { composeMemo, parseMemo } from "./memo";
import { memoByteLength } from "./format";

describe("composeMemo", () => {
  it("leaves a message alone when there is no name", () => {
    expect(composeMemo("  Happy birthday ", "")).toBe("Happy birthday");
    expect(composeMemo("", "   ")).toBe("");
  });

  it("adds the From line after a blank line", () => {
    expect(composeMemo("Happy birthday", "Ihor")).toBe("Happy birthday\n\nFrom Ihor");
  });

  it("is just the From line when there is no message", () => {
    expect(composeMemo("", " Ihor  M. ")).toBe("From Ihor M.");
  });

  it("counts the From line against the byte limit", () => {
    expect(memoByteLength(composeMemo("hi", "Ann"))).toBe("hi\n\nFrom Ann".length);
  });
});

describe("parseMemo", () => {
  it("round-trips what composeMemo writes", () => {
    expect(parseMemo(composeMemo("Coffee is on me.", "Ihor"))).toEqual({
      from: "Ihor",
      note: "Coffee is on me.",
    });
    expect(parseMemo(composeMemo("", "Ihor"))).toEqual({ from: "Ihor", note: null });
  });

  it("leaves an old memo as it was", () => {
    expect(parseMemo("Zenvelope M1")).toEqual({ from: null, note: "Zenvelope M1" });
    expect(parseMemo(null)).toEqual({ from: null, note: null });
    expect(parseMemo("   ")).toEqual({ from: null, note: null });
  });

  it("does not take a From in the middle of a line or without a blank line", () => {
    expect(parseMemo("A gift From Ann")).toEqual({ from: null, note: "A gift From Ann" });
    expect(parseMemo("Hello\nFrom Ann")).toEqual({ from: null, note: "Hello\nFrom Ann" });
  });

  it("tolerates trailing whitespace from a wallet", () => {
    expect(parseMemo("Hi\n\nFrom Ann  \n")).toEqual({ from: "Ann", note: "Hi" });
  });
});
