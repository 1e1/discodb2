/**
 * Hunt / Wizard SEAM (DESIGN §9) — now BACKED BY frontend/shared.
 *
 * The detection Wizard ("event-with-repetitions; robust monotone-trend") is
 * implemented once, framework-free, in frontend/shared/analysis. The cockpit is
 * the Wizard HOST (docs/WIZARD.md → "Distributed execution"), so this file is
 * the BOUNDARY ADAPTER that plugs the shared `runExperiment` into the cockpit's
 * seam without modifying either side.
 *
 *     runExperiment(window: ExperimentWindow): RankedCandidate[]
 *
 * The seam types below are the cockpit's vocabulary (FrameView frames; events as
 * bare backend-µs timestamps; candidates as an absolute bit RANGE bitStart/
 * bitLength + byteOrder + a string id). The shared scorers speak a different
 * vocabulary (TimedFrame; EventMark{at,quality}; candidates as byteIndex/bit or
 * byteIndex/width/byteOrder/signed; a wrapped ExperimentResult). The deltas are
 * catalogued at the top of frontend/shared/analysis/run-experiment.ts; this
 * module reconciles every one of them:
 *
 *   • events number[] -> EventMark[]   (attach quality:'good' to each bare mark)
 *   • compare {a,b}    -> passed through unchanged (two backend-µs windows)
 *   • candidate locus  -> bitStart/bitLength: event   bit   -> byteIndex*8+bit, len 1
 *                                              trend   width -> byteIndex*8,      len width
 *                                              compare width -> byteIndex*8,      len width
 *                          (compare's signed delta + medians ride on `evidence`)
 *   • result wrapper   -> unwrap result.candidates into a bare RankedCandidate[]
 *   • 2nd config arg   -> dropped (we call the shared fn with one arg)
 *   • candidateIds     -> the shared scorers have no allow-list, so we pre-filter
 *                          window.frames by id before handing them over
 *   • string id        -> the shared candidate's deterministic `key` verbatim
 *   • isExtended       -> threaded back from the original window by frame id
 *                          (the shared scorers key on the numeric id only)
 *
 * The adapter is PURE and synchronous over the provided window (it just calls the
 * pure shared fn and maps shapes), so it stays trivially testable and relocatable
 * into a worker later, exactly as the seam contract requires.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  runExperiment as sharedRunExperiment,
  type ExperimentWindow as SharedWindow,
  type ExperimentMarks as SharedMarks,
  type ExperimentResult,
  type UnifiedCandidate,
} from '@shared/analysis/run-experiment.ts';
import type { EventMark } from '@shared/analysis/event-scorer.ts';
import type { ByteOrder } from '@shared/protocol.ts';

/**
 * What the human did, and when, expressed in BACKEND monotonic µs (§4.2) so it
 * lines up with frame timestamps. For "event-with-repetitions" the operator
 * marks each repetition of the stimulus (e.g. pressed the button 5×); for a
 * "monotone-trend" experiment they mark a continuous sweep (e.g. turned the
 * wheel lock-to-lock) with a direction.
 */
export interface ExperimentMarks {
  /** Discrete stimulus timestamps (backend µs), e.g. button presses. */
  events?: number[];
  /** A continuous sweep interval with an expected monotone direction. */
  trend?: { startTUs: number; endTUs: number; direction: 'up' | 'down' };
  /**
   * 2-POINT mode: two captured steady-state windows over the SAME `frames`, for a
   * signal you can't ramp (e.g. fuel tank FULL vs LOW). State A and state B are
   * each a [startTUs, endTUs] interval on the backend µs clock; the scorer ranks
   * the fields whose robust LEVEL shifted the most between them. Same shape the
   * shared `marks.compare` consumes (docs/WIZARD.md → "2-point" capture).
   */
  compare?: {
    /** State A capture window (e.g. tank FULL), backend µs, both ends inclusive. */
    a: { startTUs: number; endTUs: number };
    /** State B capture window (e.g. tank LOW), backend µs, both ends inclusive. */
    b: { startTUs: number; endTUs: number };
  };
  /** Free-text note from the operator describing the action. */
  note?: string;
}

/**
 * The analysis input: a slice of raw history plus the operator's annotations.
 * `frames` is a materialized window from the RawFrameRing (sorted ascending by
 * tUs). Bounding the window is the caller's job (Hunt panel) so the Wizard sees
 * only the relevant span.
 */
