# WASM co-occurrence tally kernel (DESIGN §6.1.4 step 4 / §6.1.5)

The single hottest vectorizable kernel selected by the Phase 0 bench: the
`O(pairs · bytes²)` consecutive-pair byte-change tally that dominates a
whole-buffer co-occurrence scan and **scales linearly with input** (the
batch-regime win, §6.1.4.1). It is a **drop-in accelerator** for the pure-JS
`jsCoocTally` in `frontend/shared/analysis/co-occurrence.ts`, injected at runtime
by the cockpit analysis worker via `setCoOccurrenceTallyKernel`.

**WASM-ready, not WASM-dependent.** The pure-JS path stays the reference and the
runtime fallback. `shared/analysis` imports nothing from here; the worker is the
only place that knows the accelerator is WebAssembly. If the `.wasm` fails to
load (or SIMD is unavailable), the loader returns the lower tier or `null` and the
JS default runs unchanged.

## Files

- `cooc-src/` — Rust source (`#![no_std]`, no wasm-bindgen, plain `extern "C"`).
- `cooc.scalar.wasm` / `cooc.simd.wasm` — **committed prebuilt artifacts** (the
  cockpit/CI build is toolchain-free; no cargo needed).
- `coocKernel.ts` — loader: SIMD feature-detect → pick tier → instantiate over a
  private `WebAssembly.Memory` → expose a `CoOccurrenceTallyKernel`.
- `cooc.wasm.equiv.test.ts` — pins WASM ≡ JS, bit-identical, both tiers.

## Tiers (DESIGN §6.1.5)

`simd.wasm` (Safari 16.4+) → `scalar.wasm` (MVP floor) → pure JS. The ONLY
difference between the two `.wasm` tiers is `change_mask` (one `u8x16_ne` +
`u8x16_bitmask` vs a scalar byte loop) — both yield the same change bitmask, so
the tiers are **bit-identical** to each other and to JS (pure integer counts;
integer adds don't reorder-drift). No threads / SharedArrayBuffer (a single
`Memory`; the in-car Python `http.server` sends no COOP/COEP headers).

## Rebuild

One-time: `rustup target add wasm32-unknown-unknown`. Then:

```sh
cd cooc-src && ./build.sh
```

This rebuilds and copies both committed `.wasm` tiers. Commit the updated
`cooc.scalar.wasm` and `cooc.simd.wasm`. The `cooc-src/target*/` build dirs are
git-ignored.

## Future kernels (this seam is the reusable template)

Measured: SIMD ≈ scalar for *this* kernel (1.56× over JS, both tiers) — the
bottleneck is the data-dependent co-change **scatter-accumulation**, not the byte
compare SIMD speeds up. Adding a kernel = a new `setXKernel` seam in
`shared/analysis/<x>.ts` + a committed `.wasm` + a loader entry here. Re-run the
measure-first discipline (DESIGN §6.1.5 §2) before porting — don't port
speculatively. Two candidates, in order, *if a measured need appears*:

1. **Co-occurrence v2 — SIMD outer-product accumulation.** Attack the accumulation,
   not the compare. The per-pair co-change update is the outer product `m ⊗ m` of
   the change mask; accumulate the dense symmetric 8×8 with vector adds (per set bit
   i, add the mask-as-{0,1}-lane vector to row i; narrow lanes + periodic i32 flush
   to avoid overflow). Off-diagonal counts stay bit-identical → same equivalence
   test. Pays off in the batch regime (large N).
2. **Permutation-null kernel — BATCH only.** Not chosen now (step 1b sample-caps it →
   no batch scaling today), but batch mode (DESIGN §9 v2) inverts that. Needs: a
   dense integer 2D histogram (field-card × 256) in linear memory instead of JS
   Maps; a **bit-identical** fixed-seed Fisher-Yates PRNG port (determinism
   obligation — pin the first N draws); accept the log-entropy reduction stays scalar
   (vectorize the O(N) histogram fill only).

See DESIGN §6.1.5 "Future kernels" for the full rationale.

## ABI

`cooc_tally(data, dlc, indices, n, byteCount, changed, present, coChange, coPresent)`
— all pointers are byte offsets into the exported linear memory. `data` is the
packed `count*8` payload column, `dlc` the per-frame length column, `indices` the
`n` frame indices of one id (arrival order). Outputs (caller-zeroed): `changed`/
`present` are `byteCount` i32s; `coChange`/`coPresent` are `byteCount²` i32s
(row-major, stride `byteCount`). See `coocKernel.ts` for the memory layout.
