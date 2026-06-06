// discodb2 — PASSIVE analyzer: CORRELATION AGAINST A KNOWN SIGNAL (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → passive scan analyzers (the Hunt "Scan"
// sub-view). This is the FIFTH passive analyzer, sibling to the BIT-ACTIVITY
// HEATMAP (bit-activity.ts), the PER-BYTE VALUE HISTOGRAM (byte-histogram.ts),
// the SIGNAL-DISCOVERY SWEEP (signal-discovery.ts) and the CO-OCCURRENCE OF
// CHANGES matrix (co-occurrence.ts).
//
// Unlike the other four, this one takes ONE piece of operator input: a REFERENCE.
// The operator already KNOWS one signal (rpm, speed, …) — a §3.5 signal they
// decoded earlier — and wants to find an UNKNOWN that MOVES WITH it. The textbook
// use case (project notes): you have RPM and SPEED; the GEAR is rpm/speed, so the
// gear byte is the locus whose value tracks rpm (or speed) over the window. More
// generally: pick the reference you understand, and the analyzer ranks every
// candidate locus by how tightly its decoded series CO-VARIES with the reference.
//
// Where signal-discovery asks "does THIS locus look analog ON ITS OWN?" (intrinsic
// smoothness), this asks "does THIS locus TRACK a series I ALREADY HAVE?"
// (relationship to a known reference). The two are complementary: a locus can be
// smooth without tracking the reference, and can track the reference without being
// especially smooth.
//
// THE METRIC — SPEARMAN RANK CORRELATION (ρ).
//   • We rank each series and correlate the ranks (Pearson on ranks). Spearman,
//     not Pearson, because the relationship we hunt for is MONOTONE, not linear:
//     a gear that rises with rpm, a temperature read under an unknown scale/offset,
//     a value with a nonlinear-but-monotone mapping — all show |ρ| near 1 even
//     though a straight-line Pearson fit would under-score them. Ties are handled
//     with AVERAGE ranks (the standard correction), so a flag-like reference with
//     long constant runs doesn't distort the ranking.
//   • |ρ| is the headline: +1 = moves the same way, −1 = moves opposite (a value
//     that FALLS as the reference RISES is just as informative — e.g. an inverse
//     relationship), 0 = unrelated. We rank by |ρ| and report the sign.
//
// ALIGNMENT. The reference and a candidate live on DIFFERENT ids that arrive on
// DIFFERENT cadences, so their frames don't line up 1:1. We resample onto a COMMON
// time base: for each reference sample (tUs, value) we hold the candidate's most
// recent value at-or-before that tUs (zero-order hold / "last known value"), the
// natural reading for an asynchronous bus. Candidate samples before the first
// reference sample, or reference samples before the first candidate sample, are
// dropped (no value to pair). This makes the correlation well-defined across ids
// of different rates without inventing data.
//
// Candidate loci reuse the SAME enumeration + decode conventions as
// signal-discovery (width ∈ {8,16}, byteOrder ∈ {little,big}, signed ∈ {f,t}),
// and the SAME global-CAN bit numbering as decode.ts, so a promoted candidate
// decodes identically. Counter/checksum byte slots flagged by the Brick-0 tagger
// are EXCLUDED up front (same `"id:byteIndex"` set as signal-discovery): a counter
// can correlate spuriously with any rising reference over a non-wrapping window.
//
// Pure & framework-free (like the sibling analyzers): no Svelte/Vite/DOM-only
// deps; runs in the cockpit, a Web Worker, or a plain Node test runner. Mutates
// nothing, allocates fresh output. SHORT-DLC: a candidate is only sampled on
// frames long enough to carry its whole bit-range; short frames are skipped, never
// zero-filled.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the scan, in arrival order, on the backend µs clock. `data`
 * is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. Identical shape to
 * the other analyzers' frame (a structural superset of the tagger's RawFrame), so
 * the cockpit seam passes one mapped array to all. Unlike the other analyzers this
 * one DOES read `tUs` — it is the time base the candidate is resampled onto.
 */
