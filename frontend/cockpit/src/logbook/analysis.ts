/**
 * LOGBOOK analysis SEAM — the ONE swappable boundary between the run and the
 * scoring. The frame ring lives in the ANALYSIS WORKER (not the main thread), so
 * this seam dispatches to the worker's `logbook` message, which runs the HARDENED
 * `analyzeRun` (positive evidence + negative control + response-type + significance
 * gate, shared/analysis/logbook.ts) over the worker-owned ring, then maps the
 * shared `LogbookResult` into the flat shape the Run UI + promote-to-finding read.
 */

import { huntScan } from '../state/store';
import type { ResponseType, RunWindow } from '@shared/analysis/logbook.ts';

/** A candidate surfaced by a run, in the shape the Logbook UI + promote-to-finding read. */
export interface AnalyzedCandidate {
  /** Stable key (the hunt candidate id) for UI selection. */
  key: string;
  frameId: number;
  isExtended: boolean;
  byteIndex: number;
  /** Bit within the byte for a single-bit flag; undefined for a whole/multi-byte field. */
  bit?: number;
  bitLength: number;
  /** Positive-evidence strength (set-relative). */
  score: number;
  rationale: string;
  // ── hardened verdict (present when `hardened`) ──
  /** False when the candidate also moved during baseline/noise (confounded). */
  passesControl?: boolean;
  /** Response dynamics from the observe (after-effect) window. */
  responseType?: 'pulse' | 'level' | 'delayed' | 'trend';
  /** False when the stimulus match could plausibly be chance. */
  significant?: boolean;
}

export interface LogbookAnalysis {
  /** The scorer mode actually run ('event' | 'trend' | … | 'none'). */
  mode: string;
  /** Candidates, strongest first (cleared first, then by score). */
  candidates: AnalyzedCandidate[];
  framesAnalyzed: number;
  /** A short human note (empty-result explanation, or the no-clearance reason). */
  note: string;
  /** True when the negative-control + significance verdict was computed. */
  hardened: boolean;
}

/** ResponseType narrowed to the finding kinds ('inconclusive' → undefined). */
const kindOf = (t: ResponseType): 'pulse' | 'level' | 'delayed' | 'trend' | undefined =>
  t === 'inconclusive' ? undefined : t;

/** A behavioral synonym (a locus whose value series tracks the target's). */
export interface LogbookSynonym {
  frameId: number;
  byteIndex: number;
  bit?: number;
  name?: string;
  /** Pearson correlation of the value series, [-1, 1]. */
  correlation: number;
}

/** A candidate's replay trace (step series over the run span) + behavioral synonyms. */
export interface LogbookDetail {
  trace: { tUs: number[]; values: number[] };
  min: number;
  max: number;
  synonyms: LogbookSynonym[];
}

/**
 * Fetch a candidate's REPLAY trace (its value over the run span, for overlaying on
 * the stimulus timeline) + its BEHAVIORAL synonyms (correlated loci among `others`
 * — the run's other candidates and the known findings). Runs in the worker over its
 * ring; returns null on an unexpected result.
 */
export async function fetchLogbookDetail(
  target: { frameId: number; byteIndex: number; bit?: number },
  others: { frameId: number; byteIndex: number; bit?: number; name?: string }[],
  span: { startTUs: number; endTUs: number },
): Promise<LogbookDetail | null> {
  const res = await huntScan({ kind: 'logbookDetail', target, others, startTUs: span.startTUs, endTUs: span.endTUs });
  if (res.kind !== 'logbookDetail') return null;
  return { trace: res.trace, min: res.min, max: res.max, synonyms: res.synonyms };
}

/**
 * Analyze a completed (or stopped) run.
 *
 * @param run      the run engine's output: stamped windows + stimulus kind.
 * @param opts     `excluded` = known-signal slots ("frameId:byteIndex") to drop.
 */
export async function analyzeLogbookRun(
  run: { windows: RunWindow[]; stimulusKind: 'event' | 'trend' },
  opts: { excluded?: string[] } = {},
): Promise<LogbookAnalysis> {
  if (run.windows.every((w) => w.role !== 'stimulus')) {
    return { mode: 'none', candidates: [], framesAnalyzed: 0, note: 'no stimulus window was captured', hardened: true };
  }

  const res = await huntScan({
    kind: 'logbook',
    run: { windows: run.windows, stimulusKind: run.stimulusKind },
    excluded: opts.excluded ?? [],
  });
  if (res.kind !== 'logbook') {
    return { mode: 'none', candidates: [], framesAnalyzed: 0, note: 'unexpected analysis result', hardened: true };
  }

  const r = res.result;
  // analyzeRun already ranked the candidates (control-passers first, then score).
  const candidates: AnalyzedCandidate[] = r.candidates.map((c) => ({
    key: c.key,
    frameId: c.id,
    isExtended: res.isExtended[c.id] ?? c.id > 0x7ff,
    byteIndex: c.byteIndex,
    bit: c.event?.bit,
    bitLength: c.event ? 1 : (c.trend?.width ?? c.compare?.width ?? 8),
    score: c.logbookScore,
    rationale: c.rationale,
    passesControl: c.passesControl,
    responseType: kindOf(c.type),
    significant: c.significant,
  }));
  return { mode: r.mode, candidates, framesAnalyzed: r.framesAnalyzed, note: r.note, hardened: true };
}
