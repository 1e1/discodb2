// discodb2 — LOGBOOK: analyze a STIMULUS-RESPONSE protocol run (frontend/shared/analysis).
//
// SOURCE OF TRUTH: the Logbook ("carnet de chasse") design — a storyboard run is a
// CONTROLLED EXPERIMENT whose executed, timestamped windows are the analyzer's
// LABELS: baseline → noise → wait → ⟳[stimulus → observe] → recover. This turns
// signal discovery into a SUPERVISED problem.
//
// It does NOT reinvent scoring: it maps the run's windows onto the Wizard's
// `runExperiment` (frontend/shared/analysis/run-experiment.ts) for the POSITIVE
// evidence — the stimulus repetitions become EVENT marks (a bit/field that flips
// in phase with the repeated action) or a TREND window (a ramped field) — then
// adds the experiment's missing half: the NEGATIVE CONTROL. A candidate that also
// moves during the NOISE / BASELINE windows (when NO stimulus was applied — those
// hold the confounders: brake, wipers, speed…) is demoted/flagged: the headlight
// signal must respond to the flash, NOT to normal driving.
//
//   score_logbook = runExperiment_score × (1 − noise_response)
//   passesControl = noise_response < noiseFailRate
//
// The control measures the candidate's CHANGE RATE over the noise windows — at BIT
// grain for an event candidate (its own bit), at BYTE grain otherwise — so a busy
// neighbour bit can't unfairly sink a clean flag.
//
// HONEST result: when nothing clears the control, that is reported (the signal may
// be on LIN / a direct wire / UDS-only — a valid negative finding), not forced.
//
// Pure & framework-free: no Svelte/Vite/DOM deps; runs in the cockpit, the analysis
// Worker, or a Node test runner. Mutates nothing, allocates fresh output.
//
// Also: the OBSERVE window classifies the response TYPE (pulse / latched-level /
// delayed-cascade), and a CHANCE GATE (`p^N`, p = the bit's off-stimulus base
// rate) rejects low-rep coincidences. NOT YET: cross-session synonym match.

import { runExperiment, type ExperimentMarks, type UnifiedCandidate } from './run-experiment.ts';
import type { TimedFrame } from './event-scorer.ts';

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

export type PhaseRole = 'baseline' | 'noise' | 'wait' | 'stimulus' | 'observe' | 'recover';

/** One executed, timestamped window of a run (a label on the µs clock). */
export interface RunWindow {
  role: PhaseRole;
  startTUs: number;
  endTUs: number;
  /** Repetition number for stimulus/observe steps (1-based); 0/absent otherwise. */
  rep?: number;
}

export interface LogbookRun {
  /** The executed windows, in order. */
  windows: RunWindow[];
  /**
   * How to read the stimulus: discrete instants (pulse/level → EVENT scoring) or a
   * continuous ramp (TREND scoring). Default 'event'.
   */
  stimulusKind?: 'event' | 'trend';
  /** TREND only: expected sweep direction of the target field. */
  trendDirection?: 'up' | 'down';
}

export interface LogbookConfig {
  /** A candidate FAILS the control when its noise change-rate is ≥ this (0..1). */
  noiseFailRate: number;
  /**
   * Significance threshold for the chance gate. An event candidate is significant
   * when the probability of matching the stimulus at all N reps BY CHANCE —
   * `p^N`, p = its off-stimulus base rate of being at the action value — is below
   * this. Guards against the low-rep (e.g. 3) coincidence: a bit that's "on" most
   * of the time would match a handful of stimuli by luck.
   */
  alpha: number;
  /** Known signal slots to exclude up front, "id:byteIndex" (merged with the tagger's). */
  excluded: ReadonlyArray<string>;
}

export const LOGBOOK_DEFAULTS: LogbookConfig = {
  noiseFailRate: 0.5,
  alpha: 0.05,
  excluded: [],
};

/** The response dynamics inferred from the stimulus + observe (after-effect) windows. */
export type ResponseType = 'pulse' | 'level' | 'delayed' | 'trend' | 'inconclusive';

/** A unified candidate enriched with the control verdict, response type & significance. */
export interface LogbookCandidate extends UnifiedCandidate {
  /** Change rate of the candidate over the noise/baseline windows, 0..1. */
  noiseResponse: number;
  /** False when the candidate also moved during the control windows (confounded). */
  passesControl: boolean;
  /** Response dynamics from the stimulus + observe windows (pulse/level/delayed/…). */
  type: ResponseType;
  /** Probability of the stimulus match being a chance coincidence (`p^N`); lower = better. */
  chanceLevel: number;
  /** False when the match could plausibly be chance (chanceLevel ≥ alpha). */
  significant: boolean;
  /** Final ranking: the runExperiment score penalized by the noise response. */
  logbookScore: number;
}

