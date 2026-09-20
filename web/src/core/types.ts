/**
 * The interface the WASM core exposes. The Rust side (web/src/wasm/core) and the
 * MOCK implementation in ./mock.ts both satisfy this.
 *
 * Nothing here ever touches the network or storage: it is pure key material and
 * string formatting. The secret stays in memory.
 */

export type Network = "main" | "test";

export interface Derived {
  /** Unified address with an Ironwood-receiving Orchard receiver. */
  address: string;
  /** Unified full viewing key, used by the open flow to find the note. */
  ufvk: string;
  diversifier_index: number;
}

export interface ParsedFragment {
  /** 32 random bytes, base64url, 43 chars. */
  secret: string;
  /** Chain height at creation, so the open flow knows where to start scanning. */
  birthday?: number;
}

/** A zatoshi amount. The WASM boundary may hand back a string instead of a bigint. */
export type ZatLike = bigint | string | number;

export interface ZenvelopeCore {
  derive(secret_b64url: string, network: Network): Derived;
  /** 32 bytes of CSPRNG output, base64url, 43 chars. */
  generate_secret(): string;
  /** Fragment format: `<secret>` optionally followed by `.<decimal birthday height>`. */
  parse_fragment(frag: string): ParsedFragment;
  build_fragment(secret: string, birthday?: number): string;
  /** Single-output ZIP-321 URI. */
  payment_uri(address: string, amount_zat: ZatLike, message?: string): string;
  zat_to_zec_string(zat: ZatLike): string;
  zec_string_to_zat(s: string): ZatLike;
}

export interface LoadedCore extends ZenvelopeCore {
  /** true when no WASM build was found and the MOCK is in use. */
  isMock: boolean;
}

/** Normalises whatever the WASM boundary returns into a bigint. */
export function toZat(v: ZatLike): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("zat amount is not a safe integer");
    return BigInt(v);
  }
  return BigInt(v.trim());
}
