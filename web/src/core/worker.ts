/// <reference lib="webworker" />
/**
 * The core worker: the only thread that ever holds a wasm module.
 *
 * M3 proved in the page's main thread, and the measurement in web/docs/M3-VERIFICATION.md
 * §4 is what this file answers: 42 seconds of single-threaded halo2 with no `await` in it
 * froze the progress screen solid — the stage rows never painted and the elapsed clock
 * stopped — because the browser had no chance to render. Moving the core here means the
 * page has nothing to do during a proof but paint.
 *
 * ## Which package
 *
 * `scripts/build-core.sh` produces two wasm packages from the same crate:
 *
 *   web/src/wasm/core/      single-threaded, stable toolchain, bundled by Vite
 *   web/src/wasm/core-mt/   `--features multicore`, a shared memory and a
 *                           wasm-bindgen-rayon pool, copied verbatim to /wasm/core-mt/
 *
 * The threaded module *imports* its memory and that memory is shared, so it only
 * instantiates where `SharedArrayBuffer` is available — which means a cross-origin
 * isolated page (COOP/COEP, see web/public/_headers and vite.config.ts) on an engine
 * with the wasm threads proposal. Both are checked here before the threaded package is
 * even fetched, and any failure at all falls back to the single-threaded one: a slower
 * sweep is a far better outcome than a page that cannot open an envelope.
 *
 * ## What crosses the boundary
 *
 * Only structured-cloneable values. The wasm exports that return structs hand back
 * wasm-bindgen objects whose fields are getters over linear memory and which have to be
 * freed; they are copied into plain objects and freed *here*, so nothing outside this
 * file ever holds one.
 *
 * ## The secret
 *
 * The link secret arrives as an ordinary argument, is passed to the core, and is kept
 * nowhere: no module-level variable, no storage, no log. It exists in the page (it is in
 * the URL fragment) and in this worker, and in neither of them past the call.
 */

import { mockCore } from "./mock";
import type {
  AddressClass,
  CoreBackend,
  CoreInfo,
  Derived,
  NewWallet,
  NotesToSpend,
  Network,
  OpenResult,
  ParsedFragment,
  ProgressFn,
  StageFn,
  SweepResult,
  SyncCore,
  ZatLike,
} from "./types";
import type { CallMessage, InitMessage, ToWorker } from "./rpc";

const ST_ENTRY = "../wasm/core/zenvelope_core.js";
/** Where vite.config.ts's `zenvelope-core-mt` plugin serves the threaded package. */
const MT_ENTRY = "/wasm/core-mt/zenvelope_core.js";

/**
 * import.meta.glob rather than a bare dynamic import, so that a checkout with no build
 * is an empty map at build time instead of a build error. (M1's rule, unchanged.)
 */
const stModules = import.meta.glob("../wasm/core/*.js") as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

const REQUIRED = [
  "derive",
  "generate_secret",
  "parse_fragment",
  "build_fragment",
  "payment_uri",
  "zat_to_zec_string",
  "zec_string_to_zat",
  "open_envelope",
  "warm_proving_key",
  "classify_address",
  "new_wallet",
  "sweep_envelope",
] as const;

/* ------------------------------------------------------- wasm-bindgen objects */

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
      gateway: v.gateway ?? "",
    };
  } finally {
    if (typeof v.free === "function") v.free();
  }
}

/** The raw wasm surface, before the copy-and-free wrappers above. */
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
  /** `notes` is an array; a bare object is still accepted, for one release. */
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
  ): Promise<SweepResult & Disposable>;
  /** M4 build stamp: true only in the `multicore` package. */
  is_threaded?(): boolean;
  /** `rayon::current_num_threads()`, or 1. */
  thread_count?(): number;
  /** wasm-bindgen-rayon, `multicore` only. */
  initThreadPool?(n: number): Promise<unknown>;
}