export interface CorrelationFrame {
  id: number;
  tUs: number;
  data: number[];
}

/** One reference sample: a decoded value at a backend-µs instant, arrival order. */
export interface ReferenceSample {
  tUs: number;
  value: number;
}

/** A bit-range interpretation convention (mirrors decode.ts's Signal fields). */
export type ByteOrder = "little" | "big";

/** A byte slot to exclude (counter/checksum), keyed `"id:byteIndex"` — the same
 *  key shape the tagger's excludedBytes() produces, so the seam can pass it in. */
export type ExcludedSet = ReadonlySet<string>;

/** Tunable thresholds + the convention sweep. Kept local & overridable. */
export interface SignalCorrelationConfig {
  /** Max byte slots to scan a candidate START at (classic CAN ≤8 bytes). */
  maxBytes: number;
  /**
   * A candidate must share at least this many ALIGNED sample pairs with the
   * reference before its ρ is trusted — a correlation over a handful of points is
   * meaningless. (The reference is held over the candidate's time base, so this is
   * the number of reference samples that fell within the candidate's coverage.)
   */
  minPairs: number;
  /**
   * A candidate's decoded series must take at least this many DISTINCT values to
   * be ranked. A near-constant locus correlates degenerately (all ranks tie) and
   * carries no relationship; this rejects it. 2 keeps genuine 2-state relationships
   * (e.g. a gear that only visits two gears in the window) while dropping constants.
   */
  minDistinct: number;
  /** Candidate widths (in bits) to sweep. 12 is opt-in (some VAG fields). */
  widths: number[];
  /** Byte orders to sweep. */
  byteOrders: ByteOrder[];
  /** Signedness interpretations to sweep. */
  signedness: boolean[];
  /**
   * Minimum |ρ| to keep a candidate. Below this the relationship is too weak to
   * surface as "tracks the reference". 0.5 is a moderate monotone association.
   */
  minAbsRho: number;
  /** Max candidates to return (the UI surfaces the top few). */
  maxCandidates: number;
}

export const SIGNAL_CORRELATION_DEFAULTS: SignalCorrelationConfig = {
  maxBytes: 8, // classic CAN payload width
  minPairs: 8, // a correlation over fewer points is noise
  minDistinct: 2, // reject constants; keep genuine 2-state relations
  widths: [8, 16], // 12 is opt-in via config (some VAG fields)
  byteOrders: ["little", "big"],
  signedness: [false, true],
  minAbsRho: 0.5, // moderate monotone association floor
  maxCandidates: 12,
};

/**
 * One ranked correlation candidate: "read THIS locus under THIS convention and its
 * series TRACKS the reference with this Spearman ρ".
 *
 *   • locus    — byteIndex / bitStart (GLOBAL CAN bit index) / width / byteOrder /
 *                signed; bitStart + byteOrder map 1:1 onto decode.ts, so a promoted
 *                signal decodes identically.
 *   • rho      — Spearman rank correlation with the reference, in [-1, 1].
 *   • absRho   — |rho|; the ranking key (sign reported separately).
 *   • pairs    — aligned (reference, candidate) sample pairs the ρ was computed on.
 *   • distinct — distinct decoded RAW values of the candidate over those pairs.
 */
export interface CorrelationCandidate {
  /** Stable, deterministic key for UI selection (id:bitStart:width:order:signed). */
  key: string;
  id: number;
  byteIndex: number;
  /** Global CAN bit index of the signal start (decode.ts numbering). */
  bitStart: number;
  width: number;
  byteOrder: ByteOrder;
  signed: boolean;
  /** Spearman rank correlation with the reference, in [-1, 1]. */
  rho: number;
  /** |rho| — the ranking magnitude. */
  absRho: number;
  /** Aligned sample pairs the correlation was computed over. */
  pairs: number;
  /** Distinct decoded raw values observed over the aligned window. */
  distinct: number;
}

