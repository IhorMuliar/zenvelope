/**
 * The interface the WASM core exposes. The Rust side (web/src/wasm/core) and the
 * MOCK implementation in ./mock.ts both satisfy this.
 *
 * Everything up to M2 is pure key material and string formatting plus the scan.
 * M3 adds the spend: `warm_proving_key`, `classify_address`, `new_wallet` and
 * `sweep_envelope`. The secret stays in memory throughout: it is handed to the
 * core and to nothing else.
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
  /**
   * Which action of that transaction holds the note. M3 needs it to point the
   * spend at the right note without scanning the block again.
   */
  action_index: number;
}

/**
 * What a finished scan hands back.
 *
 * This is the object the wasm `open_envelope` resolves with, field for field:
 * see `to_js` in crates/core/src/grpc.rs.
 */
export interface OpenResult {
  found: boolean;
  notes: FoundNote[];
  /** Sum of the notes, zatoshi as a decimal string. */
  total_zat: string;
  /** Chain tip the scan reached. */
  tip_height: number;
  /** The height the scan actually started at, after defaulting and clamping. */
  birthday: number;
  /** True when the link carried no birthday and the default lookback was used. */
  birthday_defaulted: boolean;
  /** Blocks streamed: `tip_height - birthday + 1`. */
  scanned_blocks: number;
}

/**
 * Scan progress. `total` is 0 until the scanner knows how many blocks it has to
 * cover, which is what puts the progress bar in its indeterminate state.
 */
export type ProgressFn = (scanned: number, total: number) => void;

/* ----------------------------------------------------------------- M3: spend */

/**
 * What a pasted destination turns out to be.
 *
 * `unified_orchard` is the only kind that keeps the money shielded and in
 * Ironwood. `transparent` works but leaves the pool. The other two cannot
 * receive this note at all.
 */
export type AddressKind =
  | "unified_orchard"
  | "unified_no_orchard"
  | "sapling"
  | "transparent"
  | "invalid";

export interface AddressClass {
  kind: AddressKind;
  /** Why, when the core has something to add. Diagnostic, not recipient copy. */
  reason: string | null;
}

/**
 * A wallet generated in the browser for a recipient who has none. The mnemonic
 * is shown once, on screen, and is stored nowhere: not in localStorage, not in
 * a URL, not in a log.
 */
export interface NewWallet {
  /** 24 BIP-39 words, space separated. */
  mnemonic: string;
  address: string;
  ufvk: string;
  /** Height to restore from, so a restoring wallet has no history to scan. */
  birthday: number;
}

/** The stages `sweep_envelope` reports, in order. */
export type SweepStage = "witness" | "keys" | "proving" | "broadcast" | "done";

/** Called as the sweep moves from stage to stage. `detail` is a short line. */
export type StageFn = (stage: SweepStage, detail: string) => void;

/** Which note to spend: enough to find it again without scanning again. */
export interface NoteRef {
  txid: string;
  height: number;
  action_index: number;
}

/**
 * The notes a sweep spends.
 *
 * An array is the current form, and a sweep spends every note in it in one
 * transaction. A bare {@link NoteRef} is the M3 form: the core still accepts it and
 * treats it as a one-element array, for one release.
 */
export type NotesToSpend = NoteRef | NoteRef[];

/** What a finished, or failed, sweep hands back. */
export interface SweepResult {
  txid: string;
  /** The signed transaction, when `broadcast` was false. */
  raw_tx_hex: string | null;
  /** Zatoshi as a decimal string: what the destination gets. */
  amount_to_destination_zat: string;
  /** The flat Zenvelope fee actually taken. "0" when there is no fee address. */
  fee_zat: string;
  /** The ZIP-317 miner fee. */
  network_fee_zat: string;
  anchor_height: number;
  broadcast: boolean;
  /** null or 0 means success. Anything else means nothing moved. */
  error_code: number | null;
  error_message: string | null;
}

