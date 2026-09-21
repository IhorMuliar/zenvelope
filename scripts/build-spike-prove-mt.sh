#!/usr/bin/env bash
# Build the THROWAWAY threaded proving spike (crates/spike-prove-mt) into spike/pkg-mt.
#
#   ./scripts/build-spike-prove-mt.sh [out-dir-name]
#
# This is the whole recipe for a wasm-threads build, and the four things that make it
# different from scripts/build-core.sh are all here:
#
#   1. a nightly toolchain, installed side by side (the default stays stable):
#        rustup toolchain install nightly --component rust-src
#      `rustup run nightly` selects it for this one command only.
#   2. RUSTFLAGS turning on the wasm thread features. NOTE: setting RUSTFLAGS in the
#      environment *replaces* the `rustflags` in .cargo/config.toml for this target, so
#      anything needed from there has to be repeated here. crates/core needs
#      `--cfg getrandom_backend="wasm_js"`; this crate's getrandom is 0.2, so it does not.
#   3. `-Z build-std=std,panic_abort`, because the shipped wasm32 std is built without
#      atomics and has to be recompiled. That is what needs `rust-src`.
#   4. wasm-opt run with `--enable-threads` on top of the post-MVP features the
#      single-threaded spike already names (see the crate's Cargo.toml metadata).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_name="${1:-pkg-mt}"

if ! rustup toolchain list | grep -q '^nightly'; then
  echo "Installing the nightly toolchain (the default is left alone)..." >&2
  rustup toolchain install nightly --component rust-src
fi

# The three link args are NOT optional and are the thing every wasm-threads guide leaves
# out: on rustc 1.100-nightly, `-C target-feature=+atomics` by itself produces a module
# whose memory is *exported and unshared*. Workers then instantiate their own copy of
# linear memory and the rayon pool silently runs on separate heaps. `--shared-memory`
# makes the memory shared, `--import-memory` makes the JS glue pass one in (which is what
# wasm-bindgen-rayon hands each worker), and a shared memory must declare a maximum.
# Verify with: the memory section must say `shared=true`, or threads are a no-op.
# The four --export= args are the second half of the same story. wasm-ld creates
# `__wasm_init_tls` and the `__tls_*` globals with HIDDEN visibility, so they do not
# appear in the module's exports unless asked for by name, and wasm-bindgen's threading
# pass then dies with `failed to find __wasm_init_tls`. Older rustc added these four
# automatically alongside --shared-memory; 1.100-nightly does not (it also warns that
# `-C target-feature=+atomics` is unstable, rust#162235), so they are ours to pass.
export RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base'
export CARGO_TARGET_DIR="$repo_root/target-mt"

rustup run nightly wasm-pack build "$repo_root/crates/spike-prove-mt" \
  --target web \
  --release \
  --out-dir "$repo_root/spike/$out_name" \
  -- -Z build-std=std,panic_abort

# wasm-bindgen-rayon 1.3.0's no-bundler worker glue still calls the removed two-argument
# form of the wasm-bindgen init function. wasm-bindgen 0.2.128 only accepts the object
# form, so patch the generated snippet. (A bundler build uses workerHelpers.js, which is
# already on the object form, and needs none of this.)
snippet=$(find "$repo_root/spike/$out_name/snippets" -name 'workerHelpers.no-bundler.js' 2>/dev/null || true)
if [ -n "$snippet" ]; then
  sed -i 's/pkg\.default(data\.module, data\.memory)/pkg.default({ module_or_path: data.module, memory: data.memory })/' "$snippet"
  echo "patched $snippet"
fi

wasm="$repo_root/spike/$out_name/zenvelope_spike_prove_mt_bg.wasm"
raw=$(wc -c <"$wasm")
gz=$(gzip -9 -c "$wasm" | wc -c)
printf '\nwasm: %s\n  raw:  %s bytes (%s KB)\n  gzip: %s bytes (%s KB)\n' \
  "$wasm" "$raw" "$((raw / 1024))" "$gz" "$((gz / 1024))"
