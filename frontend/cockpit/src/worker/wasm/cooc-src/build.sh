#!/usr/bin/env bash
# Rebuild the committed co-occurrence kernel .wasm tiers (scalar + simd128).
# Build-time ONLY — the prebuilt ../cooc.scalar.wasm / ../cooc.simd.wasm are
# committed so the cockpit/CI build stays toolchain-free (DESIGN §6.1.5).
#
# Prereqs (one-time):
#   rustup target add wasm32-unknown-unknown
#
# Usage: ./build.sh   (run from this directory)
set -euo pipefail
cd "$(dirname "$0")"
OUT=".."
TARGET="wasm32-unknown-unknown"

echo "→ scalar tier"
cargo build --release --target "$TARGET"
cp "target/$TARGET/release/cooc.wasm" "$OUT/cooc.scalar.wasm"

echo "→ simd128 tier"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target "$TARGET" --target-dir target-simd
cp "target-simd/$TARGET/release/cooc.wasm" "$OUT/cooc.simd.wasm"

ls -l "$OUT"/cooc.*.wasm
echo "✓ done — commit ../cooc.scalar.wasm and ../cooc.simd.wasm"
