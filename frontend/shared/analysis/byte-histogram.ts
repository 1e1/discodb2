// discodb2 — PASSIVE analyzer: the PER-BYTE VALUE HISTOGRAM (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → passive scan analyzers (the Hunt "Scan"
// sub-view). Like the BIT-ACTIVITY HEATMAP (bit-activity.ts), this analyzer
// takes NO operator action: it scans the capture buffer and surfaces structure
// automatically. Where the heatmap answers "which BITS move?", this one answers
// "HOW is each byte's VALUE distributed?" — a complementary view:
//
//   • A byte that takes only a FEW discrete values (a handful of distinct bytes,
//     e.g. {0x00, 0x01} or {0,1,2,3}) is likely an ENUM / FLAG — a small set of
//     states. The heatmap would show its low bits moving; the histogram shows
//     the values clustering on a few bins.
//   • A byte with a CONTINUOUS spread (many distinct values smeared across a
//     wide [min..max] range) is likely an ANALOG signal (speed, rpm, fuel) — a
//     physical quantity sampled into a byte.
//
// So for a target id, over a window of frames, we count — per byte index — how
// often each of the 256 possible values occurs, plus a small summary (distinct
// value count, min, max, total samples). The UI renders one small 256-bin
// histogram per byte; few tall bars ⇒ enum, a broad hump ⇒ analog.
//
// Pure & framework-free (like tagger.ts / bit-activity.ts): no Svelte/Vite/
// DOM-only deps; runs in the cockpit, a Web Worker, or a plain Node test runner.
// Mutates nothing, allocates fresh output.
//
// SHORT-DLC handling matches the rest of the stack: frames of one id can legally
// differ in length. A byte is only SAMPLED on frames long enough to carry it; a
// missing byte is NOT a value-0 sample (it is simply not counted for that byte).
// So byte 6 of an id that is usually 6 bytes long but occasionally 8 is counted
// only on the frames where it is actually present.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the scan, in arrival order, on the backend µs clock. `data`
 * is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. This is the same
 * shape the bit-activity analyzer's ScanFrame uses (and a structural superset of
 * the tagger's RawFrame), so the cockpit seam can pass one mapped array to all
 * three. The analyzer itself does not read `tUs` — the caller has already sliced
 * the window — but accepting it keeps the seam a trivial pass-through.
 */
export interface HistogramFrame {
  id: number;
  tUs: number;
  /**
   * The payload bytes. Accepts the ring's `Uint8Array` (zero-copy — already
   * byte-clamped) or a plain `number[]` (a decoder/test, defensively clamped).
   */
  data: ArrayLike<number>;
}

/** Tunable thresholds. Kept local & overridable; sane defaults below. */
export interface ByteHistogramConfig {
  /**
   * Max byte slots to analyze. Classic CAN is ≤8 bytes, so 8 is the natural cap;
   * kept configurable for CAN-FD experiments later. A byte index ≥ maxBytes is
   * never histogrammed even if some frame carries it.
   */
  maxBytes: number;
  /**
   * An id needs at least this many frames before its histogram is trusted. A
   * single frame gives a degenerate "1 distinct value" reading for every byte,
   * which tells us nothing; a small floor stops a stray frame from creating a
   * misleading profile. (Mirrors the heatmap's minFrames intent; the value is
   * lower because a histogram is meaningful from very few samples — even 2
   * frames already distinguish a constant byte from a changing one.)
   */
  minFrames: number;
}

export const BYTE_HISTOGRAM_DEFAULTS: ByteHistogramConfig = {
  maxBytes: 8, // classic CAN payload width
  minFrames: 2, // need ≥2 frames before a distribution means anything
};

/** The number of possible values a byte can take (the histogram bin count). */
export const BYTE_VALUE_BINS = 256;

/**
 * The value distribution for ONE byte index of one id over the scanned window.
 *
 *   • `byteIndex` — which byte this profiles (0..maxBytes-1).
 *   • `counts`    — length-256 array; counts[v] = how many SAMPLED frames had
 *                   value v at this byte. Sum = `samples`.
 *   • `samples`   — frames where this byte was present (≤ the id's frame count;
 *                   smaller for a byte that only appears on the longer frames).
 *   • `distinct`  — how many of the 256 values occurred at least once. FEW ⇒
 *                   enum/flag; MANY ⇒ analog spread. 0 only if `samples` is 0.
 *   • `min`/`max` — the lowest / highest value seen (−1 / −1 when no samples),
 *                   so the UI can show the occupied range of an analog byte.
 */