export interface ExperimentWindow {
  /** Raw frames in [startTUs, endTUs], ascending by tUs. */
  frames: FrameView[];
  startTUs: number;
  endTUs: number;
  /** Operator annotations of the stimulus. */
  marks: ExperimentMarks;
  /** Optional id allow-list to restrict the search. Empty/undefined = all. */
  candidateIds?: number[];
}

/**
 * One ranked hypothesis: "this bit range on this id encodes the thing you did".
 * `score` is higher-is-better and only comparable WITHIN one result set.
 */
export interface RankedCandidate {
  /** Stable id for UI keys/selection. */
  id: string;
  frameId: number;
  isExtended: boolean;
  /** Proposed bit range within the payload. */
  bitStart: number;
  bitLength: number;
  byteOrder: 'big' | 'little';
  /** Higher = stronger evidence. Set-relative, not absolute. */
  score: number;
  /** Short human-readable rationale ("toggled on each of 5 presses"). */
  rationale: string;
  /** Optional supporting evidence the panel can visualize. */
  evidence?: CandidateEvidence;
}

export interface CandidateEvidence {
  /** Per-event the observed raw value, to show alignment with the stimulus. */
  perEventValues?: number[];
  /** For trend experiments: correlation/monotonicity coefficient in [-1,1]. */
  trendCoefficient?: number;
  /** How many frames of this id were in the window. */
  frameCount?: number;
  /** 2-point only: signed level change between states (median_A − median_B). */
  compareDelta?: number;
  /** 2-point only: robust central value (median) in state A, raw units. */
  compareMedianA?: number;
  /** 2-point only: robust central value (median) in state B, raw units. */
  compareMedianB?: number;
}

/**
 * Out-of-band run metadata the shared result carries that the bare seam array
 * cannot. The panel surfaces these on a status line (docs/WIZARD.md: "N good /
 * M total"; tagger exclusions). Returned by {@link runExperimentDetailed}.
 */
export interface ExperimentRunInfo {
  mode: 'event' | 'trend' | 'compare' | 'none';
  /** Tagger ∪ caller exclusions actually applied (counters/checksums skipped). */
  excludedCount: number;
  /** Event mode: good trials actually scored. */
  goodEvents?: number;
  /** Event mode: total trials supplied (good + failed). */
  totalEvents?: number;
  /** Trend mode: distinct ids with ≥1 frame in the window. */
  idsInWindow?: number;
  /** Trend mode: total frames inside the window. */
  framesInWindow?: number;
  /** 2-point mode: frames sliced into state A (the `a` capture window). */
  framesA?: number;
  /** 2-point mode: frames sliced into state B (the `b` capture window). */
  framesB?: number;
}

/** The full adapter result: the seam array plus the out-of-band run info. */
export interface DetailedResult {
  candidates: RankedCandidate[];
  info: ExperimentRunInfo;
}

/**
 * THE SEAM (DESIGN §9). Adapts the cockpit window to the shared Wizard and maps
 * the result back to the seam's bare `RankedCandidate[]`.
 *
 * Contract (unchanged):
 *   - PURE and synchronous over the provided window (the shared fn is pure).
 *   - Returns candidates sorted by descending `score` (the scorers sort).
 *   - May return [] when the window is too sparse to rank, or when no mark was
 *     supplied (there is nothing to score).
 */
export function runExperiment(window: ExperimentWindow): RankedCandidate[] {
  return runExperimentDetailed(window).candidates;
}

/**
 * Same as {@link runExperiment} but also returns the out-of-band run info
 * (mode, good/total, exclusions) the Hunt panel shows on its status line.
 */
