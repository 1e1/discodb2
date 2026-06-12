// discodb2 — the EQUIVALENCE / RETURN scorer (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/markhunt-spec.md §7.1. This is the one genuinely-new
// scorer the Markhunt ("free-run / highlighter") feature needs, and it is also
// useful to the scripted Logbook (a `recover`-vs-`baseline` return check), so it
// lives here in the shared analysis package, not in markhunt-only code.
//
// THE QUESTION it answers: two windows X and Y are asserted to hold the SAME
// value (the operator's "the 4th marker should read like the 1st" — a gear
// engaged then put back, lights on then off, a return to idle). Which decoded
// field actually behaves that way? A field is interesting only if it both
//   (a) RETURNED — its robust level at Y ≈ its level at X (small delta), AND
//   (b) MOVED in between — it left that level somewhere between X and Y.
// A byte that never moved is "equal at X and Y" only trivially and must score ≈0;
// a byte that moved but did NOT come back is not an equivalence either.
//
//     returnScore = movement × closeness
//       closeness = 1 − normalized |median_X − median_Y|     (returned?)
//       movement  = normalized max departure from the common level, between X..Y
//
// Both factors are normalized by the field's value RANGE over X ∪ Y ∪ between, so
// the score is scale-free (the physical units of the raw field are unknown) and
// lands in [0,1]. Like `compareStates`, each endpoint window must be a STABLE
// LEVEL (low within-window spread) — an asserted "same value" only makes sense
// between two steady states; a counter/chatter byte is rejected before ranking.
//
// Pure & framework-free (like tagger.ts / trend-scorer.ts / protocol.ts): no
// Svelte/Vite/DOM deps, no I/O, no globals; deterministic. Runs in the cockpit, a
// Web Worker, or a plain Node test runner. Mutates nothing; allocates fresh output.

import type { ByteOrder } from "../protocol.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw classic-CAN frame stamped with its capture time (microseconds). Same
 * shape the other scorers consume; re-declared so this module stands alone.
 */
export interface TimedFrame {
  id: number;
  data: number[];
  /** Capture timestamp, microseconds. */
  tUs: number;
}

/** Field width in bits. Classic CAN fields worth comparing are 8- or 16-bit. */
export type FieldWidth = 8 | 16;

/** A scored "returned to the same value" field. `score` is the returnScore [0,1]. */
export interface EquivalenceCandidate {
  id: number;
  /** Byte index of the field's first (lowest) byte within the payload. */
  byteIndex: number;
  width: FieldWidth;
  /** Byte order used to decode a 16-bit field; "big" for 8-bit. */
  byteOrder: ByteOrder;
  signed: boolean;
  /** returnScore = movement × closeness, higher = better; set-relative. */
  score: number;
  /** Robust central value (median) in window X / window Y, raw decoded units. */
  medianX: number;
  medianY: number;
  /** Normalized |median_X − median_Y| in [0,1] (small ⇒ it returned). */
  levelDelta: number;
  /** Normalized peak departure from the common level, between X..Y, [0,1]. */
  movement: number;
  /** Human-readable one-liner for the UI / logs. */
  rationale: string;
}

/** Outcome of a `scoreEquivalence` run: the ranked shortlist + per-window counts. */
export interface EquivalenceResult {
  /** Candidates that returned AND moved, ranked by returnScore desc. */
  candidates: EquivalenceCandidate[];
  /** Frames supplied for window X / window Y / the between span. */
  framesX: number;
  framesY: number;
  framesBetween: number;
}

/** Tunable knobs; all have defaults below. */
export interface EquivalenceScorerConfig {
  /** Min decoded samples a field needs in EACH endpoint window before scoring. */
  minSamples: number;
  /**
   * Max within-window spread (robust: IQR / |median|) for an endpoint to count as
   * a STABLE level — same gate `compareStates` uses. A field that isn't steady at
   * X and Y can't meaningfully be asserted "the same value" there.
   */
  maxStateSpread: number;
  /** Min returnScore to keep a candidate (below this it didn't clearly return-and-move). */
  minReturnScore: number;
}