/** The whole-scan result: ranked candidates plus run-wide totals. */
export interface SignalCorrelationResult {
  /** Top candidates across all ids, strongest |ρ| first. */
  candidates: CorrelationCandidate[];
  /** Reference samples actually used (after dropping any pre-/post-coverage). */
  referenceSamples: number;
  /** Total frames actually analyzed (after the optional allow-list). */
  framesAnalyzed: number;
  /** Number of distinct ids that contributed ≥1 ranked candidate. */
  idCount: number;
  /** How many candidate byte slots were excluded as counter/checksum. */
  excludedCount: number;
}

import { byteAt, payloadLen, groupByIdPacked, type PackedFrames } from "./packed.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Rank candidate loci by Spearman correlation against a known reference series.
 *
 * Groups `frames` by id (arrival order preserved — that order + tUs is the time
 * base the candidate is resampled onto). For each id, for each (byteIndex, width,
 * byteOrder, signed) convention, the candidate's decoded series is aligned to the
 * reference (zero-order hold over the candidate's samples), and Spearman ρ is
 * computed over the aligned pairs. Constants, too-short overlaps, and weak
 * correlations are rejected. Survivors are ranked by |ρ| and capped.
 *
 * Pure: does not mutate `frames`, `reference`, `excluded`, or `config`.
 *
 * @param frames    the windowed scan frames (the caller slices the ring window).
 * @param reference the decoded reference series (tUs ascending), e.g. the operator's
 *                  known rpm/speed signal over the same window. Must be ≥ minPairs.
 * @param allowIds  optional id allow-list; empty/undefined = all ids.
 * @param excluded  optional counter/checksum byte slots to skip ("id:byteIndex").
 * @param config    optional threshold / sweep overrides.
 */
export function signalCorrelation(
  frames: ReadonlyArray<CorrelationFrame>,
  reference: ReadonlyArray<ReferenceSample>,
  allowIds?: ReadonlyArray<number>,
  excluded?: ExcludedSet,
  config: Partial<SignalCorrelationConfig> = {},
): SignalCorrelationResult {
  const cfg: SignalCorrelationConfig = { ...SIGNAL_CORRELATION_DEFAULTS, ...config };
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;
  const skip = excluded ?? new Set<string>();

  // Sort the reference by tUs ascending (the alignment search needs monotone time)
  // without mutating the caller's array. Drop non-finite values defensively.
  const ref = [...reference]
    .filter((s) => Number.isFinite(s.tUs) && Number.isFinite(s.value))
    .sort((a, b) => a.tUs - b.tUs);

  // Not enough reference to correlate anything → empty result (well-defined).
  if (ref.length < cfg.minPairs) {
    return {
      candidates: [],
      referenceSamples: ref.length,
      framesAnalyzed: 0,
      idCount: 0,
      excludedCount: 0,
    };
  }

  // Group payloads + their tUs by id, preserving arrival order (the time base).
  const byId = new Map<number, { tUs: number[]; data: number[][] }>();
  let framesAnalyzed = 0;
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let group = byId.get(f.id);
    if (group === undefined) {
      group = { tUs: [], data: [] };
      byId.set(f.id, group);
    }
    group.tUs.push(f.tUs);
    // Defensive copy clamped to bytes so the bit reads below are safe.
    group.data.push(f.data.map((b) => b & 0xff));
    framesAnalyzed++;
  }

  const all: CorrelationCandidate[] = [];
  const contributingIds = new Set<number>();
  let excludedCount = 0;
  for (const [id, group] of byId) {
    const { candidates, skipped } = sweepOneId(id, group.tUs, group.data, ref, skip, cfg);
    excludedCount += skipped;
    if (candidates.length > 0) {
      contributingIds.add(id);
      for (const c of candidates) all.push(c);
    }
  }

  // Strongest relationship first (see compareCorrelation). Take top `maxCandidates`.
  all.sort(compareCorrelation);

  return {
    candidates: all.slice(0, cfg.maxCandidates),
    referenceSamples: ref.length,
    framesAnalyzed,
    idCount: contributingIds.size,
    excludedCount,
  };
}

