// discodb2 — Brick 2: the TREND SCORER (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Modes → Trend / 2-point" and "Scoring →
// Trend scorer". Like the event scorer this stands on Brick 0 (the tagger): it
// is handed the tagger's set of excluded byte slots and never decodes a field
// that overlaps one, so free-running counters and checksums can't surface as
// fake candidates. (A wrapping counter that the tagger somehow missed still
// self-rejects here — see below.)
//
// Pure & framework-free (like tagger.ts / event-scorer.ts / protocol.ts): no
// Svelte/Vite/DOM-only deps; runs in the cockpit, a Web Worker, or a plain Node
// test runner. Mutates nothing, allocates fresh output.
//
// What it finds:
//   A DECODED VALUE — a field laid out as (id × byte offset × width {8,16} ×
//   endianness {BE,LE} × signed?) — that rises or falls monotonically over a
//   marked window (RPM ramp, speed, coolant warming up). Two entry points:
//
//   • scoreTrend(...)   — a continuous ramp inside one [startTUs, endTUs]
//     window with a known `direction`. We measure how monotone the field is vs
//     time with **Spearman ρ** (rank correlation — invariant to the unknown
//     physical scale/offset, robust to a sloshing magnitude) and confirm the
//     *direction* with the sign of a **Theil–Sen slope** (the median of all
//     pairwise slopes — a 50%-breakdown estimator, so fuel slosh / transient
//     spikes can't flip it the way a least-squares fit would). Keep a field iff
//     |ρ| ≥ trendMinSpearman AND sign(slope) matches `direction`.
//
//   • compareStates(...) — the 2-point sub-case (tank FULL vs LOW, anything you
//     can't ramp): capture two steady states, take a robust central value
//     (median) of each field in each, reject fields that aren't a stable LEVEL
//     within a state (high intra-state spread → it's noise/a counter, not a
//     gauge), and rank by the normalized magnitude of the between-state change.
//
// Why a wrapping counter self-rejects (docs/WIZARD.md): over a window with many
// wraps a mod-2^k counter is a sawtooth; its rank-vs-time correlation averages
// to ≈ 0 (each ramp segment is positively correlated, each wrap is a giant
// negative jump), so |ρ| stays well below threshold. The tagger removes it
// up front anyway; this is the second line of defence. A counter with NO wrap
// in the window is just a clean ramp and is indistinguishable from signal by
// shape alone — that is exactly why the tagger (Brick 0) runs first.

import { WIZARD_DEFAULTS } from "../wizard-config.ts";
import type { ByteOrder } from "../protocol.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw classic-CAN frame stamped with its capture time (microseconds). The
 * same shape the event scorer consumes (`id`/`data` like the tagger's
 * `RawFrame`, plus `tUs`); re-declared here so this module stands alone.
 * `data` is 0..8 bytes; each entry is a byte 0..255.
 */
export interface TimedFrame {
  id: number;
  data: number[];
  /** Capture timestamp, microseconds (same clock as `TrendWindow`). */
  tUs: number;
}

/** Field width in bits. Classic CAN signals worth ramping are 8- or 16-bit. */
export type FieldWidth = 8 | 16;

/**
 * The window of a continuous trend run: an interval on the µs clock plus the
 * direction the operator drove the quantity. `'up'` = the value should RISE
 * across the window (RPM ramp), `'down'` = FALL (engine braking, draining).
 */
export interface TrendWindow {
  /** Window start, microseconds (inclusive). */
  startTUs: number;
  /** Window end, microseconds (inclusive). */
  endTUs: number;
  /** The direction the physical quantity was driven. */
  direction: "up" | "down";
}

/**
 * A scored candidate field. Common to both entry points: which field it is
 * (id × byteIndex × width × byteOrder × signed) and a `score` in [0,1] where
 * higher = stronger. The mode-specific evidence differs:
 *   • scoreTrend   → `slopeSign` (the Theil–Sen sign that matched the window's
 *     direction) and `spearman` (the signed ρ; `score` is |ρ|).
 *   • compareStates→ `delta` (signed median_A − median_B in raw units) plus the
 *     two medians; `score` is the spread-normalized |delta|.
 * Fields absent for a mode are simply omitted.
 */
