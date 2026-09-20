# M3 proving spike (throwaway)

One question: **can a browser build the Orchard/Ironwood post-NU6.3 proving key and
produce one bundle proof, single-threaded, on the stable toolchain — and what does it
cost in time and memory?**

Answer: **yes.** Nothing needed threads, nothing needed nightly, and the whole thing
fits in ~101 MB of wasm linear memory. It is just slow.

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
