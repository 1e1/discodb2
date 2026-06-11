// discodb2 — PASSIVE analyzer: the SIGNAL-DISCOVERY SWEEP (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → passive scan analyzers (the Hunt "Scan"
// sub-view). This is the THIRD passive analyzer, sibling to the BIT-ACTIVITY
// HEATMAP (bit-activity.ts) and the PER-BYTE VALUE HISTOGRAM (byte-histogram.ts).
// Like them it takes NO operator action: it scans the capture buffer and surfaces
// structure automatically. It is SavvyCAN's "signal discovery / range state"
// analog.
//
// Where the heatmap answers "which BITS move?" and the histogram "HOW is a byte's
// value distributed?", this analyzer answers the next question: "if I read THIS
// bit-range as a NUMBER under THIS convention, does it behave like a real analog
// signal?". For each id it SWEEPS candidate loci × conventions and RANKS the ones
// that vary like a physical quantity:
//
//   • conventions swept: width ∈ {8, 16} (optionally 12), byteOrder ∈ {little,
//     big}, signed ∈ {false, true}, and a small set of common VAG scale factors
//     {1, 0.1, 0.25, 0.5, 0.01, 0.05}.
//   • a candidate's locus is (byteIndex, bitStart, width, byteOrder, signed,
//     factor); bitStart is the GLOBAL CAN bit index (byteIndex*8 for a byte-aligned
//     little/Intel field, the DBC "sawtooth" MSB for big/Motorola), exactly the
//     numbering decode.ts uses, so a promoted candidate decodes identically.
//
// "PHYSICALLY PLAUSIBLE" = the candidate is
//   1. NON-CONSTANT  — its observed range is > 0 (a constant carries no signal),
//   2. BOUNDED       — every decoded sample is finite (integer decode always is),
//   3. SMOOTHLY VARYING — it moves CONTINUOUSLY: small sample-to-sample steps
//      relative to its observed range. A real analog signal (speed, rpm, fuel,
//      temperature) ramps; a free-running counter, a checksum, or random noise
//      JUMPS all over its range each frame. We capture this with the SMOOTHNESS
//      score below.
//
// Counter/checksum byte slots flagged by the Brick-0 tagger are EXCLUDED up front
// (a +1 counter is perfectly "smooth" until it wraps, so it would otherwise score
// well; the tagger already pins it precisely — see tagger.ts excludedBytes).
//
// Pure & framework-free (like tagger.ts / bit-activity.ts / byte-histogram.ts):
// no Svelte/Vite/DOM-only deps; runs in the cockpit, a Web Worker, or a plain
// Node test runner. Mutates nothing, allocates fresh output.
//
// SHORT-DLC handling matches the rest of the stack: a candidate is only SAMPLED
// on frames long enough to carry its whole bit-range; frames too short are skipped
// (a missing byte is not a value-0 sample), never zero-filled.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the scan, in arrival order, on the backend µs clock. `data`
 * is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. This is the SAME
 * shape the bit-activity / histogram analyzers use (and a structural superset of
 * the tagger's RawFrame), so the cockpit seam can pass one mapped array to all.
 * The analyzer itself does not read `tUs` — the caller has already sliced the
 * window — but accepting it keeps the seam a trivial pass-through.
 */
export interface SignalFrame {
  id: number;
  tUs: number;
  data: number[];
}

/** A bit-range interpretation convention (mirrors decode.ts's Signal fields). */
export type ByteOrder = "little" | "big";

/** Tunable thresholds + the convention sweep. Kept local & overridable. */
export interface SignalDiscoveryConfig {
  /** Max byte slots to scan a candidate START at (classic CAN ≤8 bytes). */
  maxBytes: number;
  /**
   * An id needs at least this many frames before its candidates are trusted —
   * smoothness over a handful of samples is meaningless. Higher than the
   * histogram floor: a ramp only looks like a ramp over many samples.
   */
  minFrames: number;
  /**
   * A candidate must take at least this many DISTINCT decoded values to be
   * considered an analog signal. Rejects on/off flags and near-constants (those
   * are the histogram's / flag-mode's job, not signal discovery).
   */
  minDistinct: number;
  /** Candidate widths (in bits) to sweep. 12 is opt-in (some VAG fields). */
  widths: number[];
  /** Byte orders to sweep. */
  byteOrders: ByteOrder[];
  /** Signedness interpretations to sweep. */
  signedness: boolean[];
  /** Common VAG scale factors to sweep (display only; does not affect ranking). */
  factors: number[];
  /**
   * The jitter at/above which SMOOTHNESS scores 0. jitter = median absolute
   * consecutive step ÷ observed range. A real analog signal sampled often has a
   * jitter well below this; a counter/noise sits at or above it. 0.5 means "if a
   * typical step is half the whole range, that's not a smooth signal".
   */
  jitterReference: number;
  /** Max candidates to return (the UI surfaces the top few). */
  maxCandidates: number;
}

export const SIGNAL_DISCOVERY_DEFAULTS: SignalDiscoveryConfig = {
  maxBytes: 8, // classic CAN payload width
  minFrames: 12, // a ramp needs samples to read as a ramp
  minDistinct: 4, // more than a flag/enum's handful of states
  widths: [8, 16], // 12 is opt-in via config (some VAG fields)
  byteOrders: ["little", "big"],
  signedness: [false, true],
  factors: [1, 0.1, 0.25, 0.5, 0.01, 0.05], // common VAG scales
  jitterReference: 0.5,
  maxCandidates: 12,
};

/** A byte slot to exclude (counter/checksum), keyed `"id:byteIndex"` — the same
 *  key shape the tagger's excludedBytes() produces, so the seam can pass it in. */
export type ExcludedSet = ReadonlySet<string>;

/**
 * One ranked signal-discovery candidate: "read THIS locus under THIS convention
 * and it behaves like a real analog signal".
 *
 *   • locus    — byteIndex / bitStart (GLOBAL CAN bit index) / width / byteOrder /
 *                signed / factor; bitStart + byteOrder map 1:1 onto decode.ts, so
 *                a promoted signal decodes identically.
 *   • score    — overall plausibility in [0,1], higher = better (smoothness ×
 *                a coverage weight). Comparable WITHIN one result set.
 *   • smoothness — the headline metric (see scoreLocus): how continuously the
 *                value moves, in [0,1]. 1 = perfectly smooth ramp, 0 = jumps as
 *                much as a counter/noise.
 *   • distinct / min / max / samples — supporting evidence for the UI.
 */
export interface SignalCandidate {
  /** Stable, deterministic key for UI selection (id:bitStart:width:order:signed). */
  key: string;
  id: number;
  byteIndex: number;
  /** Global CAN bit index of the signal start (decode.ts numbering). */
  bitStart: number;
  width: number;
  byteOrder: ByteOrder;
  signed: boolean;
  /** Best-guess display scale factor (does not affect ranking). */
  factor: number;
  /** Overall plausibility in [0,1] (smoothness weighted by coverage). */
  score: number;
  /** The smoothness sub-score in [0,1] (the physical-continuity metric). */
  smoothness: number;
  /** Distinct decoded RAW values observed. */
  distinct: number;
  /** Observed min / max of the SCALED (×factor) value, for the UI. */
  min: number;
  max: number;
  /** Frames the candidate was actually sampled on (long enough to carry it). */
  samples: number;
}

/** The whole-scan result: ranked candidates plus run-wide totals. */
export interface SignalDiscoveryResult {
  /** Top candidates across all ids, best (most plausible) first. */
  candidates: SignalCandidate[];
  /** Total frames actually analyzed (after the optional allow-list / minFrames). */
  framesAnalyzed: number;
  /** Number of distinct ids that contributed ≥1 scored candidate. */
  idCount: number;
  /** How many byte slots were excluded as counter/checksum. */
  excludedCount: number;
}

import { byteAt, payloadLen, groupByIdPacked, type PackedFrames } from "./packed.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Sweep candidate signal interpretations over a window of frames and rank the
 * physically-plausible ones.
 *
 * Groups `frames` by id (arrival order preserved — that order is what smoothness
 * needs). Ids with fewer than `minFrames` frames are dropped. For each id, for
 * each (byteIndex, width, byteOrder, signed) convention, the candidate's RAW
 * value sequence is decoded and scored; constants, near-flat, and noisy/jumpy
 * candidates are rejected. The best factor is chosen per surviving locus (display
 * only). Survivors are ranked best-first and capped at `maxCandidates`.
 *
 * Pure: does not mutate `frames`, `excluded`, or `config`.
 *
 * @param frames   the windowed scan frames (the caller slices the ring window).
 * @param allowIds optional id allow-list; empty/undefined = all ids.
 * @param excluded optional counter/checksum byte slots to skip ("id:byteIndex").
 * @param config   optional threshold / sweep overrides.
 */
export function signalDiscovery(
  frames: ReadonlyArray<SignalFrame>,
  allowIds?: ReadonlyArray<number>,
  excluded?: ExcludedSet,
  config: Partial<SignalDiscoveryConfig> = {},
): SignalDiscoveryResult {
  const cfg: SignalDiscoveryConfig = { ...SIGNAL_DISCOVERY_DEFAULTS, ...config };
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;
  const skip = excluded ?? new Set<string>();

  // Group payloads by id, preserving arrival order (the smoothness basis).
  const byId = new Map<number, number[][]>();
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // Defensive copy clamped to bytes so the bit reads below are safe.
    group.push(f.data.map((b) => b & 0xff));
  }

  const all: SignalCandidate[] = [];
  const contributingIds = new Set<number>();
  let framesAnalyzed = 0;
  let excludedCount = 0;
  for (const [id, group] of byId) {
    if (group.length < cfg.minFrames) continue;
    framesAnalyzed += group.length;
    const { candidates, skipped } = sweepOneId(id, group, skip, cfg);
    excludedCount += skipped;
    if (candidates.length > 0) {
      contributingIds.add(id);
      for (const c of candidates) all.push(c);
    }
  }

  // Best first (see compareCandidates). Take the top `maxCandidates`.
  all.sort(compareCandidates);

  return {
    candidates: all.slice(0, cfg.maxCandidates),
    framesAnalyzed,
    idCount: contributingIds.size,
    excludedCount,
  };
}