export interface RankedCandidate {
  id: number;
  /** Byte index of the field's FIRST (lowest) byte within the payload. */
  byteIndex: number;
  /** Field width in bits (8 or 16). */
  width: FieldWidth;
  /** Byte order used to decode a 16-bit field ("big"/"little"); "big" for 8-bit. */
  byteOrder: ByteOrder;
  /** Whether the field was decoded as a signed two's-complement integer. */
  signed: boolean;
  /** Strength in [0,1]: |Spearman ρ| (trend) or normalized |Δ| (2-point). */
  score: number;
  /** scoreTrend only: sign of the Theil–Sen slope (+1 rising, −1 falling). */
  slopeSign?: 1 | -1;
  /** scoreTrend only: the signed Spearman ρ over the window, −1..1. */
  spearman?: number;
  /** compareStates only: signed median_A − median_B, raw decoded units. */
  delta?: number;
  /** compareStates only: the robust central value in state A (raw units). */
  medianA?: number;
  /** compareStates only: the robust central value in state B (raw units). */
  medianB?: number;
  /** Human-readable one-liner for the UI / logs. */
  rationale: string;
}

/** Outcome of a `scoreTrend` run: the ranked shortlist + how much data backed it. */
export interface TrendScoreResult {
  /** Candidates with |ρ| ≥ trendMinSpearman and matching slope sign, score desc. */
  candidates: RankedCandidate[];
  /** Distinct ids seen with at least one frame inside the window. */
  idsInWindow: number;
  /** Total frames that fell inside [startTUs, endTUs]. */
  framesInWindow: number;
}

/** Outcome of a `compareStates` run: the ranked shortlist + per-state frame counts. */
export interface CompareStatesResult {
  /** Candidates that are a stable level in BOTH states, ranked by |Δ| desc. */
  candidates: RankedCandidate[];
  /** Frames supplied for state A. */
  framesA: number;
  /** Frames supplied for state B. */
  framesB: number;
}

/**
 * Tunable knobs. `trendMinSpearman` is the cross-Wizard one (from WizardConfig);
 * the rest are trend-scorer-local. All defaults below; everything overridable.
 */
export interface TrendScorerConfig {
  /**
   * Min |Spearman ρ| for a trend candidate to be kept, 0..1. From
   * WizardConfig.trendMinSpearman. Also the gate `compareStates` reuses as a
   * floor on normalized |Δ| (a between-state change smaller than the within-
   * state noise is not a level shift).
   */
  trendMinSpearman: number;
  /**
   * Also try decoding 16-bit fields as SIGNED two's-complement (in addition to
   * unsigned). Off by default: most gauges are unsigned, and signed widens the
   * candidate set. A signed decode only changes the value-vs-time SHAPE near the
   * 0x8000 wrap, so it rarely matters for a clean ramp — but it can rescue a
   * field that straddles that boundary.
   */
  trySigned: boolean;
  /**
   * Min decoded samples a field needs inside a window/state before it is scored.
   * Below this there isn't enough evidence for a stable ρ or a trustworthy
   * median; the field is skipped (not scored 0).
   */
  minSamples: number;
  /**
   * Cap on the number of pairwise slopes Theil–Sen averages. The full estimator
   * is O(n²); past this many samples we subsample a deterministic stride of
   * pairs (still O(n²) candidate pairs walked but bounded work) to stay fast on
   * a long window without changing the median materially.
   */
  maxSlopePairs: number;
  /**
   * 2-point only: max within-state spread (robust: IQR / |median|, or absolute
   * IQR when the median ≈ 0) for a field to count as a stable LEVEL. A counter
   * or chatter byte ramps/jitters across its whole range within ONE state, so
   * its spread is huge and it is rejected before it can be ranked.
   */
  maxStateSpread: number;
}