export interface LogbookResult {
  /** The runExperiment mode used ('event' | 'trend' | … | 'none'). */
  mode: string;
  /** Candidates, ranked: control-passers first, then by logbookScore. */
  candidates: LogbookCandidate[];
  /** Frames the analysis ran over. */
  framesAnalyzed: number;
  /** Empty when a candidate cleared the controls; else an explanation. */
  note: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Analyze one protocol run: positive evidence via {@link runExperiment} over the
 * stimulus windows, then the baseline/noise negative control.
 *
 * Pure: does not mutate `run`, `frames`, or `config`.
 *
 * @param run    the executed, timestamped windows (+ stimulus kind).
 * @param frames raw timed history covering the run (any ids interleaved).
 * @param config optional thresholds / known-exclusions.
 */
export function analyzeRun(
  run: LogbookRun,
  frames: ReadonlyArray<TimedFrame>,
  config: Partial<LogbookConfig> = {},
): LogbookResult {
  const cfg: LogbookConfig = { ...LOGBOOK_DEFAULTS, ...config };
  const stim = run.windows.filter((w) => w.role === 'stimulus');
  // Negative-control windows = where NO stimulus was applied but the bus was live.
  const control = run.windows.filter((w) => w.role === 'noise' || w.role === 'baseline');

  if (stim.length === 0) {
    return { mode: 'none', candidates: [], framesAnalyzed: frames.length, note: 'no stimulus window in the run' };
  }

  // Map the run → the Wizard's marks (positive evidence).
  let marks: ExperimentMarks;
  if (run.stimulusKind === 'trend') {
    const w = stim[0];
    marks = { trend: { startTUs: w.startTUs, endTUs: w.endTUs, direction: run.trendDirection ?? 'up' } };
  } else {
    // The cue instant is the ONSET (window start): the event-scorer reads REST
    // just before it and ACTION just after (past its latency guard), so the rest
    // must fall BEFORE the action begins.
    marks = { events: stim.map((w) => ({ at: w.startTUs, quality: 'good' as const })) };
  }

  const res = runExperiment(
    { frames: frames as TimedFrame[], marks, excluded: new Set(cfg.excluded) },
  );

  // Per-rep windows for the response-TYPE classification, and the off-stimulus
  // windows (baseline/noise/wait — nothing applied) for the chance base rate.
  const stimWins = run.windows.filter((w) => w.role === 'stimulus');
  const obsWins = run.windows.filter((w) => w.role === 'observe');
  const offStim = run.windows.filter((w) => w.role === 'baseline' || w.role === 'noise' || w.role === 'wait');
  const reps = stimWins.length;

  const candidates: LogbookCandidate[] = res.candidates.map((c) => {
    // (1) negative control: bit grain for an event candidate, byte grain otherwise.
    const noiseResponse =
      c.event !== undefined
        ? bitChangeRate(frames, c.id, c.byteIndex, c.event.bit, control)
        : byteChangeRate(frames, c.id, c.byteIndex, control);
    const passesControl = noiseResponse < cfg.noiseFailRate;
    // (2) response type from the stimulus + observe windows.
    const type = classifyType(frames, c, stimWins, obsWins);
    // (3) chance gate (p^N): could the stimulus match be a coincidence?
    const { chanceLevel, significant } = significanceOf(frames, c, offStim, reps, cfg.alpha);
    const logbookScore = c.score * (1 - Math.min(1, noiseResponse));
    return { ...c, noiseResponse, passesControl, type, chanceLevel, significant, logbookScore };
  });

  // CLEARED = passed the noise control AND not plausibly chance. Cleared first,
  // then strongest logbookScore.
  const cleared = (c: LogbookCandidate) => c.passesControl && c.significant;
  candidates.sort((a, b) => (cleared(b) ? 1 : 0) - (cleared(a) ? 1 : 0) || b.logbookScore - a.logbookScore);

  const note =
    candidates.length === 0
      ? 'the stimulus produced no candidate'
      : candidates.some(cleared)
        ? ''
        : 'no candidate cleared the noise control + significance check — the signal may not be on this bus (LIN / direct wire / UDS-only)';

  return { mode: res.mode, candidates, framesAnalyzed: frames.length, note };
}

/* ────────────────────────────────────────────────────────────────────────
 * Negative-control change rates over a set of windows
 * ──────────────────────────────────────────────────────────────────────── */

function inAny(tUs: number, windows: ReadonlyArray<RunWindow>): boolean {
  for (const w of windows) if (tUs >= w.startTUs && tUs <= w.endTUs) return true;
  return false;
}

/** Frames of one id whose tUs falls in any window, sorted by tUs. */
function sliceId(frames: ReadonlyArray<TimedFrame>, id: number, windows: ReadonlyArray<RunWindow>): TimedFrame[] {
  return frames.filter((f) => f.id === id && inAny(f.tUs, windows)).sort((a, b) => a.tUs - b.tUs);
}

/** Fraction of consecutive frame-pairs where the byte changed (0 when <2 pairs). */
function byteChangeRate(
  frames: ReadonlyArray<TimedFrame>,
  id: number,
  byteIndex: number,
  windows: ReadonlyArray<RunWindow>,
): number {
  const f = sliceId(frames, id, windows);
  let pairs = 0;
  let changes = 0;
  for (let i = 1; i < f.length; i++) {
    const p = f[i - 1].data;
    const c = f[i].data;
    if (byteIndex >= p.length || byteIndex >= c.length) continue;
    pairs += 1;
    if (p[byteIndex] !== c[byteIndex]) changes += 1;
  }
  return pairs > 0 ? changes / pairs : 0;
}

/** Fraction of consecutive frame-pairs where the BIT flipped (0 when <2 pairs). */
function bitChangeRate(
  frames: ReadonlyArray<TimedFrame>,
  id: number,
  byteIndex: number,
  bit: number,
  windows: ReadonlyArray<RunWindow>,
): number {
  const f = sliceId(frames, id, windows);
  let pairs = 0;
  let changes = 0;
  for (let i = 1; i < f.length; i++) {
    const p = f[i - 1].data;
    const c = f[i].data;
    if (byteIndex >= p.length || byteIndex >= c.length) continue;
    pairs += 1;
    if (((p[byteIndex] >> bit) & 1) !== ((c[byteIndex] >> bit) & 1)) changes += 1;
  }
  return pairs > 0 ? changes / pairs : 0;
}

/* ────────────────────────────────────────────────────────────────────────
 * Response-type classification (stimulus vs observe) + chance gate
 * ──────────────────────────────────────────────────────────────────────── */

/** Candidate values over a window set: the BIT (event candidate) or the BYTE. */
function valuesIn(
  frames: ReadonlyArray<TimedFrame>,
  id: number,
  byteIndex: number,
  bit: number | null,
  windows: ReadonlyArray<RunWindow>,
): number[] {
  const out: number[] = [];
  for (const f of frames) {
    if (f.id !== id || !inAny(f.tUs, windows)) continue;
    if (byteIndex >= f.data.length) continue;
    out.push(bit === null ? f.data[byteIndex] : (f.data[byteIndex] >> bit) & 1);
  }
  return out;
}

/** Most frequent value (mode), or null when empty. */
function modeOf(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const m = new Map<number, number>();
  let best = vals[0];
  let bestCount = 0;
  for (const v of vals) {
    const n = (m.get(v) ?? 0) + 1;
    m.set(v, n);
    if (n > bestCount) {
      bestCount = n;
      best = v;
    }
  }
  return best;
}

/**
 * Classify response dynamics from the per-rep rest → stimulus → observe values:
 *   responded in stimulus, returns to rest in observe → PULSE (momentary);
 *   responded and STAYS through observe                → LEVEL (latched);
 *   no change in stimulus but changes in observe       → DELAYED (cascade).
 * Majority vote across reps; trend candidates are 'trend'. Bit grain for an event
 * candidate, byte grain otherwise.
 */
function classifyType(
  frames: ReadonlyArray<TimedFrame>,
  c: UnifiedCandidate,
  stimWins: ReadonlyArray<RunWindow>,
  obsWins: ReadonlyArray<RunWindow>,
): ResponseType {
  if (c.trend) return 'trend';
  const bit = c.event ? c.event.bit : null;
  const votes = { pulse: 0, level: 0, delayed: 0 };
  for (const sw of stimWins) {
    const ow = obsWins.find((w) => w.rep === sw.rep);
    const restWin: RunWindow[] = [{ role: 'wait', startTUs: sw.startTUs - 1e6, endTUs: sw.startTUs }];
    const rest = modeOf(valuesIn(frames, c.id, c.byteIndex, bit, restWin));
    const stim = modeOf(valuesIn(frames, c.id, c.byteIndex, bit, [sw]));
    const obs = ow ? modeOf(valuesIn(frames, c.id, c.byteIndex, bit, [ow])) : null;
    if (rest === null || stim === null) continue;
    if (stim !== rest) {
      if (obs === null || obs === rest) votes.pulse += 1;
      else votes.level += 1;
    } else if (obs !== null && obs !== rest) {
      votes.delayed += 1;
    }
  }
  let best: ResponseType = 'inconclusive';
  let bestCount = 0;
  for (const k of ['pulse', 'level', 'delayed'] as const) {
    if (votes[k] > bestCount) {
      bestCount = votes[k];
      best = k;
    }
  }
  return bestCount > 0 ? best : 'inconclusive';
}

/**
 * Chance gate: estimate the bit's base rate `p` of sitting at the ACTION value
 * during the OFF-stimulus windows (nothing applied), then `p^reps` is the
 * probability of `reps` independent coincidental matches. Only EVENT candidates
 * (a bit with a clear action value) are gated; others pass (trust runExperiment).
 */
function significanceOf(
  frames: ReadonlyArray<TimedFrame>,
  c: UnifiedCandidate,
  offStim: ReadonlyArray<RunWindow>,
  reps: number,
  alpha: number,
): { chanceLevel: number; significant: boolean } {
  if (!c.event) return { chanceLevel: 0, significant: true };
  const actionVal = c.event.direction === '0->1' ? 1 : 0;
  const off = valuesIn(frames, c.id, c.byteIndex, c.event.bit, offStim);
  if (off.length === 0) return { chanceLevel: 1, significant: false };
  const p = off.filter((v) => v === actionVal).length / off.length;
  const chanceLevel = Math.pow(p, Math.max(1, reps));
  return { chanceLevel, significant: chanceLevel < alpha };
}
