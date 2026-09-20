import { describe, expect, it } from "vitest";
import { base64UrlToBytes, memoToBase64Url, mockCore } from "./mock";
import { memoByteLength } from "../lib/format";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // 43 base64url chars

describe("generate_secret", () => {
  it("is 32 bytes as 43 base64url chars", () => {
    for (let i = 0; i < 20; i++) {
      const s = mockCore.generate_secret();
      expect(s).toHaveLength(43);
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mockCore.generate_secret()));
    expect(seen.size).toBe(200);
  });
});

describe("fragments", () => {
  it("builds without a birthday", () => {
    expect(mockCore.build_fragment(SECRET)).toBe(SECRET);
  });

  it("builds with a birthday", () => {
    expect(mockCore.build_fragment(SECRET, 3490400)).toBe(`${SECRET}.3490400`);
  });

  it("round-trips with a birthday", () => {
    const frag = mockCore.build_fragment(SECRET, 3490400);
    expect(mockCore.parse_fragment(frag)).toEqual({ secret: SECRET, birthday: 3490400 });
  });

  it("round-trips without a birthday", () => {
    expect(mockCore.parse_fragment(SECRET)).toEqual({ secret: SECRET });
  });

  it("tolerates a leading #", () => {
    expect(mockCore.parse_fragment(`#${SECRET}.1`).birthday).toBe(1);
  });

  it("rejects a malformed fragment", () => {
    for (const bad of ["", "#", "short", `${SECRET}.`, `${SECRET}.abc`, `${SECRET}x`, `${SECRET}.1.2`]) {
      expect(() => mockCore.parse_fragment(bad), bad).toThrow();
    }
  });

  it("refuses to build from a bad secret or a negative birthday", () => {
    expect(() => mockCore.build_fragment("nope")).toThrow();
    expect(() => mockCore.build_fragment(SECRET, -1)).toThrow();
  });
});

describe("derive", () => {
  it("is deterministic and network-tagged", () => {
    const a = mockCore.derive(SECRET, "main");
    const b = mockCore.derive(SECRET, "main");
    expect(a).toEqual(b);
    expect(a.address.startsWith("u1mock")).toBe(true);
    expect(a.ufvk.startsWith("uview1mock")).toBe(true);
    expect(a.diversifier_index).toBe(0);
    expect(mockCore.derive(SECRET, "test").address.startsWith("utest1mock")).toBe(true);
    expect(mockCore.derive(SECRET, "test").address).not.toBe(a.address);
  });

  it("differs per secret", () => {
    const other = mockCore.generate_secret();
    expect(mockCore.derive(other, "main").address).not.toBe(
      mockCore.derive(SECRET, "main").address,
    );
  });
});

describe("zat and ZEC strings", () => {
  it("formats zatoshi", () => {
    expect(mockCore.zat_to_zec_string(0n)).toBe("0");
    expect(mockCore.zat_to_zec_string(1n)).toBe("0.00000001");
    expect(mockCore.zat_to_zec_string(30000n)).toBe("0.0003");
    expect(mockCore.zat_to_zec_string(1030000n)).toBe("0.0103");
    expect(mockCore.zat_to_zec_string(100000000n)).toBe("1");
    expect(mockCore.zat_to_zec_string("2099999999999999")).toBe("20999999.99999999");
  });

  it("parses ZEC strings", () => {
    expect(mockCore.zec_string_to_zat("0.0103")).toBe(1030000n);
    expect(mockCore.zec_string_to_zat("1")).toBe(100000000n);
    expect(() => mockCore.zec_string_to_zat("0.123456789")).toThrow();
    expect(() => mockCore.zec_string_to_zat("abc")).toThrow();
  });
});

describe("payment_uri", () => {
  const addr = mockCore.derive(SECRET, "main").address;

  it("is a single-output ZIP-321 URI", () => {
    const uri = mockCore.payment_uri(addr, 1030000n);
    expect(uri).toBe(`zcash:${addr}?amount=0.0103`);
    // single output: no paramindex suffixes anywhere
    expect(uri).not.toMatch(/\.\d+=/);
    expect(uri.match(/amount=/g)).toHaveLength(1);
  });

  it("carries the message as a base64url memo, not a message", () => {
    const text = "Happy birthday & thanks";
    const uri = mockCore.payment_uri(addr, 1030000n, text);
    expect(uri).toBe(`zcash:${addr}?amount=0.0103&memo=${memoToBase64Url(text)}`);
    // A ZIP-321 message never reaches the chain, so it is not offered at all.
    expect(uri).not.toContain("message=");
    // base64url without padding: no '+', no '/', no '='.
    const param = uri.split("&memo=")[1];
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    // And it decodes back to what the sender typed.
    expect(new TextDecoder().decode(base64UrlToBytes(param))).toBe(text);
  });

  it("counts the memo in UTF-8 bytes and rejects an over-long one", () => {
    expect(memoByteLength("🎁")).toBe(4);
    expect(() => mockCore.payment_uri(addr, 1030000n, "a".repeat(512))).not.toThrow();
    expect(() => mockCore.payment_uri(addr, 1030000n, "a".repeat(513))).toThrow();
    expect(() => mockCore.payment_uri(addr, 1030000n, "🎁".repeat(129))).toThrow();
  });

  it("omits an empty message", () => {
    expect(mockCore.payment_uri(addr, 1030000n, "")).toBe(`zcash:${addr}?amount=0.0103`);
  });

  it("accepts a zat amount handed back from wasm as a string", () => {
    expect(mockCore.payment_uri(addr, "1030000")).toBe(`zcash:${addr}?amount=0.0103`);
  });
});