/**
 * Packed-window variant of {@link signalDiscovery} (DESIGN §6.1.4 step 3b). Same
 * output, but reads a columnar {@link PackedFrames} via index lists + byteAt — no
 * per-frame payload objects. Used by the synchronous worker Hunt scans; the
 * frame-based {@link signalDiscovery} stays for the pure Node tests / arbitrary-width
 * callers. An equivalence test pins packed ≡ frame, bit-identical.
 */
export function signalDiscoveryPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  excluded?: ExcludedSet,
  config: Partial<SignalDiscoveryConfig> = {},
): SignalDiscoveryResult {
  const cfg: SignalDiscoveryConfig = { ...SIGNAL_DISCOVERY_DEFAULTS, ...config };
  const skip = excluded ?? new Set<string>();
  const byId = groupByIdPacked(p, allowIds);

  const all: SignalCandidate[] = [];
  const contributingIds = new Set<number>();
  let framesAnalyzed = 0;
  let excludedCount = 0;
  for (const [id, indices] of byId) {
    if (indices.length < cfg.minFrames) continue;
    framesAnalyzed += indices.length;
    const { candidates, skipped } = sweepOneIdPacked(id, p, indices, skip, cfg);
    excludedCount += skipped;
    if (candidates.length > 0) {
      contributingIds.add(id);
      for (const c of candidates) all.push(c);
    }
  }

  all.sort(compareCandidates);
  return { candidates: all.slice(0, cfg.maxCandidates), framesAnalyzed, idCount: contributingIds.size, excludedCount };
}