/** Wraps a raw wasm module in the copy-and-free layer, giving a plain sync core. */
function adopt(core: WasmModule): SyncCore {
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
    open_envelope: (secret, birthday, network, url, onProgress) =>
      core.open_envelope(secret, birthday, network, url, onProgress),
    warm_proving_key: () => core.warm_proving_key(),
    classify_address: (addr, network) => takeAddressClass(core.classify_address(addr, network)),
    new_wallet: (network, birthday) => takeWallet(core.new_wallet(network, birthday)),
    sweep_envelope: async (
      secret,
      network,
      url,
      notes,
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
          notes,
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

function checkExports(mod: Record<string, unknown>, where: string): WasmModule {
  for (const fn of REQUIRED) {
    if (typeof mod[fn] !== "function") {
      throw new Error(`the wasm core at ${where} is missing ${fn}()`);
    }
  }
  return mod as unknown as WasmModule;
}

/* --------------------------------------------------------- feature detection */

/**
 * Whether this engine implements the wasm threads proposal.
 *
 * Hand-rolled rather than pulling in wasm-feature-detect for one check. The module below
 * is the canonical threads probe: a single function whose body is `i32.atomic.load` over
 * a shared imported memory, which only validates on an engine that has atomics. The
 * `SharedArrayBuffer` postMessage is the second half — Safari 15 validated the module but
 * refused to transfer the buffer, which is exactly the failure that matters here, since
 * wasm-bindgen-rayon hands each worker the shared memory by postMessage.
 */
function wasmThreadsSupported(): boolean {
  try {
    if (typeof SharedArrayBuffer === "undefined") return false;
    new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
    return WebAssembly.validate(
      // prettier-ignore
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1,
        10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
      ]),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ loading */

let loaded: { core: SyncCore; info: CoreInfo } | null = null;
let loading: Promise<{ core: SyncCore; info: CoreInfo }> | null = null;

/** The threaded package, its pool started. Throws if anything at all is missing. */
async function loadThreaded(maxThreads: number): Promise<{ core: SyncCore; threads: number }> {
  // @vite-ignore: this package is copied to the build output verbatim and must NOT go
  // through Vite's module graph — wasm-bindgen-rayon's no-bundler glue self-spawns its
  // workers by fetching its own import.meta.url, which needs the real file on disk.
  const url = new URL(MT_ENTRY, self.location.origin).href;
  const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;

  const init = mod.default;
  if (typeof init !== "function") throw new Error("the threaded core has no default init()");
  await (init as () => Promise<unknown>)();

  const wasm = checkExports(mod, MT_ENTRY);
  if (typeof wasm.is_threaded !== "function" || !wasm.is_threaded()) {
    throw new Error("the package at /wasm/core-mt was not built with --features multicore");
  }
  if (typeof wasm.initThreadPool !== "function") {
    throw new Error("the threaded core has no initThreadPool()");
  }

  await wasm.initThreadPool(maxThreads);
  // What rayon actually got, not what we asked for.
  const threads = typeof wasm.thread_count === "function" ? wasm.thread_count() : 1;
  return { core: adopt(wasm), threads };
}

/** The single-threaded package. Absent means a checkout with no build: use the MOCK. */
async function loadSingle(): Promise<{ core: SyncCore; backend: CoreBackend }> {
  const entry = stModules[ST_ENTRY];
  if (!entry) {
    console.warn(
      `no wasm core at ${ST_ENTRY}, using the MOCK core. Run ./scripts/build-core.sh.`,
    );
    return { core: mockCore, backend: "mock" };
  }
  const mod = await entry();
  const init = mod.default;
  if (typeof init !== "function") {
    throw new Error("wasm core has no default init() export");
  }
  await (init as () => Promise<unknown>)();
  return { core: adopt(checkExports(mod, ST_ENTRY)), backend: "single" };
}

async function load(maxThreads: number): Promise<{ core: SyncCore; info: CoreInfo }> {
  let reason: string | null = null;

  if (maxThreads < 2) {
    // Either one core was reported, or ?threads=1 capped it. A pool of one is all
    // cost and no parallelism, so the single-threaded package is the right answer.
    reason = "the proving pool was capped at one thread";
  } else if (!self.crossOriginIsolated) {
    reason = "this page is not cross-origin isolated (COOP/COEP), so SharedArrayBuffer is off";
  } else if (!wasmThreadsSupported()) {
    reason = "this browser does not implement wasm threads";
  } else {
    try {
      const { core, threads } = await loadThreaded(maxThreads);
      return { core, info: { backend: "threads", isMock: false, threads, reason: null } };
    } catch (err) {
      // Every threaded failure lands here, including a missing core-mt build: a slower
      // sweep beats a page that cannot open an envelope.
      reason = `the threaded core did not load: ${(err as Error)?.message ?? String(err)}`;
      console.warn(reason);
    }
  }

  const { core, backend } = await loadSingle();
  return { core, info: { backend, isMock: core.isMock, threads: 1, reason } };
}

function ensureLoaded(maxThreads: number): Promise<{ core: SyncCore; info: CoreInfo }> {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = load(maxThreads).then((l) => {
      loaded = l;
      return l;
    });
  }
  return loading;
}

/* --------------------------------------------------------------- the handler */

const post = (message: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

/** The message of a thrown value, never the value: a wasm error can be anything. */
function messageOf(err: unknown): string {
  const m = (err as Error)?.message;
  return typeof m === "string" && m.trim() !== "" ? m : String(err);
}

async function handleInit(msg: InitMessage): Promise<void> {
  try {
    const { info } = await ensureLoaded(msg.maxThreads);
    post({ kind: "result", id: msg.id, value: info });
  } catch (err) {
    post({ kind: "error", id: msg.id, message: messageOf(err) });
  }
}

async function handleCall(msg: CallMessage): Promise<void> {
  try {
    const { core } = await ensureLoaded(1);
    const args = [...msg.args];

    // The two callbacks the core takes are rebuilt here and forwarded as messages
    // tagged with this call's id, so a superseded run cannot be confused for a live one.
    if (msg.method === "open_envelope") {
      // The event is a plain object built by the core (or the mock), so it clones.
      const onProgress: ProgressFn = (scanned, total, event) =>
        post({ kind: "progress", id: msg.id, scanned, total, event: event ?? null });
      args[4] = onProgress;
    } else if (msg.method === "sweep_envelope") {
      const onStage: StageFn = (stage, detail) =>
        post({ kind: "stage", id: msg.id, stage, detail });
      args[9] = onStage;
    }

    const fn = (core as unknown as Record<string, (...a: unknown[]) => unknown>)[msg.method];
    if (typeof fn !== "function") throw new Error(`the core has no ${msg.method}()`);
    const value = await fn.apply(core, args);
    post({ kind: "result", id: msg.id, value });
  } catch (err) {
    post({ kind: "error", id: msg.id, message: messageOf(err) });
  }
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.kind === "init") void handleInit(msg);
  else if (msg.kind === "call") void handleCall(msg);
});
