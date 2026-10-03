import { describe, expect, it } from "vitest";
import { guilloche, hash32, seedForAddress, serialFor } from "./guilloche";

describe("the note pattern", () => {
  it("is the same for the same seed, and cached", () => {
    const a = guilloche("address:u1abc");
    expect(guilloche("address:u1abc")).toBe(a);
    expect(a.paths.length).toBeGreaterThan(20);
  });

  it("differs between envelopes", () => {
    expect(guilloche("address:u1abc").paths[0].d).not.toEqual(guilloche("address:u1abd").paths[0].d);
  });

  it("prints a serial in two groups of four hex digits", () => {
    expect(serialFor("address:u1abc")).toMatch(/^ZV [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(serialFor("address:u1abc")).toEqual(serialFor("address:u1abc"));
  });

  it("is seeded from the public address, never from anything else", () => {
    expect(seedForAddress("u1xyz")).toBe("address:u1xyz");
    expect(hash32("")).toBe(2166136261);
  });
});