/** Best first: by score, then more samples, then key (stable). Shared by both paths. */
function compareCandidates(a: SignalCandidate, b: SignalCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.samples !== a.samples) return b.samples - a.samples;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id sweep
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Sweep every (byteIndex, width, byteOrder, signed) convention over one id's
 * ordered payloads and return the surviving plausible candidates.
 *
 * For each surviving LOCUS we score it once (width/order/signed determine the raw
 * sequence; smoothness and distinct/min/max are computed on the RAW sequence so
 * the factor never changes the ranking) and then pick the best display FACTOR.
 *
 * We DEDUPE on the raw locus (id:bitStart:width:order:signed): the factor sweep
 * only affects the displayed scale, so emitting one candidate per locus (with its
 * best factor) keeps the result legible instead of 6× duplicated rows.
 */
function sweepOneId(
  id: number,
  payloads: number[][],
  skip: ExcludedSet,
  cfg: SignalDiscoveryConfig,
): { candidates: SignalCandidate[]; skipped: number } {
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;
  const byteCeil = Math.min(maxByte, cfg.maxBytes);

  const out: SignalCandidate[] = [];
  let skipped = 0;

  for (const width of cfg.widths) {
    const widthBytes = Math.ceil(width / 8);
    // A candidate must fit entirely within the payload: its highest byte index is
    // byteIndex + widthBytes - 1, which must be < byteCeil.
    for (let byteIndex = 0; byteIndex + widthBytes <= byteCeil; byteIndex++) {
      // Exclude any candidate overlapping a tagged counter/checksum byte slot.
      if (overlapsExcluded(id, byteIndex, widthBytes, skip)) {
        skipped++;
        continue;
      }
      for (const byteOrder of cfg.byteOrders) {
        // A WIDTH-8 candidate is byte-aligned and order-agnostic: little and big
        // decode the same single byte, so scan big only for multi-byte widths to
        // avoid emitting an identical duplicate.
        if (width === 8 && byteOrder === "big") continue;
        const bitStart = startBit(byteIndex, width, byteOrder);
        for (const signed of cfg.signedness) {
          const cand = scoreLocus(id, payloads, byteIndex, bitStart, width, byteOrder, signed, cfg);
          if (cand) out.push(cand);
        }
      }
    }
  }

  return { candidates: out, skipped };
}

