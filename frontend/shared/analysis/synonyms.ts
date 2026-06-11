// discodb2 — LOGBOOK: cross-session SYNONYM matching (frontend/shared/analysis).
//
// SOURCE OF TRUTH: the Logbook design — when a run surfaces a candidate, compare
// it to the KNOWN signals (the project's findings, accumulating across sessions)
// to surface SYNONYMS: the same physical quantity rediffused on another frame, or
// a redundant broadcast. This is the "se souvenir des sessions précédentes" idea —
// behavioral, not positional: two fields are synonyms when their VALUE SERIES move
// together over the capture.
//
// Pure pairwise correlation: extract each field's value series (a BIT → 0/1, a
// BYTE → its value) over the frames, resample both onto a common time grid
// (last-value-hold) over their overlap, and take Pearson r. |r| above a threshold
// ⇒ a synonym, ranked by |r|. (A heavier ranked sweep over all bytes is what
// signal-correlation.ts does; here we score a SPECIFIC known set, so a focused
// pairwise correlation is simpler and self-contained.)
//
// Positional/DBC matching ("looks like vw_golf_mk4 'Licht_Anf'") is a separate
// cockpit-side lookup (compare the candidate's id+bit against a reference DBC) —
// not this behavioral matcher.
//
// Pure & framework-free: no Svelte/Vite/DOM deps. Mutates nothing.

import type { TimedFrame } from './event-scorer.ts';

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/** A located field to correlate: a BIT (when `bit` set) or a whole BYTE. */
export interface FieldLocator {
  id: number;
  byteIndex: number;
  /** Bit within the byte (0 = LSB); omit for a whole-byte value. */
  bit?: number;
  /** Optional label (e.g. a known finding's name) carried through to the match. */
  name?: string;
}

export interface SynonymConfig {
  /** Resample grid step, µs (the two series are aligned onto this grid). */
  stepUs: number;
  /** Minimum overlapping grid samples before a correlation is trusted. */
  minOverlap: number;
  /** |Pearson r| at/above which two fields are called synonyms. */
  threshold: number;
}

export const SYNONYM_DEFAULTS: SynonymConfig = {
  stepUs: 100_000, // 100 ms grid
  minOverlap: 20,
  threshold: 0.8,
};

export interface SynonymMatch {
  field: FieldLocator;
  /** Pearson correlation of the value series, [-1, 1]. */
  correlation: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Rank the `candidates` (known fields) that move TOGETHER with `target` over the
 * frames — behavioral synonyms. Excludes `target` itself; returns matches with
 * |r| ≥ threshold, strongest first.
 *
 * Pure: does not mutate inputs.
 *
 * @param frames     raw timed history (any ids interleaved).
 * @param target     the field to find synonyms for (a run candidate's locus).
 * @param candidates known fields to test (e.g. the project's findings).
 * @param config     optional grid / threshold overrides.
 */
export function findSynonyms(
  frames: ReadonlyArray<TimedFrame>,
  target: FieldLocator,
  candidates: ReadonlyArray<FieldLocator>,
  config: Partial<SynonymConfig> = {},
): SynonymMatch[] {
  const cfg: SynonymConfig = { ...SYNONYM_DEFAULTS, ...config };
  const t = series(frames, target);
  if (t.tUs.length < 2) return [];
  const tStart = t.tUs[0];
  const tEnd = t.tUs[t.tUs.length - 1];

  const matches: SynonymMatch[] = [];
  for (const c of candidates) {
    if (c.id === target.id && c.byteIndex === target.byteIndex && (c.bit ?? null) === (target.bit ?? null)) {
      continue; // the field is not its own synonym
    }
    const cs = series(frames, c);
    if (cs.tUs.length < 2) continue;
    const gStart = Math.max(tStart, cs.tUs[0]);
    const gEnd = Math.min(tEnd, cs.tUs[cs.tUs.length - 1]);
    if (gEnd <= gStart) continue;
    if (Math.floor((gEnd - gStart) / cfg.stepUs) + 1 < cfg.minOverlap) continue;
    const a = resampleHold(t, gStart, gEnd, cfg.stepUs);
    const b = resampleHold(cs, gStart, gEnd, cfg.stepUs);
    const r = pearson(a, b);
    if (Math.abs(r) >= cfg.threshold) matches.push({ field: c, correlation: r });
  }
  matches.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation));
  return matches;
}

/* ────────────────────────────────────────────────────────────────────────
 * Series extraction, resampling, correlation
 * ──────────────────────────────────────────────────────────────────────── */

interface Series {
  tUs: number[];
  v: number[];
}

/** The field's value series for its id, sorted by time (bit → 0/1, else byte). */
function series(frames: ReadonlyArray<TimedFrame>, loc: FieldLocator): Series {
  const pts: { t: number; v: number }[] = [];
  for (const f of frames) {
    if (f.id !== loc.id || loc.byteIndex >= f.data.length) continue;
    const v = loc.bit === undefined ? f.data[loc.byteIndex] : (f.data[loc.byteIndex] >> loc.bit) & 1;
    pts.push({ t: f.tUs, v });
  }
  pts.sort((a, b) => a.t - b.t);
  return { tUs: pts.map((p) => p.t), v: pts.map((p) => p.v) };
}

/** Resample a series onto [start, end] at `step` by last-value-hold. */
function resampleHold(s: Series, start: number, end: number, step: number): number[] {
  const out: number[] = [];
  let j = 0;
  let last = s.v.length ? s.v[0] : 0;
  for (let g = start; g <= end; g += step) {
    while (j < s.tUs.length && s.tUs[j] <= g) {
      last = s.v[j];
      j += 1;
    }
    out.push(last);
  }
  return out;
}

/** Pearson correlation; 0 when either series is constant (no variance). */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}
