/**
 * Core loader.
 *
 * Dynamically imports the wasm-bindgen glue that `scripts/build-core.sh` writes to
 * web/src/wasm/core/zenvelope_core.js and calls its default() init. That build is
 * gitignored, so a checkout without it falls back to the MOCK implementation and the
 * UI shows a MOCK badge.
 *
 * The fallback is for a *missing* build only. A build that is present but fails to
 * load is a real bug, and it throws rather than quietly handing back fake addresses.
 *
 * import.meta.glob is used rather than a bare dynamic import so that a missing file
 * is an empty map at build time instead of a build error.
 */

import type {
  AddressClass,
  Derived,
  LoadedCore,
  Network,
  NewWallet,
  NoteRef,
  OpenResult,
  ParsedFragment,
  ProgressFn,
  StageFn,
  SweepResult,
  ZatLike,
} from "./types";
import { mockCore } from "./mock";

const WASM_ENTRY = "../wasm/core/zenvelope_core.js";
const wasmModules = import.meta.glob("../wasm/core/*.js") as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

let cached: Promise<LoadedCore> | null = null;

const REQUIRED = [
  "derive",
  "generate_secret",
  "parse_fragment",
  "build_fragment",
  "payment_uri",
  "zat_to_zec_string",
  "zec_string_to_zat",
  "open_envelope",
  // M3: the spend.
  "warm_proving_key",
  "classify_address",
  "new_wallet",
  "sweep_envelope",
] as const;

/**
 * The wasm exports that return structs hand back wasm-bindgen objects whose fields
 * are getters and whose memory has to be released. Everything past this module sees
 * plain, already-freed JS objects.
 */
interface Disposable {
  free(): void;
}

/**
 * Copies the named fields off a wasm-bindgen object and frees it. A plain JS object
 * (which is what the MOCK and some `serde_wasm_bindgen` returns are) has no `free`,
 * so the call is optional.
 */
function take<T extends object>(v: T & Partial<Disposable>, keys: readonly (keyof T)[]): T {
  try {
    const out = {} as T;
    for (const k of keys) out[k] = v[k];
    return out;
  } finally {
    if (typeof v.free === "function") v.free();
  }
}

function takeDerived(v: Derived & Partial<Disposable>): Derived {
  return take(v, ["address", "ufvk", "diversifier_index"]);
}

function takeFragment(v: ParsedFragment & Partial<Disposable>): ParsedFragment {
  try {
    const birthday = v.birthday;
    return birthday === undefined || birthday === null
      ? { secret: v.secret }
      : { secret: v.secret, birthday };
  } finally {
    if (typeof v.free === "function") v.free();
  }
}

function takeAddressClass(v: AddressClass & Partial<Disposable>): AddressClass {
  try {
    return { kind: v.kind, reason: v.reason ?? null };
  } finally {
    if (typeof v.free === "function") v.free();
  }
}

function takeWallet(v: NewWallet & Partial<Disposable>): NewWallet {
  return take(v, ["mnemonic", "address", "ufvk", "birthday"]);
}

function takeSweep(v: SweepResult & Partial<Disposable>): SweepResult {
  try {
    return {
      txid: v.txid,
      raw_tx_hex: v.raw_tx_hex ?? null,
      amount_to_destination_zat: v.amount_to_destination_zat,
      fee_zat: v.fee_zat,
      network_fee_zat: v.network_fee_zat,
      anchor_height: v.anchor_height,
      broadcast: v.broadcast,
      error_code: v.error_code ?? null,
      error_message: v.error_message ?? null,
    };
  } finally {
    if (typeof v.free === "function") v.free();
  }
}

interface WasmModule {
  derive(secret: string, network: Network): Derived & Disposable;
  generate_secret(): string;
  parse_fragment(frag: string): ParsedFragment & Disposable;
  build_fragment(secret: string, birthday?: number): string;
  payment_uri(address: string, amount_zat: ZatLike, memo?: string): string;
  zat_to_zec_string(zat: ZatLike): string;
  zec_string_to_zat(s: string): ZatLike;
  open_envelope(
    secret_b64url: string,
    birthday: number | undefined,
    network: Network,
    lightwalletd_url: string,
    on_progress?: ProgressFn,
  ): Promise<OpenResult>;
  warm_proving_key(): Promise<number>;
  classify_address(addr: string, network: Network): AddressClass & Disposable;
  new_wallet(network: Network, birthday: number): NewWallet & Disposable;
  sweep_envelope(
    secret_b64url: string,
    network: Network,
    lightwalletd_url: string,
    note: NoteRef,
    destination: string,
    fee_address: string,
    fee_zat: string,
    memo: string | null,
    broadcast: boolean,
    on_stage: StageFn,
  ): Promise<SweepResult & Disposable>;
}

async function load(): Promise<LoadedCore> {
  const entry = wasmModules[WASM_ENTRY];
  if (!entry) {
    console.warn(
      `no wasm core at ${WASM_ENTRY}, using the MOCK core. Run ./scripts/build-core.sh.`,
    );
    return mockCore;
  }

  const mod = await entry();
  const init = mod.default;
  if (typeof init !== "function") {
    throw new Error("wasm core has no default init() export");
  }
  await (init as () => Promise<unknown>)();
  for (const fn of REQUIRED) {
    if (typeof mod[fn] !== "function") {
      throw new Error(`wasm core is missing ${fn}()`);
    }
  }

  const core = mod as unknown as WasmModule;
  return {
    isMock: false,
    derive: (secret, network) => takeDerived(core.derive(secret, network)),
    generate_secret: () => core.generate_secret(),
    parse_fragment: (frag) => takeFragment(core.parse_fragment(frag)),
    // build_fragment's second argument is Option<u32>: pass undefined, never null.
    build_fragment: (secret, birthday) =>
      birthday === undefined || birthday === null
        ? core.build_fragment(secret)
        : core.build_fragment(secret, birthday),
    // The third argument is Option<String> on the Rust side: pass the memo only
    // when there is one, never an empty string and never null.
    payment_uri: (address, amount, memo) =>
      memo === undefined || memo === ""
        ? core.payment_uri(address, amount)
        : core.payment_uri(address, amount, memo),
    zat_to_zec_string: (zat) => core.zat_to_zec_string(zat),
    zec_string_to_zat: (s) => core.zec_string_to_zat(s),
    // The scan is the one call that touches the network. The secret is passed
    // straight through to WASM and is never copied anywhere else.
    open_envelope: (secret, birthday, network, url, onProgress) =>
      core.open_envelope(secret, birthday, network, url, onProgress),
    warm_proving_key: () => core.warm_proving_key(),
    classify_address: (addr, network) => takeAddressClass(core.classify_address(addr, network)),
    new_wallet: (network, birthday) => takeWallet(core.new_wallet(network, birthday)),
    // The spend. Same rule as the scan: the secret goes to WASM and nowhere else.
    sweep_envelope: async (
      secret,
      network,
      url,
      note,
      destination,
      feeAddress,
      feeZat,
      memo,
      broadcast,
      onStage,
    ) =>
      takeSweep(
        await core.sweep_envelope(
          secret,
          network,
          url,
          note,
          destination,
          feeAddress,
          feeZat,
          memo,
          broadcast,
          onStage,
        ),
      ),
  };
}

export function loadCore(): Promise<LoadedCore> {
  if (!cached) cached = load();
  return cached;
}

export type { LoadedCore, ZenvelopeCore } from "./types";
