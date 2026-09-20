import { describe, expect, it } from "vitest";
import {
  EMPTY_REQUEST_FRAME,
  decodeFrames,
  encodeFrame,
  parseBlockId,
  parseGetLatestBlockResponse,
  readVarint,
} from "./grpcweb";

function hex(s: string): Uint8Array {
  return new Uint8Array(s.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Hand-built capture of a GetLatestBlock response.
 *
 *   00                data frame
 *   00 00 00 27       39 payload bytes
 *   08 e0 84 d5 01    field 1 (height), varint 3490400
 *                     3490400 = 0xD5 0x84 0xE0 in base-128 groups, low group first:
 *                     3490400 = ((1*128 + 85)*128 + 4)*128 + 96
 *   12 20 <32 bytes>  field 2 (hash), length-delimited
 *   80                trailer frame
 *   00 00 00 0f       15 bytes: "grpc-status:0\r\n"
 */
const HASH_HEX = "00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8090a1b2c3d4e5f6";
const RESPONSE = hex(
  "00 00000027 08e084d501 1220" +
    HASH_HEX +
    " 80 0000000f " +
    [..."grpc-status:0\r\n"].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
);

describe("readVarint", () => {
  it("reads single-byte values", () => {
    expect(readVarint(hex("00"))).toEqual({ value: 0n, next: 1 });
    expect(readVarint(hex("7f"))).toEqual({ value: 127n, next: 1 });
  });

  it("reads multi-byte values", () => {
    expect(readVarint(hex("8001")).value).toBe(128n);
    expect(readVarint(hex("ac02")).value).toBe(300n);
    expect(readVarint(hex("e084d501")).value).toBe(3490400n);
  });

  it("reads from an offset and reports where it stopped", () => {
    const r = readVarint(hex("08e084d501"), 1);
    expect(r.value).toBe(3490400n);
    expect(r.next).toBe(5);
  });

  it("handles values beyond 2^32", () => {
    expect(readVarint(hex("ffffffffffffffff7f")).value).toBe(2n ** 63n - 1n);
  });

  it("throws on a truncated varint", () => {
    expect(() => readVarint(hex("e084d5"))).toThrow(/truncated/);
  });
});

describe("frames", () => {
  it("encodes an empty request as 00 00 00 00 00", () => {
    expect(Array.from(encodeFrame(new Uint8Array(0)))).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(EMPTY_REQUEST_FRAME)).toEqual([0, 0, 0, 0, 0]);
  });

  it("writes a big-endian length", () => {
    const f = encodeFrame(new Uint8Array(258));
    expect(Array.from(f.subarray(0, 5))).toEqual([0, 0, 0, 1, 2]);
  });

  it("splits a body into data and trailer frames", () => {
    const frames = decodeFrames(RESPONSE);
    expect(frames).toHaveLength(2);
    expect(frames[0].flag).toBe(0x00);
    expect(frames[0].payload).toHaveLength(39);
    expect(frames[1].flag).toBe(0x80);
    expect(new TextDecoder().decode(frames[1].payload)).toBe("grpc-status:0\r\n");
  });

  it("throws on a truncated frame", () => {
    expect(() => decodeFrames(hex("00 000000ff 0801"))).toThrow(/truncated/);
  });
});

describe("parseBlockId", () => {
  it("parses height and hash from the fixture", () => {
    const block = parseGetLatestBlockResponse(RESPONSE);
    expect(block.height).toBe(3490400);
    expect(toHex(block.hash)).toBe(HASH_HEX);
  });

  it("parses a height-only message", () => {
    expect(parseBlockId(hex("08e084d501")).height).toBe(3490400);
  });

  it("skips unknown fields", () => {
    // field 7 varint, then the height, then field 5 fixed32
    expect(parseBlockId(hex("3807 08e084d501 2d01020304")).height).toBe(3490400);
  });

  it("returns height 0 for an empty message", () => {
    expect(parseBlockId(new Uint8Array(0)).height).toBe(0);
  });
});