export function runExperimentDetailed(window: ExperimentWindow): DetailedResult {
  // ── candidateIds allow-list (no shared equivalent) → pre-filter frames. ──────
  const allow =
    window.candidateIds && window.candidateIds.length > 0
      ? new Set(window.candidateIds)
      : null;
  const frames = allow ? window.frames.filter((f) => allow.has(f.id)) : window.frames;

  // ── isExtended is dropped by the shared scorers → remember it per id so we
  // can thread it back onto each candidate. (One id rarely appears as both
  // 11- and 29-bit; if it does, last-seen wins — the scorers can't tell them
  // apart anyway, which is an accepted limitation of the shared id keying.)
  const extById = new Map<number, boolean>();
  for (const f of frames) extById.set(f.id, f.isExtended);

  // ── marks: events number[] -> EventMark[] (attach quality:'good'); trend and
  // compare pass through unchanged (same {startTUs,endTUs,…} / {a,b} shapes). ──
  const sharedMarks: SharedMarks = {};
  if (window.marks.events && window.marks.events.length > 0) {
    sharedMarks.events = window.marks.events.map(
      (at): EventMark => ({ at, quality: 'good' }),
    );
  }
  if (window.marks.trend) {
    sharedMarks.trend = window.marks.trend;
  }
  if (window.marks.compare) {
    sharedMarks.compare = window.marks.compare;
  }

  // ── frames: FrameView (Uint8Array data) -> TimedFrame (number[] data).
  // TimedFrame is structurally {id, data:number[], tUs}; FrameView is a
  // superset EXCEPT data is a Uint8Array. The scorers index data and clamp to
  // 0..255 internally, but the declared type is number[], so convert. ──────────
  const sharedWin: SharedWindow = {
    frames: frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) })),
    marks: sharedMarks,
  };

  // ── call the shared Wizard (single arg; drop the optional 2nd config). ───────
  const result: ExperimentResult = sharedRunExperiment(sharedWin);

  // ── unwrap result.candidates and map each unified candidate to the seam. ─────
  const candidates = result.candidates.map((c) => toSeamCandidate(c, extById));
  return { candidates, info: toRunInfo(result) };
}

/**
 * Map ONE shared UnifiedCandidate to the cockpit seam's RankedCandidate,
 * reconciling the locus per the shared header:
 *   event → bitStart = byteIndex*8 + bit, bitLength = 1, byteOrder 'little'
 *           (a single bit has no real endianness; 'little' is the cockpit's
 *           default and decode.ts treats a length-1 little range as that exact
 *           CAN bit index — see signalBitOrder).
 *   trend → bitStart = byteIndex*8, bitLength = width, byteOrder from the field.
 *   compare (2-point) → same locus as trend (bitStart = byteIndex*8,
 *           bitLength = width, byteOrder from the field); the signed delta and
 *           the two medians ride along on `evidence` (no dedicated seam field).
 * The shared deterministic `key` becomes the seam's stable string `id`.
 */
function toSeamCandidate(
  c: UnifiedCandidate,
  extById: Map<number, boolean>,
): RankedCandidate {
  const isExtended = extById.get(c.id) ?? false;

  if (c.mode === 'compare' && c.compare) {
    const cmp = c.compare;
    return {
      id: c.key,
      frameId: c.id,
      isExtended,
      bitStart: c.byteIndex * 8,
      bitLength: cmp.width,
      byteOrder: cmp.byteOrder,
      score: c.score,
      rationale: c.rationale,
      evidence: {
        compareDelta: cmp.delta,
        compareMedianA: cmp.medianA,
        compareMedianB: cmp.medianB,
      },
    };
  }

  if (c.mode === 'event' && c.event) {
    const ev = c.event;
    return {
      id: c.key,
      frameId: c.id,
      isExtended,
      bitStart: c.byteIndex * 8 + ev.bit,
      bitLength: 1,
      byteOrder: 'little',
      score: c.score,
      rationale: c.rationale,
      evidence: {
        // Per-good-trial ACTION bit value, so the panel can show the flip
        // aligning with each stimulus (rest -> action is in the rationale).
        perEventValues: ev.evidence.map((e) => e.action ?? -1),
        frameCount: ev.evidence.length,
      },
    };
  }

  // trend (and a defensive fallback if a future mode arrives without .event).
  const width = c.trend ? c.trend.width : 8;
  const byteOrder: ByteOrder = c.trend ? c.trend.byteOrder : 'little';
  return {
    id: c.key,
    frameId: c.id,
    isExtended,
    bitStart: c.byteIndex * 8,
    bitLength: width,
    byteOrder,
    score: c.score,
    rationale: c.rationale,
    evidence: {
      trendCoefficient: c.trend ? c.trend.spearman : undefined,
    },
  };
}

/** Surface the shared result's out-of-band stats for the Hunt status line. */
function toRunInfo(result: ExperimentResult): ExperimentRunInfo {
  const info: ExperimentRunInfo = {
    mode: result.mode,
    excludedCount: result.excludedCount,
  };
  if (result.stats.mode === 'event') {
    info.goodEvents = result.stats.goodEvents;
    info.totalEvents = result.stats.totalEvents;
  } else if (result.stats.mode === 'trend') {
    info.idsInWindow = result.stats.idsInWindow;
    info.framesInWindow = result.stats.framesInWindow;
  } else if (result.stats.mode === 'compare') {
    info.framesA = result.stats.framesA;
    info.framesB = result.stats.framesB;
  }
  return info;
}