export const TREND_SCORER_DEFAULTS: TrendScorerConfig = {
  trendMinSpearman: WIZARD_DEFAULTS.trendMinSpearman, // 0.6
  trySigned: false,
  // 8 samples ≈ a handful of frames of a 100 ms id over a ~1 s ramp; below this
  // a Spearman ρ is too easy to hit by chance and a median is shaky.
  minSamples: 8,
  // 20000 pairs ≈ 200 samples taken exhaustively; beyond that the subsample
  // stride kicks in. Comfortably fast in a Worker, ample for a stable median.
  maxSlopePairs: 20000,
  // 0.5: a stable gauge level varies by well under half its own magnitude
  // within a captured state; a counter's IQR is ~half its full range, far above.
  maxStateSpread: 0.5,
};

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API — continuous trend
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Score every candidate field for a monotone rise/fall across `window`, and
 * return the ranked shortlist.
 *
 * For each id, for every byte offset that can host an 8- or 16-bit field, for
 * each endianness (and signedness when enabled), we build the decoded
 * value-vs-time series from the frames inside the window, then:
 *   score = |Spearman ρ(value, time)|   if sign(Theil–Sen slope) === direction
 *         = 0                            otherwise (wrong way → not this field).
 * A field is kept iff |ρ| ≥ trendMinSpearman; results are sorted by score desc.
 *
 * @param frames   raw timed frames in arrival order (any ids interleaved).
 * @param window   the trend interval + driven direction.
 * @param excluded the tagger's excluded slots, keyed `"id:byteIndex"` (decimal);
 *                 ANY field overlapping an excluded byte is skipped entirely.
 * @param config   optional overrides (see TrendScorerConfig).
 *
 * Pure: mutates none of its inputs; returns fresh output.
 */
