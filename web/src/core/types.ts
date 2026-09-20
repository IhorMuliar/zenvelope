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

/**
 * Which shielded pool a found note sits in. Ironwood is what we send to
 * (DECISIONS D2); the other two can only turn up on an envelope funded by an
 * older wallet.
 */
export type Pool = "ironwood" | "orchard" | "sapling";

/** One note found at the envelope address. */
export interface FoundNote {
  /** Zatoshi, as a decimal string: the WASM boundary does not carry u64 safely. */
  amount_zat: string;
  /** The sender's message, decrypted from the note memo. null when the memo is empty. */
  memo: string | null;
  height: number;
  txid: string;
  pool: Pool;
}

/** What a finished scan hands back. */
export interface OpenResult {
  found: boolean;
  notes: FoundNote[];
  /** Sum of the notes, zatoshi as a decimal string. */
  total_zat: string;
  /** Chain tip the scan reached. */
  tip_height: number;
}

/**
 * Scan progress. `total` is 0 until the scanner knows how many blocks it has to
 * cover, which is what puts the progress bar in its indeterminate state.
 */
export type ProgressFn = (scanned: number, total: number) => void;

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
  /**
   * Scans the chain for notes sent to the address derived from `secret_b64url`
   * and decrypts them. Runs entirely in the browser: the secret never leaves it,
   * and the only outbound traffic is gRPC-web to `lightwalletd_url`.
   *
   * `birthday` is the height the link was created at, so the scan can start
   * there; undefined means scan from the pool activation height. `on_progress`
   * is called as blocks are scanned. Throws if the light client is unreachable.
   */
  open_envelope(
    secret_b64url: string,
    birthday: number | undefined,
    network: Network,
    lightwalletd_url: string,
    on_progress: ProgressFn,
  ): Promise<OpenResult>;
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