export interface ZenvelopeCore {
  derive(secret_b64url: string, network: Network): Derived;
  /** 32 bytes of CSPRNG output, base64url, 43 chars. */
  generate_secret(): string;
  /** Fragment format: `<secret>` optionally followed by `.<decimal birthday height>`. */
  parse_fragment(frag: string): ParsedFragment;
  build_fragment(secret: string, birthday?: number): string;
  /**
   * Single-output ZIP-321 URI. `memo` is the sender's text: it is carried in the
   * ZIP-321 `memo=` parameter as base64url of its UTF-8 bytes (at most 512), so
   * the sending wallet writes it into the note and it is encrypted on-chain.
   */
  payment_uri(address: string, amount_zat: ZatLike, memo?: string): string;
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
    on_progress?: ProgressFn,
  ): Promise<OpenResult>;

  /**
   * Builds the Ironwood proving key and keeps it. Resolves with the
   * milliseconds it took. Safe to call more than once: later calls return at
   * once.
   *
   * Proving is single-threaded in this milestone. Measured on a desktop the key
   * costs about 35 s and the proof about 52 s, and a slow phone is up to four
   * times that. That is why the open flow starts this in the background the
   * moment the envelope is found, so the wait overlaps with reading.
   */
  warm_proving_key(): Promise<number>;

  /** What a pasted address is, and so whether this note can be sent to it. */
  classify_address(addr: string, network: Network): AddressClass;

  /**
   * A fresh wallet for a recipient who has none. `birthday` should be the
   * current chain tip, so a restore has nothing to scan. The mnemonic it
   * returns is shown once and stored nowhere.
   */
  new_wallet(network: Network, birthday: number): NewWallet;

  /**
   * Spends **every** note in `notes` to `destination` in one transaction, with the
   * flat Zenvelope fee as a second output to `fee_address` (DECISIONS D5).
   * `fee_zat` is a decimal string, and "0" with an empty `fee_address` means no fee
   * output at all.
   *
   * `notes` is an array of {@link NoteRef}, as `open_envelope` reports them; a bare
   * object is accepted as a one-element array for one release. The same note twice
   * is refused: two spends of one note are two copies of one nullifier.
   * `amount_to_destination_zat` is the sum of the notes minus both fees, and the
   * ZIP-317 miner fee counts `max(spends, outputs)` Ironwood actions, so a second
   * note usually costs nothing extra.
   *
   * The witness, key and proving work run in this browser; the only outbound
   * traffic is gRPC-web to `lightwalletd_url`. `broadcast: false` builds and
   * signs without sending and puts the transaction in `raw_tx_hex`.
   *
   * A failure that leaves the funds untouched comes back as a resolved result
   * with `error_code` set, rather than as a rejection; the caller treats a
   * rejection as meaning the same thing.
   */
  sweep_envelope(
    secret_b64url: string,
    network: Network,
    lightwalletd_url: string,
    notes: NotesToSpend,
    destination: string,
    fee_address: string,
    fee_zat: string,
    memo: string | null,
    broadcast: boolean,
    on_stage: StageFn,
  ): Promise<SweepResult>;
}

/**
 * A core as it is implemented: synchronously, in whichever thread holds the wasm.
 * The MOCK satisfies this too. From M4 this shape lives only inside the core worker.
 */
export interface SyncCore extends ZenvelopeCore {
  /** true when no WASM build was found and the MOCK is in use. */
  isMock: boolean;
}

/** Which wasm package answered. `mock` means no build was found at all. */
export type CoreBackend = "threads" | "single" | "mock";

/** What loading the core reports back: the footer note is drawn from this. */
export interface CoreInfo {
  backend: CoreBackend;
  isMock: boolean;
  /**
   * Threads in the proving pool, as `rayon::current_num_threads()` reports it once the
   * pool is up — measured, not asked for. 1 on the single-threaded package.
   */
  threads: number;
  /** Why the threaded package was not used, when it was not. Diagnostic, not copy. */
  reason: string | null;
}

/**
 * Every method of {@link ZenvelopeCore} as the page sees it from M4 on: the core runs
 * in a Web Worker, so every call is a message round trip and therefore a promise. The
 * callbacks keep their place in the argument list; the client strips them before
 * posting and the worker forwards their calls back as messages.
 */
export type AsyncCore = {
  [K in keyof ZenvelopeCore]: ZenvelopeCore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** What `loadCore()` hands the pages. */
export interface LoadedCore extends AsyncCore, CoreInfo {}

/** Normalises whatever the WASM boundary returns into a bigint. */
export function toZat(v: ZatLike): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("zat amount is not a safe integer");
    return BigInt(v);
  }
  return BigInt(v.trim());
}
