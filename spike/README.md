# M3 proving spike (throwaway)

One question: **can a browser build the Orchard/Ironwood post-NU6.3 proving key and
produce one bundle proof, single-threaded, on the stable toolchain — and what does it
cost in time and memory?**

Answer: **yes.** Nothing needed threads, nothing needed nightly, and the whole thing
fits in ~101 MB of wasm linear memory. It is just slow.

## Measured

Playwright chromium 153.0.8010.12, 8-core x86_64 Linux host, one thread. Every row is a
real proof that verified (`verified=true`, 2 actions, 7264 proof bytes).

| Build | CPU | pk build | vk build | bundle build | proof | verify | peak wasm mem |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default release (`opt-level = "z"`) | 1x | 35.6 s | 29.0 s | 0.41 s | 52.1 s | 0.39 s | 100.8 MB |
| optimized (`opt-level = 3`, `lto = "fat"`, `cgu = 1`) | 1x | 33.0 s | 27.1 s | 0.40 s | 50.4 s | 0.40 s | 100.8 MB |
| default release | 4x throttle | 148.8 s | 119.4 s | 1.75 s | 228.5 s | 1.62 s | 100.8 MB |
| optimized | 4x throttle | 141.3 s | 117.7 s | 1.70 s | 207.6 s | 1.53 s | 100.8 MB |

Peak wasm linear memory is **105,644,032 bytes (100.8 MB)** in every single run, and the
growth is a staircase: 1.4 MB at load, 32.2 MB after the proving key, 36.3 MB after the
verifying key, 100.8 MB after the proof. Nowhere near 1 GB, let alone the 4 GB wasm32
ceiling. Re-running under `--js-flags=--wasm-max-mem-pages=32768` (a hard 2 GB cap)
changes nothing: 35.3 s / 51.0 s / 100.8 MB, proof verified.

The optimized profile buys ~5-9% and costs 1.0 MB more wasm (1.50 MB -> 2.53 MB raw,
646 KB -> 972 KB gzipped). wasm-opt ran at `-O3` in both, so `opt-level = "z"` is
already most of the way there; the profile is not where the time is.

## What it does

`crates/spike-prove` is a `wasm-bindgen`, `--target web` crate exporting:

| Export | What it measures |
| --- | --- |
| `build_pk()` | `ProvingKey::build(OrchardCircuitVersion::PostNu6_3)`, cached in a `thread_local!`. Returns ms. |
| `build_vk()` | `VerifyingKey::build(OrchardCircuitVersion::PostNu6_3)`. Returns ms. |
| `prove_dummy()` | Builds a **real** 2-action Ironwood bundle, proves it, signs it, verifies it. Returns JSON. |
| `mem_bytes()` | `core::arch::wasm32::memory_size(0) * 65536`. |

`prove_dummy` is not a dummy-spend bundle: it shields a 5000-zat note into an
output-only `BundleVersion::ironwood_v3()` bundle (never proved — only the note is
wanted), witnesses that note at position 0 of an ad-hoc single-leaf tree
(`MerklePath::from_parts(0, [empty_root(level); 32])`, no `shardtree` dependency), and
then builds `BundleType::DEFAULT` + `ironwood_v3().default_flags()` with one real spend
and one output to the internal-scope address — a cross-address transfer, which Ironwood
permits. That is 2 actions on the `PostNu6_3` circuit, proved with `create_proof(&pk,
rng)` and verified with `verify_proof(&vk)`.

The one thing that matters for the build: **`orchard` is taken with
`default-features = false, features = ["circuit"]`**. The default features include
`multicore`, which pulls `halo2_proofs/multicore` and with it rayon — no use in a plain
`--target web` build. Also, something in the tree pulls `getrandom` **0.2**, which needs
its `js` feature named for `wasm32-unknown-unknown` (`crates/core`'s `getrandom` is 0.3,
whose backend comes from the cfg in `.cargo/config.toml`; these are two different knobs).

## Running it

```sh
wasm-pack build crates/spike-prove --target web --release --out-dir spike/pkg-default
cd spike && npm install @playwright/test
npx playwright test --config playwright.config.mjs
```

`server.mjs` serves this directory with COOP/COEP. `spike.spec.mjs` drives Playwright's
own chromium, throttles the CPU with CDP `Emulation.setCPUThrottlingRate`, and polls
`mem_bytes()` after every step (wasm memory never shrinks, so the last reading is the
peak). `SPIKE_PKGS`, `SPIKE_RATES` and `SPIKE_MAX_MEM_PAGES` select the matrix.

The optimized build is the same crate with the release profile overridden:

```sh
CARGO_PROFILE_RELEASE_OPT_LEVEL=3 CARGO_PROFILE_RELEASE_LTO=fat \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_TARGET_DIR=target-opt \
wasm-pack build crates/spike-prove --target web --release --out-dir spike/pkg-opt
```

Delete this directory and `crates/spike-prove` once M3 is decided.