export interface ByteValueHistogram {
  byteIndex: number;
  counts: number[];
  samples: number;
  distinct: number;
  min: number;
  max: number;
}

/**
 * The whole histogram profile for ONE id over the window.
 *
 *   • `frames`  — how many frames of this id were in the window.
 *   • `maxByte` — the widest payload (in bytes) seen for this id, so a consumer
 *                 can render exactly the bytes this id actually carries.
 *   • `bytes`   — one {@link ByteValueHistogram} per byte index 0..maxByte-1
 *                 (capped at maxBytes). A byte index this id never carried is
 *                 simply absent (the array is only as long as `maxByte`).
 */
export interface IdByteHistogram {
  id: number;
  frames: number;
  maxByte: number;
  bytes: ByteValueHistogram[];
}

/** The whole-scan result: one profile per id, plus run-wide totals. */
export interface ByteHistogramResult {
  /** Per-id profiles, sorted by descending peak byte-spread (busiest id first). */
  ids: IdByteHistogram[];
  /** Total frames actually analyzed (after the optional allow-list / minFrames). */
  framesAnalyzed: number;
  /** Number of distinct ids in {@link ids}. */
  idCount: number;
  /** The maxBytes the scan ran with (so the UI can size its grid). */
  maxBytes: number;
}

import { byteAt, payloadLen, groupByIdPacked, type PackedFrames } from "./packed.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the per-byte value histogram over a window of frames.
 *
 * Groups `frames` by id internally (order is irrelevant for a histogram, but we
 * preserve arrival order anyway so this matches the heatmap's grouping idiom).
 * Ids with fewer than `minFrames` frames are dropped (nothing measurable). The
 * remaining profiles are sorted so the id with the WIDEST byte spread (the most
 * distinct values in any one byte) comes first — that's the id most likely to
 * carry a rich analog signal, which is what the operator is hunting for.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames   the windowed scan frames (the caller slices the ring window).
 * @param allowIds optional id allow-list; empty/undefined = all ids.
 * @param config   optional threshold overrides.
 */
export function byteHistogram(
  frames: ReadonlyArray<HistogramFrame>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<ByteHistogramConfig> = {},
): ByteHistogramResult {
  const cfg: ByteHistogramConfig = { ...BYTE_HISTOGRAM_DEFAULTS, ...config };
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;

  // Group payloads by id, preserving arrival order.
  const byId = new Map<number, ArrayLike<number>[]>();
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // A Uint8Array (the ring's payload) is already byte-clamped and indexable →
    // keep it as-is (zero-copy). A plain number[] (a decoder/test) may carry an
    // out-of-range value, so defensively copy+clamp only that case.
    group.push(f.data instanceof Uint8Array ? f.data : Array.from(f.data, (b) => b & 0xff));
  }

  const ids: IdByteHistogram[] = [];
  let framesAnalyzed = 0;
  for (const [id, group] of byId) {
    if (group.length < cfg.minFrames) continue;
    const profile = profileOneId(id, group, cfg.maxBytes);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  // Richest id first (see compareRichest).
  ids.sort(compareRichest);

  return {
    ids,
    framesAnalyzed,
    idCount: ids.length,
    maxBytes: cfg.maxBytes,
  };
}

/**
 * Packed-window variant of {@link byteHistogram} (DESIGN §6.1.4 step 3b). Same
 * output, but reads a columnar {@link PackedFrames} via index lists + byteAt — no
 * per-frame payload objects. Used by the synchronous worker Hunt scans; the
 * frame-based {@link byteHistogram} stays for the pure Node tests / arbitrary-width
 * callers. An equivalence test pins packed ≡ frame, bit-identical.
 */
export function byteHistogramPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<ByteHistogramConfig> = {},
): ByteHistogramResult {
  const cfg: ByteHistogramConfig = { ...BYTE_HISTOGRAM_DEFAULTS, ...config };
  const byId = groupByIdPacked(p, allowIds);

  const ids: IdByteHistogram[] = [];
  let framesAnalyzed = 0;
  for (const [id, indices] of byId) {
    if (indices.length < cfg.minFrames) continue;
    const profile = profileOneIdPacked(id, p, indices, cfg.maxBytes);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  ids.sort(compareRichest);
  return { ids, framesAnalyzed, idCount: ids.length, maxBytes: cfg.maxBytes };
}

/**
 * Richest id first: sort by the id's PEAK distinct-value count across its bytes
 * (an analog byte spreads over many values), then by frame count (more evidence
 * wins ties), then by id (stable, deterministic). Shared by both entry points.
 */
function compareRichest(a: IdByteHistogram, b: IdByteHistogram): number {
  const pa = peakDistinct(a);
  const pb = peakDistinct(b);
  if (pb !== pa) return pb - pa;
  if (b.frames !== a.frames) return b.frames - a.frames;
  return a.id - b.id;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id profiling
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the per-byte histograms for one id's payloads.
 *
 * For each byte index up to min(maxByte, maxBytes), we tally a 256-bin count of
 * the values that byte took over the frames that carry it, and derive distinct /
 * min / max. A byte present on only SOME frames (short DLC) is counted only on
 * the frames where it exists — never zero-filled.
 */
function profileOneId(id: number, payloads: ArrayLike<number>[], maxBytes: number): IdByteHistogram {
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;

  // We only histogram up to the configured cap (classic CAN = 8); a wider
  // payload is clamped so the output never exceeds maxBytes byte slots.
  const byteCount = Math.min(maxByte, maxBytes);

  const bytes: ByteValueHistogram[] = [];
  for (let i = 0; i < byteCount; i++) {
    const counts = new Array<number>(BYTE_VALUE_BINS).fill(0);
    let samples = 0;
    let distinct = 0;
    let min = -1;
    let max = -1;
    for (const p of payloads) {
      // SHORT-DLC: only sample frames long enough to carry byte i.
      if (i >= p.length) continue;
      const v = p[i]; // already clamped to 0..255 by the defensive copy above.
      if (counts[v] === 0) distinct++; // first time we see this value
      counts[v]++;
      samples++;
      if (min < 0 || v < min) min = v;
      if (v > max) max = v;
    }
    bytes.push({ byteIndex: i, counts, samples, distinct, min, max });
  }

  return { id, frames: payloads.length, maxByte, bytes };
}

/**
 * Packed twin of {@link profileOneId}: identical tally, but reads frame `i`'s
 * byte `bi` via byteAt(p, i, bi) over an index list instead of a payload array.
 * Short-DLC handling is preserved via payloadLen.
 */
function profileOneIdPacked(id: number, p: PackedFrames, indices: number[], maxBytes: number): IdByteHistogram {
  let maxByte = 0;
  for (const i of indices) {
    const len = payloadLen(p, i);
    if (len > maxByte) maxByte = len;
  }
  const byteCount = Math.min(maxByte, maxBytes);

  const bytes: ByteValueHistogram[] = [];
  for (let bi = 0; bi < byteCount; bi++) {
    const counts = new Array<number>(BYTE_VALUE_BINS).fill(0);
    let samples = 0;
    let distinct = 0;
    let min = -1;
    let max = -1;
    for (const i of indices) {
      // SHORT-DLC: only sample frames long enough to carry byte bi.
      if (bi >= payloadLen(p, i)) continue;
      const v = byteAt(p, i, bi);
      if (counts[v] === 0) distinct++;
      counts[v]++;
      samples++;
      if (min < 0 || v < min) min = v;
      if (v > max) max = v;
    }
    bytes.push({ byteIndex: bi, counts, samples, distinct, min, max });
  }

  return { id, frames: indices.length, maxByte, bytes };
}

/** The maximum distinct-value count across an id's bytes (0 if it has none). */
function peakDistinct(p: IdByteHistogram): number {
  let m = 0;
  for (const b of p.bytes) if (b.distinct > m) m = b.distinct;
  return m;
}
