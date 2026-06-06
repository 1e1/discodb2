// discodb2 — WASM loader for the co-occurrence TALLY kernel (DESIGN §6.1.4 step 4).
//
// This is the ONLY place that knows the co-occurrence accelerator is WebAssembly.
// It feature-detects SIMD, instantiates the committed `.wasm` over a private
// `WebAssembly.Memory`, and exposes a `CoOccurrenceTallyKernel` with the SAME
// signature as the pure-JS `jsCoocTally` — a drop-in the worker injects via
// `setCoOccurrenceTallyKernel`. `shared/analysis` imports nothing from here.
//
// Three tiers (DESIGN §6.1.5): simd.wasm → scalar.wasm → (loader returns null →
// the pure-JS default stays). No threads / SharedArrayBuffer (single Memory).
// Loading is MIME-independent (fetch → arrayBuffer → instantiate), because the
// in-car Python `http.server` does not necessarily send `application/wasm`.

import type { CoOccurrenceTally, CoOccurrenceTallyKernel } from '@shared/analysis/co-occurrence.ts';

export type WasmTier = 'simd' | 'scalar';

/**
 * Minimal module that uses a `v128` constant — `WebAssembly.validate` returns
 * true iff the engine supports the simd128 proposal (the SIMD tier's floor,
 * Safari 16.4+). The canonical feature-detect probe (DESIGN §6.1.5).
 */
const SIMD_PROBE = new Uint8Array([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, // magic + version
  1, 5, 1, 0x60, 0, 1, 0x7b, // type: () -> v128
  3, 2, 1, 0, // func 0 : type 0
  10, 10, 1, 8, 0, 0x41, 0, 0xfd, 0x0f, 0xfd, 0x62, 0x0b, // i32.const 0; i8x16.splat; i8x16.abs; end
]);

/** True iff the engine supports WASM SIMD (simd128). */
export function wasmSimdSupported(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

interface CoocExports {
  memory: WebAssembly.Memory;
  cooc_tally: (
    data: number, dlc: number, indices: number, n: number, byteCount: number,
    changed: number, present: number, coChange: number, coPresent: number,
  ) => void;
  __heap_base: WebAssembly.Global;
}

const PAGE = 65536;
const align16 = (x: number): number => (x + 15) & ~15;

/**
 * Instantiate a committed co-occurrence `.wasm` (scalar or simd) and return a
 * {@link CoOccurrenceTallyKernel} closing over its linear memory. Pure: takes the
 * `.wasm` BYTES, so it works identically in the worker (fetched) and in Node
 * vitest (`fs.readFile`) — preserving the Node-testable property.
 *
 * Memory management: the worker reuses ONE `PackedFrames` across all ids in a
 * scan, so `data`/`dlc` are copied into wasm memory ONCE (cached by reference)
 * and only the per-id index list + outputs change between calls.
 */
export async function instantiateCoocKernel(bytes: BufferSource): Promise<CoOccurrenceTallyKernel> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as CoocExports;
  const tally = ex.cooc_tally;
  const memory = ex.memory;
  const heapBase = (ex.__heap_base.value as number) | 0;

  let cachedData: Uint8Array | null = null;
  let cachedDlc: Uint8Array | null = null;
  let dataPtr = 0;
  let dlcPtr = 0;
  let idxPtr = 0;
  let outPtr = 0;

  const ensureLayout = (data: Uint8Array, dlc: Uint8Array): void => {
    if (data === cachedData && dlc === cachedDlc) return;
    dataPtr = align16(heapBase);
    // +16 slack: the SIMD tier loads 16 bytes at the final frame's offset (only the
    // low ≤8 lanes are used, but the load address must stay in-bounds).
    dlcPtr = align16(dataPtr + data.length + 16);
    idxPtr = align16(dlcPtr + dlc.length);
    // Index region: worst case one id holds every frame → dlc.length i32s.
    outPtr = align16(idxPtr + dlc.length * 4);
    // Output region: max byteCount=8 → (changed+present)=8*4*2 + (coChange+coPresent)=64*4*2 = 576 ≤ 640.
    const need = outPtr + 640;
    const havePages = memory.buffer.byteLength / PAGE;
    const needPages = Math.ceil(need / PAGE);
    if (needPages > havePages) memory.grow(needPages - havePages);
    const u8 = new Uint8Array(memory.buffer);
    u8.set(data, dataPtr);
    u8.set(dlc, dlcPtr);
    cachedData = data;
    cachedDlc = dlc;
  };

  return (data: Uint8Array, dlc: Uint8Array, indices: Int32Array, byteCount: number): CoOccurrenceTally => {
    ensureLayout(data, dlc);
    const buf = memory.buffer;
    if (indices.length > 0) new Int32Array(buf, idxPtr, indices.length).set(indices);

    const bc = byteCount;
    const changedPtr = outPtr;
    const presentPtr = changedPtr + bc * 4;
    const coChangePtr = presentPtr + bc * 4;
    const coPresentPtr = coChangePtr + bc * bc * 4;
    const outBytes = bc * 4 * 2 + bc * bc * 4 * 2;
    if (outBytes > 0) new Uint8Array(buf, changedPtr, outBytes).fill(0);

    tally(dataPtr, dlcPtr, idxPtr, indices.length, bc, changedPtr, presentPtr, coChangePtr, coPresentPtr);

    // slice() copies out of wasm memory → owned arrays, safe to retain.
    return {
      changed: new Int32Array(buf, changedPtr, bc).slice(),
      present: new Int32Array(buf, presentPtr, bc).slice(),
      coChange: new Int32Array(buf, coChangePtr, bc * bc).slice(),
      coPresent: new Int32Array(buf, coPresentPtr, bc * bc).slice(),
    };
  };
}

/**
 * Worker/browser entry: pick the best tier the engine supports, fetch the
 * committed `.wasm`, and instantiate. Returns the kernel + the tier actually
 * loaded, or `null` on any failure (the caller then leaves the pure-JS default in
 * place). MIME-independent: fetch → arrayBuffer → instantiate (no
 * `instantiateStreaming`, since the Pi static server may not send application/wasm).
 */
// Static `new URL(<literal>, import.meta.url)` so the bundler (vite) emits each
// `.wasm` as a hashed asset and precaches it — a runtime-computed/ternary URL is
// NOT statically analyzable and would 404 (the asset never gets copied to dist).
const SIMD_URL = new URL('./cooc.simd.wasm', import.meta.url);
const SCALAR_URL = new URL('./cooc.scalar.wasm', import.meta.url);

export async function loadCoocKernel(): Promise<{ kernel: CoOccurrenceTallyKernel; tier: WasmTier } | null> {
  try {
    const tier: WasmTier = wasmSimdSupported() ? 'simd' : 'scalar';
    const url = tier === 'simd' ? SIMD_URL : SCALAR_URL;
    const resp = await fetch(url);
    const bytes = await resp.arrayBuffer();
    const kernel = await instantiateCoocKernel(bytes);
    return { kernel, tier };
  } catch {
    return null;
  }
}