/** Packed twin of {@link sweepOneId}: same sweep, reads payloads via the index list. */
function sweepOneIdPacked(
  id: number,
  p: PackedFrames,
  indices: number[],
  skip: ExcludedSet,
  cfg: SignalDiscoveryConfig,
): { candidates: SignalCandidate[]; skipped: number } {
  let maxByte = 0;
  for (const i of indices) {
    const len = payloadLen(p, i);
    if (len > maxByte) maxByte = len;
  }
  const byteCeil = Math.min(maxByte, cfg.maxBytes);

  const out: SignalCandidate[] = [];
  let skipped = 0;

  for (const width of cfg.widths) {
    const widthBytes = Math.ceil(width / 8);
    for (let byteIndex = 0; byteIndex + widthBytes <= byteCeil; byteIndex++) {
      if (overlapsExcluded(id, byteIndex, widthBytes, skip)) {
        skipped++;
        continue;
      }
      for (const byteOrder of cfg.byteOrders) {
        if (width === 8 && byteOrder === "big") continue;
        const bitStart = startBit(byteIndex, width, byteOrder);
        for (const signed of cfg.signedness) {
          const cand = scoreLocusPacked(id, p, indices, byteIndex, bitStart, width, byteOrder, signed, cfg);
          if (cand) out.push(cand);
        }
      }
    }
  }

  return { candidates: out, skipped };
}

/** True if a [byteIndex, byteIndex+widthBytes) range touches any excluded slot. */
function overlapsExcluded(id: number, byteIndex: number, widthBytes: number, skip: ExcludedSet): boolean {
  for (let b = byteIndex; b < byteIndex + widthBytes; b++) {
    if (skip.has(`${id}:${b}`)) return true;
  }
  return false;
}

/**
 * The GLOBAL CAN bit index a signal STARTS at, matching decode.ts:
 *   • little (Intel) — bitStart is the signal LSB = byteIndex*8.
 *   • big (Motorola "sawtooth") — bitStart is the signal MSB; for a byte-aligned
 *     big field of width 8k that MSB lives in the FIRST byte's local bit 7, i.e.
 *     global bit byteIndex*8 + 7. decode.ts then walks MSB→LSB across the bytes.
 */
