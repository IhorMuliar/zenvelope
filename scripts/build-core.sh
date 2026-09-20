#!/usr/bin/env bash
# Build crates/core to WASM and drop the result where the web app imports it.
#
#   ./scripts/build-core.sh
#
# Needs: rustup target add wasm32-unknown-unknown, and wasm-pack on PATH.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/web/src/wasm/core"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack not found. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  echo "Adding the wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

mkdir -p "$out_dir"

wasm-pack build "$repo_root/crates/core" \
  --target web \
  --release \
  --out-dir "$out_dir"

wasm="$out_dir/zenvelope_core_bg.wasm"
raw=$(wc -c <"$wasm")
gz=$(gzip -9 -c "$wasm" | wc -c)
printf '\nwasm: %s\n  raw:  %s bytes (%s KB)\n  gzip: %s bytes (%s KB)\n' \
  "$wasm" "$raw" "$((raw / 1024))" "$gz" "$((gz / 1024))"