/**
 * Packed-window variant of {@link signalCorrelation} (DESIGN §6.1.4 step 3b). Same
 * output, but reads a columnar {@link PackedFrames} via index lists + byteAt — no
 * per-frame payload objects. Used by the synchronous worker Hunt scans; the
 * frame-based {@link signalCorrelation} stays for the pure Node tests. An
 * equivalence test pins packed ≡ frame, bit-identical.
 */
export function signalCorrelationPacked(
  p: PackedFrames,
  reference: ReadonlyArray<ReferenceSample>,
  allowIds?: ReadonlyArray<number>,
  excluded?: ExcludedSet,
  config: Partial<SignalCorrelationConfig> = {},
): SignalCorrelationResult {
  const cfg: SignalCorrelationConfig = { ...SIGNAL_CORRELATION_DEFAULTS, ...config };
  const skip = excluded ?? new Set<string>();

  const ref = [...reference]
    .filter((s) => Number.isFinite(s.tUs) && Number.isFinite(s.value))
    .sort((a, b) => a.tUs - b.tUs);

  if (ref.length < cfg.minPairs) {
    return { candidates: [], referenceSamples: ref.length, framesAnalyzed: 0, idCount: 0, excludedCount: 0 };
  }

  const byId = groupByIdPacked(p, allowIds);
  let framesAnalyzed = 0;
  for (const indices of byId.values()) framesAnalyzed += indices.length;

  const all: CorrelationCandidate[] = [];
  const contributingIds = new Set<number>();
  let excludedCount = 0;
  for (const [id, indices] of byId) {
    const { candidates, skipped } = sweepOneIdPacked(id, p, indices, ref, skip, cfg);
    excludedCount += skipped;
    if (candidates.length > 0) {
      contributingIds.add(id);
      for (const c of candidates) all.push(c);
    }
  }

  all.sort(compareCorrelation);
  return {
    candidates: all.slice(0, cfg.maxCandidates),
    referenceSamples: ref.length,
    framesAnalyzed,
    idCount: contributingIds.size,
    excludedCount,
  };
}

