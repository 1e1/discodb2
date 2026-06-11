// discodb2 — COLUMNAR packed frames for the Hunt scans (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/DESIGN.md §6.1.4 step 3b.
//
// A Struct-of-Arrays over a window of CAN frames, with a FIXED 8-byte payload
// stride (classic CAN ≤ 8). It is the shape the synchronous Hunt scans consume
// so the worker materializes ONE bulk allocation (five typed arrays) per scan
// instead of N per-frame `FrameView` objects + N `Uint8Array`/`number[]` payload
// copies. It is ALSO the layout a future WebAssembly analyzer would take
// (contiguous typed arrays, no objects) — step 3b makes the representation
// WASM-*ready*; WASM itself is a separate, gated step (DESIGN §6.1.5).
//
// Unlike a ring VIEW (step 3a), a PackedFrames is a real COPY (RawFrameRing
// fills it out of its backing store), so it is SAFE to retain across pushes.
//
// Pure & framework-free (like the rest of shared/analysis): no Svelte/Vite/DOM
// deps; runs in the cockpit, a Web Worker, or a plain Node test runner.

/** Fixed payload stride: classic CAN carries ≤ 8 bytes (DESIGN §3.2). */
export const PACKED_STRIDE = 8;

/**
 * A window of frames in columnar (Struct-of-Arrays) form. All columns are length
 * `count` except `data`, which is `count * PACKED_STRIDE` (byte `b` of frame `i`
 * is `data[i * PACKED_STRIDE + b]`). Bytes beyond a frame's `dlc` are zero.
 *
 *   • `tUs`   — backend µs timestamp per frame.
 *   • `id`    — arbitration id per frame (already masked, no flag bits).
 *   • `flags` — bit0 extended, bit1 error, bit2 rtr (same layout as RawFrameRing).
 *   • `dlc`   — payload length 0..8 per frame.
 *   • `data`  — payloads, fixed 8-byte stride.
 */
export interface PackedFrames {
  count: number;
  tUs: Float64Array;
  id: Uint32Array;
  flags: Uint8Array;
  dlc: Uint8Array;
  data: Uint8Array;
}

/** Byte `b` of frame `i` (no bounds check — callers loop b < payloadLen(p, i)). */
export function byteAt(p: PackedFrames, i: number, b: number): number {
  return p.data[i * PACKED_STRIDE + b];
}

/** Payload length (dlc) of frame `i`. */
export function payloadLen(p: PackedFrames, i: number): number {
  return p.dlc[i];
}

/** Flag accessors mirroring RawFrameRing's bit layout. */
export function isExtended(p: PackedFrames, i: number): boolean {
  return (p.flags[i] & 1) !== 0;
}
export function isError(p: PackedFrames, i: number): boolean {
  return (p.flags[i] & 2) !== 0;
}
export function isRtr(p: PackedFrames, i: number): boolean {
  return (p.flags[i] & 4) !== 0;
}

/** The minimal frame shape framesToPacked accepts (a superset of every analyzer's). */
export interface PackableFrame {
  id: number;
  tUs?: number;
  isExtended?: boolean;
  isError?: boolean;
  isRtr?: boolean;
  data: ArrayLike<number>;
}

/**
 * Build a PackedFrames from frame objects. This is the ADAPTER the pure Node
 * tests use to feed the packed analyzer paths plain arrays (mirroring how the
 * worker feeds them RawFrameRing.windowPacked output). Payloads are clamped to
 * `PACKED_STRIDE` bytes (classic CAN) and 0..255 per byte; bytes beyond `dlc`
 * are zero. Values >8 bytes are truncated to 8 — the packed representation is
 * classic-CAN only by construction (see RawFrameRing's 8-byte stride).
 */
export function framesToPacked(frames: ReadonlyArray<PackableFrame>): PackedFrames {
  const count = frames.length;
  const tUs = new Float64Array(count);
  const id = new Uint32Array(count);
  const flags = new Uint8Array(count);
  const dlc = new Uint8Array(count);
  const data = new Uint8Array(count * PACKED_STRIDE);
  for (let i = 0; i < count; i++) {
    const f = frames[i];
    tUs[i] = f.tUs ?? 0;
    id[i] = f.id;
    flags[i] = (f.isExtended ? 1 : 0) | (f.isError ? 2 : 0) | (f.isRtr ? 4 : 0);
    const n = Math.min(f.data.length, PACKED_STRIDE);
    dlc[i] = n;
    const base = i * PACKED_STRIDE;
    for (let b = 0; b < n; b++) data[base + b] = f.data[b] & 0xff; // Uint8Array also clamps
  }
  return { count, tUs, id, flags, dlc, data };
}

/**
 * Group a packed window by id into INDEX LISTS, preserving arrival order within
 * each id (the basis transition/pair/counter detection needs). Returns a Map
 * from id to the list of frame indices, in first-appearance id order — the same
 * grouping the frame-based analyzers build, but with indices instead of payload
 * references (no per-frame objects). An optional id allow-list filters ids.
 */
export function groupByIdPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
): Map<number, number[]> {
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;
  const byId = new Map<number, number[]>();
  for (let i = 0; i < p.count; i++) {
    const fid = p.id[i];
    if (allow && !allow.has(fid)) continue;
    let group = byId.get(fid);
    if (group === undefined) {
      group = [];
      byId.set(fid, group);
    }
    group.push(i);
  }
  return byId;
}