export function scoreTrend(
  frames: ReadonlyArray<TimedFrame>,
  window: TrendWindow,
  excluded: ReadonlySet<string> = new Set<string>(),
  config: Partial<TrendScorerConfig> = {},
): TrendScoreResult {
  const cfg: TrendScorerConfig = { ...TREND_SCORER_DEFAULTS, ...config };
  const wantSign: 1 | -1 = window.direction === "up" ? 1 : -1;

  // Keep only in-window frames, grouped by id and time-sorted (so the decoded
  // series is naturally time-ordered for Spearman/Theil–Sen).
  const byId = groupInWindow(frames, window.startTUs, window.endTUs);

  let framesInWindow = 0;
  for (const g of byId.values()) framesInWindow += g.length;

  const candidates: RankedCandidate[] = [];

  for (const [id, idFrames] of byId) {
    forEachField(id, idFrames, cfg, excluded, (field) => {
      const series = decodeSeries(idFrames, field);
      if (series.values.length < cfg.minSamples) return;

      const rho = spearman(series.values, series.times);
      const slope = theilSen(series.values, series.times, cfg.maxSlopePairs);
      const slopeSign: 1 | -1 = slope >= 0 ? 1 : -1;

      // Direction gate: a field trending the WRONG way is not this signal.
      // (slope exactly 0 ⇒ flat ⇒ not a trend; treated as +1 above but |ρ|≈0
      // keeps it below threshold anyway.)
      const score = slopeSign === wantSign ? Math.abs(rho) : 0;
      if (score < cfg.trendMinSpearman) return;

      candidates.push({
        ...field,
        score,
        slopeSign,
        spearman: rho,
        rationale:
          `id 0x${id.toString(16).toUpperCase()} ${describeField(field)} ` +
          `trends ${window.direction} (ρ=${rho.toFixed(2)}, ` +
          `Theil–Sen ${slope >= 0 ? "+" : "−"} over ${series.values.length} samples)`,
      });
    });
  }

  sortByScore(candidates);
  return { candidates, idsInWindow: byId.size, framesInWindow };
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API — 2-point (state comparison)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Compare two captured steady states (e.g. tank FULL vs LOW) and rank the
 * fields that shifted the most, for signals you can't ramp continuously.
 *
 * For each candidate field we take a robust central value (median) in each
 * state and the within-state spread. A field is a candidate only if it is a
 * STABLE LEVEL in BOTH states (spread ≤ maxStateSpread — this rejects counters
 * and chatter, which sweep their whole range within a single state). Survivors
 * are ranked by the magnitude of the change normalized by the within-state
 * noise (so a 2-unit shift on a rock-steady byte beats a 2-unit shift on a
 * jittery one); the signed raw `delta = median_A − median_B` is reported.
 *
 * @param framesA  raw frames captured in state A (order irrelevant).
 * @param framesB  raw frames captured in state B.
 * @param excluded tagger exclusions, keyed `"id:byteIndex"`; overlapping fields skipped.
 * @param config   optional overrides (see TrendScorerConfig).
 *
 * Pure: mutates none of its inputs; returns fresh output.
 */
export function compareStates(
  framesA: ReadonlyArray<TimedFrame>,
  framesB: ReadonlyArray<TimedFrame>,
  excluded: ReadonlySet<string> = new Set<string>(),
  config: Partial<TrendScorerConfig> = {},
): CompareStatesResult {
  const cfg: TrendScorerConfig = { ...TREND_SCORER_DEFAULTS, ...config };

  const byIdA = groupById(framesA);
  const byIdB = groupById(framesB);

  const candidates: RankedCandidate[] = [];

  for (const [id, framesIdA] of byIdA) {
    const framesIdB = byIdB.get(id);
    if (framesIdB === undefined) continue; // id absent from one state → can't compare.

    forEachField(id, framesIdA, cfg, excluded, (field) => {
      const a = decodeSeries(framesIdA, field).values;
      const b = decodeSeries(framesIdB, field).values;
      if (a.length < cfg.minSamples || b.length < cfg.minSamples) return;

      const ma = median(a);
      const mb = median(b);
      const spreadA = relativeSpread(a, ma);
      const spreadB = relativeSpread(b, mb);

      // Must be a stable level in BOTH states, else it isn't a gauge reading.
      if (spreadA > cfg.maxStateSpread || spreadB > cfg.maxStateSpread) return;

      const delta = ma - mb;
      // Normalize the change by the within-state noise floor (in raw units) so
      // a clean shift outranks an equal shift buried in jitter. The +1 floor
      // keeps a rock-steady field (≈0 noise) from dividing by ~0.
      const noise = Math.max(absoluteIqr(a, ma), absoluteIqr(b, mb), 1);
      const score = Math.abs(delta) / noise;
      if (score < cfg.trendMinSpearman) return; // change is within the noise.

      candidates.push({
        ...field,
        score,
        delta,
        medianA: ma,
        medianB: mb,
        rationale:
          `id 0x${id.toString(16).toUpperCase()} ${describeField(field)} ` +
          `differs A↔B: ${ma} vs ${mb} (Δ=${delta >= 0 ? "+" : ""}${delta}, ` +
          `${score.toFixed(1)}× within-state noise)`,
      });
    });
  }

  sortByScore(candidates);
  return { candidates, framesA: framesA.length, framesB: framesB.length };
}

/* ────────────────────────────────────────────────────────────────────────
 * Candidate-field enumeration & decoding
 * ──────────────────────────────────────────────────────────────────────── */

/** The identity of one candidate field (everything but its score/evidence). */
interface Field {
  id: number;
  byteIndex: number;
  width: FieldWidth;
  byteOrder: ByteOrder;
  signed: boolean;
}

/**
 * Enumerate every candidate field for one id and invoke `visit` on each that
 * does NOT overlap an excluded byte. We sweep offsets across the id's max
 * payload width and cross with width {8,16} × endianness {big,little} (and
 * signed when enabled). An 8-bit field has no real endianness, so it is emitted
 * once as `byteOrder: "big"`, `signed: false` — never duplicated as LE/signed.
 */
function forEachField(
  id: number,
  idFrames: ReadonlyArray<TimedFrame>,
  cfg: TrendScorerConfig,
  excluded: ReadonlySet<string>,
  visit: (field: Field) => void,
): void {
  const width = idFrames.reduce((m, f) => Math.max(m, f.data.length), 0);

  for (let off = 0; off < width; off++) {
    // 8-bit field at `off` (one byte; endianness/sign are meaningless).
    if (!excluded.has(`${id}:${off}`)) {
      visit({ id, byteIndex: off, width: 8, byteOrder: "big", signed: false });
    }

    // 16-bit field spans `off` and `off+1`; needs both, and NEITHER excluded.
    if (off + 1 < width && !excluded.has(`${id}:${off}`) && !excluded.has(`${id}:${off + 1}`)) {
      visit({ id, byteIndex: off, width: 16, byteOrder: "big", signed: false });
      visit({ id, byteIndex: off, width: 16, byteOrder: "little", signed: false });
      if (cfg.trySigned) {
        visit({ id, byteIndex: off, width: 16, byteOrder: "big", signed: true });
        visit({ id, byteIndex: off, width: 16, byteOrder: "little", signed: true });
      }
    }
  }
}

interface Series {
  values: number[];
  times: number[];
}

/**
 * Decode `field` from every frame long enough to contain it, returning parallel
 * value/time arrays. Frames too short for the field are skipped (a missing byte
 * is not a zero sample). The byte/endianness decode mirrors protocol.ts §3.5:
 *   • 8-bit  → the raw byte.
 *   • 16-bit BE → (b[off] << 8) | b[off+1];  LE → b[off] | (b[off+1] << 8).
 *   • signed 16-bit → reinterpret the 0..65535 value as two's-complement.
 */
function decodeSeries(idFrames: ReadonlyArray<TimedFrame>, field: Field): Series {
  const values: number[] = [];
  const times: number[] = [];
  for (const f of idFrames) {
    const v = decodeField(f.data, field);
    if (v === null) continue;
    values.push(v);
    times.push(f.tUs);
  }
  return { values, times };
}

/** Decode one field from a payload, or null if the payload is too short. */
function decodeField(data: number[], field: Field): number | null {
  const i = field.byteIndex;
  if (field.width === 8) {
    if (i >= data.length) return null;
    return data[i] & 0xff;
  }
  // 16-bit: needs two bytes.
  if (i + 1 >= data.length) return null;
  const hi = data[i] & 0xff;
  const lo = data[i + 1] & 0xff;
  const raw = field.byteOrder === "big" ? (hi << 8) | lo : (lo << 8) | hi;
  // For BE the "high" byte is data[i]; for LE it is data[i+1]. The ternary
  // above already orders them, so `raw` is the unsigned 16-bit value either way.
  if (field.signed && raw >= 0x8000) return raw - 0x10000;
  return raw;
}

/** A compact field descriptor for rationale strings. */
function describeField(field: Field): string {
  if (field.width === 8) return `byte${field.byteIndex} u8`;
  const sign = field.signed ? "s" : "u";
  const order = field.byteOrder === "big" ? "BE" : "LE";
  return `byte${field.byteIndex}..${field.byteIndex + 1} ${sign}16 ${order}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Statistics: Spearman ρ and Theil–Sen slope
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Spearman rank correlation between `values` and `times`. We rank each series
 * (average ranks for ties) and take the Pearson correlation of the ranks —
 * which equals Spearman ρ and handles ties correctly (the simple 1−6Σd²/…
 * shortcut does not). Returns 0 when either ranked series has zero variance
 * (a constant field can't trend), so a flat byte scores 0, not NaN.
 *
 * ρ is invariant to any monotone rescaling of the value axis — exactly right
 * when the physical scale/offset of the raw field is unknown, and what makes a
 * noisy-but-monotone ramp score near 1 while a sawtooth counter averages to ≈0.
 */
function spearman(values: number[], times: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const rv = ranks(values);
  const rt = ranks(times);
  return pearson(rv, rt);
}

/** Pearson correlation of two equal-length arrays; 0 if either has no variance. */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
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
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Fractional ranks of `xs` (1..n), assigning the AVERAGE rank to tied values
 * (standard Spearman tie handling). O(n log n). The absolute rank base is
 * irrelevant to a correlation, but averaging ties keeps a partly-quantized
 * series (e.g. an 8-bit gauge with repeats) from biasing ρ.
 */
function ranks(xs: number[]): number[] {
  const n = xs.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && xs[order[j]] === xs[order[i]]) j++;
    // ranks i..j-1 (0-based) tie; average rank = mean of (i+1 .. j) one-based.
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) r[order[k]] = avg;
    i = j;
  }
  return r;
}

/**
 * Theil–Sen slope of `values` against `times`: the MEDIAN of the pairwise
 * slopes (vⱼ−vᵢ)/(tⱼ−tᵢ) over i<j. A 50%-breakdown estimator, so up to nearly
 * half the points can be transient spikes (fuel slosh, a momentary over-rev)
 * without flipping the sign — unlike a least-squares fit, which one big spike
 * can drag the wrong way. We only need its SIGN here (to confirm direction).
 *
 * Cost control: the full set is C(n,2) pairs. When that exceeds `maxPairs` we
 * walk a deterministic stride of i-values (and all j>i) so the work is bounded
 * while the sampled pairs still span the whole window — the median of a large
 * representative subsample matches the full median's sign in practice. Pairs
 * with equal timestamps are skipped (no slope defined).
 */
function theilSen(values: number[], times: number[], maxPairs: number): number {
  const n = values.length;
  if (n < 2) return 0;

  const slopes: number[] = [];
  const totalPairs = (n * (n - 1)) / 2;
  // Stride over i so the number of (i, *) blocks we walk keeps pairs ≲ maxPairs.
  const stride = totalPairs > maxPairs ? Math.ceil(totalPairs / maxPairs) : 1;

  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j++) {
      const dt = times[j] - times[i];
      if (dt === 0) continue; // same instant → undefined slope, skip.
      slopes.push((values[j] - values[i]) / dt);
    }
  }
  if (slopes.length === 0) return 0;
  return median(slopes);
}

/* ────────────────────────────────────────────────────────────────────────
 * Robust summaries (median, spread)
 * ──────────────────────────────────────────────────────────────────────── */

/** Median of `xs` (does not mutate the caller's array). Empty → 0. */
function median(xs: ReadonlyArray<number>): number {
  const n = xs.length;
  if (n === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Interquartile range of `xs` (Q3 − Q1) in raw units. Empty/singleton → 0. */
function absoluteIqr(xs: ReadonlyArray<number>, _median: number): number {
  const n = xs.length;
  if (n < 2) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = p * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

/**
 * Within-state spread used to decide "stable level vs not": IQR relative to the
 * magnitude of the level (|median|), or the absolute IQR when the level sits
 * near 0 (so a near-zero steady field isn't judged unstable by a divide-by-~0).
 * Robust by construction — IQR ignores the outer 50% of any spikes.
 */
function relativeSpread(xs: ReadonlyArray<number>, med: number): number {
  const iqr = absoluteIqr(xs, med);
  const denom = Math.abs(med);
  return denom >= 1 ? iqr / denom : iqr;
}

/* ────────────────────────────────────────────────────────────────────────
 * Grouping helpers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Group frames by id, keeping ONLY those inside [startUs, endUs] (inclusive),
 * each group time-sorted ascending. Defensive byte copy (clamped to 0..255) so
 * decoders can index freely without touching the caller's arrays.
 */
function groupInWindow(
  frames: ReadonlyArray<TimedFrame>,
  startUs: number,
  endUs: number,
): Map<number, TimedFrame[]> {
  const byId = new Map<number, TimedFrame[]>();
  for (const f of frames) {
    if (f.tUs < startUs || f.tUs > endUs) continue;
    push(byId, f);
  }
  for (const g of byId.values()) g.sort((a, b) => a.tUs - b.tUs);
  return byId;
}

/** Group frames by id (no time filter), each group time-sorted ascending. */
function groupById(frames: ReadonlyArray<TimedFrame>): Map<number, TimedFrame[]> {
  const byId = new Map<number, TimedFrame[]>();
  for (const f of frames) push(byId, f);
  for (const g of byId.values()) g.sort((a, b) => a.tUs - b.tUs);
  return byId;
}

/** Append a defensively-copied frame to its id's group. */
function push(byId: Map<number, TimedFrame[]>, f: TimedFrame): void {
  let g = byId.get(f.id);
  if (g === undefined) {
    g = [];
    byId.set(f.id, g);
  }
  g.push({ id: f.id, tUs: f.tUs, data: f.data.map((b) => b & 0xff) });
}

/**
 * Sort candidates best-first, breaking ties deterministically by field identity
 * (id, then offset, then narrower width, then BE before LE, then unsigned first)
 * so the same input always yields the same order.
 */
function sortByScore(candidates: RankedCandidate[]): void {
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.id - b.id ||
      a.byteIndex - b.byteIndex ||
      a.width - b.width ||
      (a.byteOrder === b.byteOrder ? 0 : a.byteOrder === "big" ? -1 : 1) ||
      Number(a.signed) - Number(b.signed),
  );
}