/** Strongest first: by |ρ|, then more pairs, then key (stable). Shared by both paths. */
function compareCorrelation(a: CorrelationCandidate, b: CorrelationCandidate): number {
  if (b.absRho !== a.absRho) return b.absRho - a.absRho;
  if (b.pairs !== a.pairs) return b.pairs - a.pairs;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id sweep
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Sweep every (byteIndex, width, byteOrder, signed) convention over one id's
 * ordered payloads, correlate each candidate's decoded series with the reference,
 * and return the survivors.
 *
 * We DEDUPE on the raw locus (id:bitStart:width:order:signed) implicitly: each
 * convention yields one candidate.
 */
function sweepOneId(
  id: number,
  tUs: number[],
  payloads: number[][],
  ref: ReadonlyArray<ReferenceSample>,
  skip: ExcludedSet,
  cfg: SignalCorrelationConfig,
): { candidates: CorrelationCandidate[]; skipped: number } {
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;
  const byteCeil = Math.min(maxByte, cfg.maxBytes);

  const out: CorrelationCandidate[] = [];
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
        // decode the same single byte, so scan big only for multi-byte widths.
        if (width === 8 && byteOrder === "big") continue;
        const bitStart = startBit(byteIndex, width, byteOrder);
        for (const signed of cfg.signedness) {
          const cand = correlateLocus(id, tUs, payloads, byteIndex, bitStart, width, byteOrder, signed, ref, cfg);
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
 * The GLOBAL CAN bit index a signal STARTS at, matching decode.ts (identical to
 * signal-discovery.ts):
 *   • little (Intel) — bitStart is the signal LSB = byteIndex*8.
 *   • big (Motorola "sawtooth") — bitStart is the signal MSB; for a byte-aligned
 *     big field that MSB is global bit byteIndex*8 + 7.
 */
function startBit(byteIndex: number, _width: number, byteOrder: ByteOrder): number {
  return byteOrder === "little" ? byteIndex * 8 : byteIndex * 8 + 7;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-locus correlation
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Decode one locus across the id's ordered payloads, resample it onto the
 * reference's time base, and compute Spearman ρ. Returns null when the candidate
 * is rejected (too few aligned pairs, near-constant, or |ρ| below the floor).
 */
function correlateLocus(
  id: number,
  tUs: number[],
  payloads: number[][],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  ref: ReadonlyArray<ReferenceSample>,
  cfg: SignalCorrelationConfig,
): CorrelationCandidate | null {
  // Decode the candidate's (tUs, value) series, sampling only frames long enough
  // to carry the whole range (SHORT-DLC: skip, never zero-fill). tUs[] and
  // payloads[] are parallel arrays in arrival order, so candTUs stays ascending.
  const widthBytes = Math.ceil(width / 8);
  const candTUs: number[] = [];
  const candVal: number[] = [];
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    if (byteIndex + widthBytes > p.length) continue;
    candTUs.push(tUs[i]);
    candVal.push(decodeRaw(p, bitStart, width, byteOrder, signed));
  }
  return finishCorrelation(id, candTUs, candVal, byteIndex, bitStart, width, byteOrder, signed, ref, cfg);
}

/**
 * Packed twin of {@link sweepOneId}: same sweep, reads payloads/tUs via the index
 * list into the candidate series, then correlates through the SAME {@link
 * finishCorrelation} so the paths cannot drift.
 */
function sweepOneIdPacked(
  id: number,
  p: PackedFrames,
  indices: number[],
  ref: ReadonlyArray<ReferenceSample>,
  skip: ExcludedSet,
  cfg: SignalCorrelationConfig,
): { candidates: CorrelationCandidate[]; skipped: number } {
  let maxByte = 0;
  for (const i of indices) {
    const len = payloadLen(p, i);
    if (len > maxByte) maxByte = len;
  }
  const byteCeil = Math.min(maxByte, cfg.maxBytes);

  const out: CorrelationCandidate[] = [];
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
          const cand = correlateLocusPacked(id, p, indices, byteIndex, bitStart, width, byteOrder, signed, ref, cfg);
          if (cand) out.push(cand);
        }
      }
    }
  }

  return { candidates: out, skipped };
}

/** Packed twin of {@link correlateLocus}: decodes the candidate series via byteAt. */
function correlateLocusPacked(
  id: number,
  p: PackedFrames,
  indices: number[],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  ref: ReadonlyArray<ReferenceSample>,
  cfg: SignalCorrelationConfig,
): CorrelationCandidate | null {
  const widthBytes = Math.ceil(width / 8);
  const candTUs: number[] = [];
  const candVal: number[] = [];
  for (const idx of indices) {
    const len = payloadLen(p, idx);
    if (byteIndex + widthBytes > len) continue;
    candTUs.push(p.tUs[idx]);
    candVal.push(decodeRawPacked(p, idx, len, bitStart, width, byteOrder, signed));
  }
  return finishCorrelation(id, candTUs, candVal, byteIndex, bitStart, width, byteOrder, signed, ref, cfg);
}

/**
 * Resample an already-decoded candidate (tUs, value) series onto the reference time
 * base, compute Spearman ρ, and build the candidate (or reject it). Shared by
 * {@link correlateLocus} (frame path) and {@link correlateLocusPacked} (packed
 * path) — only the decode upstream differs.
 */