export const EQUIVALENCE_SCORER_DEFAULTS: EquivalenceScorerConfig = {
  minSamples: 8,
  maxStateSpread: 0.5,
  // A field that left and came back cleanly clears this comfortably; a constant
  // byte (movement≈0) or one that drifted away and stayed (closeness low) won't.
  minReturnScore: 0.15,
};

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Rank fields that hold the SAME value at X and Y but moved in between.
 *
 * @param framesX   raw frames captured in window X (order irrelevant).
 * @param framesY   raw frames captured in window Y.
 * @param framesBetween raw frames in the span strictly between X and Y (the
 *                  "journey"); empty ⇒ nothing can have moved-and-returned, so no
 *                  candidate clears the movement factor.
 * @param excluded  tagger exclusions, keyed `"id:byteIndex"` (decimal); any field
 *                  overlapping an excluded byte is skipped.
 * @param config    optional overrides.
 *
 * Pure: mutates none of its inputs; returns fresh output.
 */
export function scoreEquivalence(
  framesX: ReadonlyArray<TimedFrame>,
  framesY: ReadonlyArray<TimedFrame>,
  framesBetween: ReadonlyArray<TimedFrame>,
  excluded: ReadonlySet<string> = new Set<string>(),
  config: Partial<EquivalenceScorerConfig> = {},
): EquivalenceResult {
  const cfg: EquivalenceScorerConfig = { ...EQUIVALENCE_SCORER_DEFAULTS, ...config };

  const byX = groupById(framesX);
  const byY = groupById(framesY);
  const byBetween = groupById(framesBetween);

  const candidates: EquivalenceCandidate[] = [];

  for (const [id, framesIdX] of byX) {
    const framesIdY = byY.get(id);
    if (framesIdY === undefined) continue; // id absent from one endpoint → can't compare.
    const framesIdBetween = byBetween.get(id) ?? [];

    forEachField(id, framesIdX, excluded, (field) => {
      const x = decodeValues(framesIdX, field);
      const y = decodeValues(framesIdY, field);
      if (x.length < cfg.minSamples || y.length < cfg.minSamples) return;

      const mx = median(x);
      const my = median(y);
      // Both endpoints must be a stable level (else "same value" is meaningless).
      if (relativeSpread(x, mx) > cfg.maxStateSpread) return;
      if (relativeSpread(y, my) > cfg.maxStateSpread) return;

      const between = decodeValues(framesIdBetween, field);

      // Scale-free normalization by the field's full range over X ∪ Y ∪ between.
      const all = x.concat(y, between);
      const range = Math.max(rangeOf(all), 1);

      const levelDelta = Math.min(1, Math.abs(mx - my) / range);
      const closeness = 1 - levelDelta;

      // Movement = the peak departure from the common level somewhere between the
      // two endpoints. No between-samples ⇒ 0 (can't show it went anywhere).
      const common = (mx + my) / 2;
      let departure = 0;
      for (const v of between) departure = Math.max(departure, Math.abs(v - common));
      const movement = Math.min(1, departure / range);

      const score = movement * closeness;
      if (score < cfg.minReturnScore) return;

      candidates.push({
        ...field,
        score,
        medianX: mx,
        medianY: my,
        levelDelta,
        movement,
        rationale:
          `id 0x${id.toString(16).toUpperCase()} ${describeField(field)} ` +
          `returns to ${mx} (Y=${my}, Δ=${(mx - my).toFixed(1)}) after moving ` +
          `${(movement * 100).toFixed(0)}% of range between → returnScore ${score.toFixed(2)}`,
      });
    });
  }

  sortByScore(candidates);
  return {
    candidates,
    framesX: framesX.length,
    framesY: framesY.length,
    framesBetween: framesBetween.length,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Candidate-field enumeration & decoding (standalone — mirrors trend-scorer's
 * §3.5 decode so this module needs no shared private helpers)
 * ──────────────────────────────────────────────────────────────────────── */

interface Field {
  id: number;
  byteIndex: number;
  width: FieldWidth;
  byteOrder: ByteOrder;
  signed: boolean;
}

/**
 * Enumerate every candidate field for one id and invoke `visit` on each that does
 * NOT overlap an excluded byte. 8-bit fields are emitted once (no endianness);
 * 16-bit as BE and LE (unsigned). Signedness is not swept here — an equivalence
 * is a level-return test, and the signed vs unsigned decode only differs across
 * the 0x8000 wrap, which a steady level rarely straddles.
 */
function forEachField(
  id: number,
  idFrames: ReadonlyArray<TimedFrame>,
  excluded: ReadonlySet<string>,
  visit: (field: Field) => void,
): void {
  const width = idFrames.reduce((m, f) => Math.max(m, f.data.length), 0);
  for (let off = 0; off < width; off++) {
    if (!excluded.has(`${id}:${off}`)) {
      visit({ id, byteIndex: off, width: 8, byteOrder: "big", signed: false });
    }
    if (off + 1 < width && !excluded.has(`${id}:${off}`) && !excluded.has(`${id}:${off + 1}`)) {
      visit({ id, byteIndex: off, width: 16, byteOrder: "big", signed: false });
      visit({ id, byteIndex: off, width: 16, byteOrder: "little", signed: false });
    }
  }
}

/** Decode `field` from every frame long enough to contain it. */
function decodeValues(idFrames: ReadonlyArray<TimedFrame>, field: Field): number[] {
  const out: number[] = [];
  for (const f of idFrames) {
    const v = decodeField(f.data, field);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Decode one field from a payload, or null if too short (mirrors trend-scorer). */
function decodeField(data: number[], field: Field): number | null {
  const i = field.byteIndex;
  if (field.width === 8) {
    if (i >= data.length) return null;
    return data[i] & 0xff;
  }
  if (i + 1 >= data.length) return null;
  const hi = data[i] & 0xff;
  const lo = data[i + 1] & 0xff;
  const raw = field.byteOrder === "big" ? (hi << 8) | lo : (lo << 8) | hi;
  if (field.signed && raw >= 0x8000) return raw - 0x10000;
  return raw;
}

/** A compact field descriptor for rationale strings. */
function describeField(field: Field): string {
  if (field.width === 8) return `byte${field.byteIndex} u8`;
  const order = field.byteOrder === "big" ? "BE" : "LE";
  return `byte${field.byteIndex}..${field.byteIndex + 1} u16 ${order}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Robust summaries + grouping (standalone)
 * ──────────────────────────────────────────────────────────────────────── */

function median(xs: ReadonlyArray<number>): number {
  const n = xs.length;
  if (n === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rangeOf(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  let lo = xs[0];
  let hi = xs[0];
  for (const v of xs) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/** Interquartile range (Q3 − Q1), raw units. Empty/singleton → 0. */
function absoluteIqr(xs: ReadonlyArray<number>): number {
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

/** Within-window spread: IQR relative to |median|, or absolute when level ≈ 0. */
function relativeSpread(xs: ReadonlyArray<number>, med: number): number {
  const iqr = absoluteIqr(xs);
  const denom = Math.abs(med);
  return denom >= 1 ? iqr / denom : iqr;
}

/** Group frames by id (defensive byte copy, clamped 0..255). */
function groupById(frames: ReadonlyArray<TimedFrame>): Map<number, TimedFrame[]> {
  const byId = new Map<number, TimedFrame[]>();
  for (const f of frames) {
    let g = byId.get(f.id);
    if (g === undefined) {
      g = [];
      byId.set(f.id, g);
    }
    g.push({ id: f.id, tUs: f.tUs, data: f.data.map((b) => b & 0xff) });
  }
  return byId;
}

/** Sort best-first, breaking ties deterministically by field identity. */
function sortByScore(candidates: EquivalenceCandidate[]): void {
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.id - b.id ||
      a.byteIndex - b.byteIndex ||
      a.width - b.width ||
      (a.byteOrder === b.byteOrder ? 0 : a.byteOrder === "big" ? -1 : 1),
  );
}