function startBit(byteIndex: number, _width: number, byteOrder: ByteOrder): number {
  return byteOrder === "little" ? byteIndex * 8 : byteIndex * 8 + 7;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-locus scoring — the plausibility metric
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Decode one locus across the ordered payloads and score its physical
 * plausibility. Returns null if the locus is rejected (constant, too few distinct
 * values, or too few samples).
 *
 * THE METRIC. Over the decoded RAW sequence v[0..n-1] (sampled only on frames
 * long enough to carry the whole range):
 *
 *   range  = max(v) − min(v)                      (NON-CONSTANT ⇒ range > 0)
 *   step_i = |v[i] − v[i-1]|                       (consecutive absolute step)
 *   jitter = median(step_i) ÷ range                (typical step vs whole range)
 *   smoothness = clamp(1 − jitter ÷ jitterReference, 0, 1)
 *
 * Why MEDIAN step (not mean): one wrap or one outlier frame shouldn't sink an
 * otherwise smooth ramp, and shouldn't rescue a mostly-jumpy candidate — the
 * median is the robust "typical" step. A continuous analog signal sampled often
 * has tiny typical steps relative to its full range (smoothness → 1); a counter,
 * a checksum, or noise steps by a large fraction of its range every frame
 * (jitter ≥ jitterReference ⇒ smoothness → 0).
 *
 * The overall `score` weights smoothness by COVERAGE — distinct-value richness,
 * saturating: a smooth signal that visits many distinct values is more convincing
 * than one that only ever shows 4. This breaks ties toward the genuinely analog
 * loci without letting raw distinct-count dominate a noisy-but-rich counter
 * (which smoothness has already pushed toward 0).
 */
function scoreLocus(
  id: number,
  payloads: number[][],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  cfg: SignalDiscoveryConfig,
): SignalCandidate | null {
  // Decode the raw sequence, sampling only frames long enough for the full range.
  const widthBytes = Math.ceil(width / 8);
  const raw: number[] = [];
  for (const p of payloads) {
    if (byteIndex + widthBytes > p.length) continue; // SHORT-DLC: skip, don't zero-fill.
    raw.push(decodeRaw(p, bitStart, width, byteOrder, signed));
  }
  return finishCandidate(id, raw, byteIndex, bitStart, width, byteOrder, signed, cfg);
}

/**
 * Packed twin of {@link scoreLocus}: decodes the raw sequence via byteAt over an
 * index list (no per-frame payload objects), then scores it through the SAME
 * {@link finishCandidate} math — so the two paths cannot drift.
 */
function scoreLocusPacked(
  id: number,
  p: PackedFrames,
  indices: number[],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  cfg: SignalDiscoveryConfig,
): SignalCandidate | null {
  const widthBytes = Math.ceil(width / 8);
  const raw: number[] = [];
  for (const idx of indices) {
    const len = payloadLen(p, idx);
    if (byteIndex + widthBytes > len) continue; // SHORT-DLC: skip, don't zero-fill.
    raw.push(decodeRawPacked(p, idx, len, bitStart, width, byteOrder, signed));
  }
  return finishCandidate(id, raw, byteIndex, bitStart, width, byteOrder, signed, cfg);
}

/**
 * Score an already-decoded raw value sequence into a candidate (or reject it).
 * Shared by {@link scoreLocus} (frame path) and {@link scoreLocusPacked} (packed
 * path) — only the decode upstream differs; the plausibility metric lives here.
 */
function finishCandidate(
  id: number,
  raw: number[],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  cfg: SignalDiscoveryConfig,
): SignalCandidate | null {
  if (raw.length < cfg.minFrames) return null; // not enough samples to judge.

  let min = raw[0];
  let max = raw[0];
  const seen = new Set<number>();
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
    seen.add(v);
  }
  const range = max - min;
  if (range <= 0) return null; // CONSTANT — carries no signal.
  if (seen.size < cfg.minDistinct) return null; // too flag-like / near-constant.

  // Consecutive absolute steps → their MEDIAN (robust typical step).
  const steps: number[] = [];
  for (let i = 1; i < raw.length; i++) steps.push(Math.abs(raw[i] - raw[i - 1]));
  const medianStep = median(steps);

  const jitter = medianStep / range; // typical step as a fraction of the range.
  const smoothness = clamp01(1 - jitter / cfg.jitterReference);
  if (smoothness <= 0) return null; // jumps like a counter/noise — not analog.

  // Coverage weight: distinct richness saturating toward 1 (8 distinct ≈ 0.5,
  // 32 ≈ 0.8). A smooth-but-thin candidate still scores, just below a smooth-rich
  // one. Keeps smoothness the dominant factor (it can veto via the <=0 reject).
  const coverage = seen.size / (seen.size + 8);
  const score = smoothness * (0.7 + 0.3 * coverage);

  // Best display factor (does not affect ranking): pick the SMALLEST factor whose
  // scaled full range stays within a "human" magnitude (≤ ~1000), so e.g. an
  // rpm-like 0..16000 raw range prefers a small factor and fuel-like small ranges
  // prefer 1. Falls back to 1 if none qualifies.
  const factor = bestFactor(range, cfg.factors);

  return {
    key: `${id}:${bitStart}:${width}:${byteOrder}:${signed ? "s" : "u"}`,
    id,
    byteIndex,
    bitStart,
    width,
    byteOrder,
    signed,
    factor,
    score,
    smoothness,
    distinct: seen.size,
    min: min * factor,
    max: max * factor,
    samples: raw.length,
  };
}