function finishCorrelation(
  id: number,
  candTUs: number[],
  candVal: number[],
  byteIndex: number,
  bitStart: number,
  width: number,
  byteOrder: ByteOrder,
  signed: boolean,
  ref: ReadonlyArray<ReferenceSample>,
  cfg: SignalCorrelationConfig,
): CorrelationCandidate | null {
  if (candTUs.length < cfg.minPairs) return null;

  // Resample the candidate onto the reference time base via zero-order hold: for
  // each reference sample, take the candidate's most recent value at-or-before its
  // tUs. Reference samples before the candidate's first sample have no held value
  // and are dropped. candTUs is ascending, so we sweep both with one moving cursor.
  const xRef: number[] = []; // reference values that had a held candidate value
  const yCand: number[] = []; // the held candidate values (parallel to xRef)
  let cursor = 0; // index of the latest candidate sample at-or-before ref[k].tUs
  let have = false; // whether cursor points at a real held sample yet
  for (const s of ref) {
    while (cursor < candTUs.length && candTUs[cursor] <= s.tUs) {
      cursor++;
      have = true;
    }
    if (!have) continue; // no candidate value yet at-or-before this ref instant
    xRef.push(s.value);
    yCand.push(candVal[cursor - 1]); // cursor-1 = last sample at-or-before s.tUs
  }

  if (xRef.length < cfg.minPairs) return null;

  // Reject a near-constant candidate (its ranks all tie → ρ undefined / 0).
  const distinct = countDistinct(yCand);
  if (distinct < cfg.minDistinct) return null;

  const rho = spearman(xRef, yCand);
  if (!Number.isFinite(rho)) return null; // reference constant over the overlap, etc.
  const absRho = Math.abs(rho);
  if (absRho < cfg.minAbsRho) return null;

  return {
    key: `${id}:${bitStart}:${width}:${byteOrder}:${signed ? "s" : "u"}`,
    id,
    byteIndex,
    bitStart,
    width,
    byteOrder,
    signed,
    rho,
    absRho,
    pairs: xRef.length,
    distinct,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Decode (faithful copy of decode.ts conventions; see signal-discovery.ts)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Decode a raw integer from a payload at a global CAN bit index, applying the SAME
 * conventions as src/protocol/decode.ts (LSB-first little; Motorola "sawtooth"
 * big; two's-complement sign). Reimplemented here (not imported) because this file
 * is in the PURE shared package and may not depend on the cockpit's decode; the
 * bit walk is identical to signal-discovery.ts's decodeRaw. Values fit safely in a
 * JS number for the swept widths (≤16, well under 53 bits).
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
    for (let i = 0; i < width; i++) {
      if (getBit(data, bitStart + i)) raw += 2 ** i;
    }
  } else {
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
 * Spearman rank correlation (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Spearman's rank correlation coefficient ρ between two equal-length series.
 * Computed as Pearson on the AVERAGE-rank transforms of each series (the standard
 * tie-corrected Spearman). Returns NaN when either series is constant (no rank
 * variance → ρ undefined) so the caller can reject it.
 */
function spearman(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  const n = x.length;
  if (n < 2) return NaN;
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  return pearson(rx, ry);
}

/**
 * Average (fractional) ranks of `xs`: ties share the mean of the ranks they would
 * occupy (e.g. two values tied for ranks 3,4 both get 3.5). 1-based ranks; the
 * constant offset cancels in Pearson, so the base doesn't matter — readability does.
 */
function averageRanks(xs: ReadonlyArray<number>): number[] {
  const n = xs.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    // Extend over a run of equal values.
    while (j + 1 < n && xs[idx[j + 1]] === xs[idx[i]]) j++;
    // Ranks i..j (1-based: i+1 .. j+1) share their average.
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Pearson correlation between two equal-length series. Returns NaN when either has
 * zero variance (a constant series, e.g. all-tied ranks). One pass over the data.
 */
function pearson(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (denom === 0) return NaN; // a constant series → correlation undefined.
  return sxy / denom;
}

/** Count distinct values in a list (small lists; a Set is plenty). */
function countDistinct(xs: ReadonlyArray<number>): number {
  return new Set(xs).size;
}
