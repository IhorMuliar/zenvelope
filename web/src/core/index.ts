/**
 * Core loader.
 *
 * Dynamically imports the WASM glue at ../wasm/core/core.js and calls its
 * default() init. If that build is not present (it is produced by the Rust
 * crate and is gitignored until M1's core lands), we fall back to the MOCK
 * implementation so the UI stays testable.
 *
 * import.meta.glob is used rather than a bare dynamic import so that a missing
 * file is an empty map at build time instead of a build error.
 */

import type { LoadedCore, ZenvelopeCore } from "./types";
import { mockCore } from "./mock";

const WASM_ENTRY = "../wasm/core/core.js";
const wasmModules = import.meta.glob("../wasm/core/*.js") as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

let cached: Promise<LoadedCore> | null = null;

const REQUIRED: (keyof ZenvelopeCore)[] = [
  "derive",
  "generate_secret",
  "parse_fragment",
  "build_fragment",
  "payment_uri",
  "zat_to_zec_string",
  "zec_string_to_zat",
];

async function load(): Promise<LoadedCore> {
  const entry = wasmModules[WASM_ENTRY];
  if (!entry) return mockCore;
  try {
    const mod = await entry();
    const init = mod.default;
    if (typeof init === "function") await (init as () => Promise<unknown>)();
    for (const fn of REQUIRED) {
      if (typeof mod[fn] !== "function") {
        throw new Error(`wasm core is missing ${fn}()`);
      }
    }
    const core = mod as unknown as ZenvelopeCore;
    return {
      isMock: false,
      derive: core.derive.bind(core),
      generate_secret: core.generate_secret.bind(core),
      parse_fragment: core.parse_fragment.bind(core),
      build_fragment: core.build_fragment.bind(core),
      payment_uri: core.payment_uri.bind(core),
      zat_to_zec_string: core.zat_to_zec_string.bind(core),
      zec_string_to_zat: core.zec_string_to_zat.bind(core),
    };
  } catch (err) {
    // Never leak anything but the failure reason.
    console.warn("wasm core unavailable, using MOCK core:", (err as Error).message);
    return mockCore;
  }
}

export function loadCore(): Promise<LoadedCore> {
  if (!cached) cached = load();
  return cached;
}

export type { LoadedCore, ZenvelopeCore } from "./types";
