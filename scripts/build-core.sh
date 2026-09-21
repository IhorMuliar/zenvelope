#!/usr/bin/env bash
# Build crates/core to WASM, twice, and drop both results where the web app imports them.
#
#   ./scripts/build-core.sh              # both packages
#   ZENVELOPE_SKIP_MT=1 ./scripts/build-core.sh   # single-threaded only
#
#   web/src/wasm/core/      single-threaded, the default stable toolchain
#   web/src/wasm/core-mt/   threaded: orchard/multicore + a wasm-bindgen-rayon pool
#
# The app ships both and chooses at load time (web/src/core/worker.ts): the threaded
# module imports a *shared* memory, which only instantiates on a cross-origin-isolated
# page, so a browser without COOP/COEP or without wasm threads gets the single-threaded
# package instead. That is why this is two builds and not a flag.
#
# Needs: rustup target add wasm32-unknown-unknown, and wasm-pack on PATH. The threaded
# step also needs a nightly toolchain with rust-src; it is skipped, loudly, without one.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/web/src/wasm/core"
out_dir_mt="$repo_root/web/src/wasm/core-mt"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack not found. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  echo "Adding the wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

report() {
  local label="$1" wasm="$2"
  local raw gz
  raw=$(wc -c <"$wasm")
  gz=$(gzip -9 -c "$wasm" | wc -c)
  printf '\n%s: %s\n  raw:  %s bytes (%s KB)\n  gzip: %s bytes (%s KB)\n' \
    "$label" "$wasm" "$raw" "$((raw / 1024))" "$gz" "$((gz / 1024))"
}

# ----------------------------------------------------- 1. single-threaded ----

mkdir -p "$out_dir"

wasm-pack build "$repo_root/crates/core" \
  --target web \
  --release \
  --out-dir "$out_dir"

report "wasm (1 thread)" "$out_dir/zenvelope_core_bg.wasm"

# ----------------------------------------------------------- 2. threaded ----
#
# The recipe is the one verified by the M4 spike (scripts/build-spike-prove-mt.sh); the
# comments there explain each piece and none of it is optional. The differences from the
# spike are that this crate needs `--features multicore` and that its getrandom 0.3 needs
# `--cfg getrandom_backend="wasm_js"` repeated here, because setting RUSTFLAGS in the
# environment REPLACES the `rustflags` in .cargo/config.toml for this target.

if [ "${ZENVELOPE_SKIP_MT:-0}" = "1" ]; then
  cat >&2 <<'NOTICE'

NOTICE: ZENVELOPE_SKIP_MT=1, so web/src/wasm/core-mt was NOT built.
        The app still works: the core worker falls back to the single-threaded
        package, and the footer says "proving: 1 thread". Proving is then about
        2.5x slower. Drop the variable to build it.
NOTICE
  exit 0
fi

if ! rustup toolchain list | grep -q '^nightly'; then
  cat >&2 <<'NOTICE'

NOTICE: no nightly toolchain, so web/src/wasm/core-mt was NOT built.
        A wasm-threads build needs `-Z build-std` to recompile std with atomics,
        which is nightly-only. Install it with:

          rustup toolchain install nightly --component rust-src

        The app still works without it: the core worker falls back to the
        single-threaded package and the footer says "proving: 1 thread".
NOTICE
  exit 0
fi

mkdir -p "$out_dir_mt"

export RUSTFLAGS='--cfg getrandom_backend="wasm_js" -C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base'
# A separate target dir: the atomics build has different rustflags and would otherwise
# invalidate the stable build's cache on every alternation.
export CARGO_TARGET_DIR="$repo_root/target-mt-core"

rustup run nightly wasm-pack build "$repo_root/crates/core" \
  --target web \
  --release \
  --out-dir "$out_dir_mt" \
  -- --features multicore -Z build-std=std,panic_abort

# wasm-bindgen-rayon 1.3.0's no-bundler worker glue still calls the removed two-argument
# form of the wasm-bindgen init function; wasm-bindgen 0.2.128 only accepts the object
# form. Same patch as the spike.
snippet=$(find "$out_dir_mt/snippets" -name 'workerHelpers.no-bundler.js' 2>/dev/null || true)
if [ -n "$snippet" ]; then
  sed -i 's/pkg\.default(data\.module, data\.memory)/pkg.default({ module_or_path: data.module, memory: data.memory })/' "$snippet"
  echo "patched $snippet"
fi

report "wasm (threads)" "$out_dir_mt/zenvelope_core_bg.wasm"
