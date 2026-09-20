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

import type { Derived, LoadedCore, Network, ParsedFragment, ZatLike } from "./types";
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
] as const;

/**
 * The wasm exports for derive() and parse_fragment() return wasm-bindgen objects whose
 * fields are getters and whose memory has to be released. Everything past this module
 * sees plain, already-freed JS objects.
 */
interface Disposable {
  free(): void;
}

function takeDerived(v: Derived & Disposable): Derived {
  try {
    return {
      address: v.address,
      ufvk: v.ufvk,
      diversifier_index: v.diversifier_index,
    };
  } finally {
    v.free();
  }
}

function takeFragment(v: ParsedFragment & Disposable): ParsedFragment {
  try {
    const birthday = v.birthday;
    return birthday === undefined || birthday === null
      ? { secret: v.secret }
      : { secret: v.secret, birthday };
  } finally {
    v.free();
  }
}

interface WasmModule {
  derive(secret: string, network: Network): Derived & Disposable;
  generate_secret(): string;
  parse_fragment(frag: string): ParsedFragment & Disposable;
  build_fragment(secret: string, birthday?: number): string;
  payment_uri(address: string, amount_zat: ZatLike, message?: string): string;
  zat_to_zec_string(zat: ZatLike): string;
  zec_string_to_zat(s: string): ZatLike;
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
    payment_uri: (address, amount, message) =>
      message === undefined || message === ""
        ? core.payment_uri(address, amount)
        : core.payment_uri(address, amount, message),
    zat_to_zec_string: (zat) => core.zat_to_zec_string(zat),
    zec_string_to_zat: (s) => core.zec_string_to_zat(s),
  };
}

export function loadCore(): Promise<LoadedCore> {
  if (!cached) cached = load();
  return cached;
}

export type { LoadedCore, ZenvelopeCore } from "./types";