/**
 * Decode a raw integer from a payload at a global CAN bit index, applying the SAME
 * conventions as src/protocol/decode.ts (LSB-first little; Motorola "sawtooth"
 * big; two's-complement sign). Reimplemented here (not imported) because this
 * file is in the PURE shared package and may not depend on the cockpit's decode;
 * the bit walk is a faithful copy of signalBitOrder + extractRaw. Values fit in a
 * JS number safely for the swept widths (≤16, well under 53 bits).
 */
function decodeRaw(
  data: number[],
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
): number {
  let raw = 0;
  if (byteOrder === "little") {
    // Intel: contiguous ascending from the LSB.
    for (let i = 0; i < width; i++) {
      if (getBit(data, bitStart + i)) raw += 2 ** i;
    }
  } else {
    // Motorola "sawtooth": bitStart is the MSB; walk MSB→LSB, building LSB-first.
    let byteIndex = bitStart >> 3;
    let bitInByte = bitStart & 7;
    for (let i = width - 1; i >= 0; i--) {
      const canBit = byteIndex * 8 + bitInByte;
      if (getBit(data, canBit)) raw += 2 ** i;
      if (bitInByte === 0) {
        bitInByte = 7;
        byteIndex += 1;
      } else {
        bitInByte -= 1;
      }
    }
  }
  if (signed && raw >= 2 ** (width - 1)) raw -= 2 ** width;
  return raw;
}

/** Read a single bit (0/1) from a payload at a standard CAN bit index (0 = LSB). */
function getBit(data: number[], bitIndex: number): number {
  const byteIndex = bitIndex >> 3;
  const bitInByte = bitIndex & 7;
  if (byteIndex < 0 || byteIndex >= data.length) return 0;
  return (data[byteIndex] >> bitInByte) & 1;
}

/** Packed twin of {@link decodeRaw}: same bit walk, reading frame `idx` via byteAt. */
function decodeRawPacked(
  p: PackedFrames,
  idx: number,
  len: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
): number {
  let raw = 0;
  if (byteOrder === "little") {
    for (let i = 0; i < width; i++) {
      if (getBitPacked(p, idx, len, bitStart + i)) raw += 2 ** i;
    }
  } else {
    let byteIndex = bitStart >> 3;
    let bitInByte = bitStart & 7;
    for (let i = width - 1; i >= 0; i--) {
      const canBit = byteIndex * 8 + bitInByte;
      if (getBitPacked(p, idx, len, canBit)) raw += 2 ** i;
      if (bitInByte === 0) {
        bitInByte = 7;
        byteIndex += 1;
      } else {
        bitInByte -= 1;
      }
    }
  }
  if (signed && raw >= 2 ** (width - 1)) raw -= 2 ** width;
  return raw;
}

/** Packed twin of {@link getBit}: bit at a CAN index of frame `idx` (len = its dlc). */
function getBitPacked(p: PackedFrames, idx: number, len: number, bitIndex: number): number {
  const byteIndex = bitIndex >> 3;
  const bitInByte = bitIndex & 7;
  if (byteIndex < 0 || byteIndex >= len) return 0;
  return (byteAt(p, idx, byteIndex) >> bitInByte) & 1;
}

/* ────────────────────────────────────────────────────────────────────────
 * Small numeric helpers (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/** Median of a non-empty list (0 for an empty list). Does not mutate the input. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Clamp to [0,1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pick the smallest factor whose scaled range stays within a human magnitude
 * (≤ 1000), preferring larger raw ranges to small factors. Display-only — chosen
 * after ranking so it can never change which candidates win.
 */
function bestFactor(range: number, factors: number[]): number {
  // Sort a COPY ascending; the first factor that keeps range*factor ≤ 1000 wins.
  const sorted = [...factors].sort((a, b) => a - b);
  for (const f of sorted) {
    if (range * f <= 1000) return f;
  }
  // Everything overflows the human band → the smallest factor is the best we can do.
  return sorted.length ? sorted[0] : 1;
}
