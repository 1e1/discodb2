// discodb2 — MARKHUNT field-run analyzer (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/markhunt-spec.md §7. A Markhunt ("free-run / highlighter")
// recording is the SAME artifact as a Logbook run — a recording + a set of
// labeled, timestamped windows — reached bottom-up: paint spans live, assign
// their MEANING (a `SpanType`) afterward. This module turns a typed field run
// into analysis by dispatching each span-type to the EXISTING scorers (no fork)
// and merging the results, plus the one new question — equivalence ("≈") — via
// the equivalence scorer.
//
//   span TYPE          → scorer / question
//   ───────────────────────────────────────────────────────────────────────────
//   stable             → the NEGATIVE CONTROL window set (≡ Logbook baseline/noise)
//   rampUp / rampDown   → runExperiment trend mark (direction up/down)
//   level              → runExperiment compare mark (a stable span = A, level = B)
//   event              → runExperiment events mark (the span ONSETS are the cues)
//   ignore / gaps      → excluded from positive evidence
//   span.equivalentTo  → scoreEquivalence (returned-to-the-same-value test)
//
// Candidates from every question are merged by physical LOCUS (id × byte × bit/
// width/order), each is checked against the control (stable) windows for
// confounding — a candidate that also moves when nothing was happening is
// flagged — and the survivors are ranked control-passers first.
//
// Pure & framework-free: no Svelte/DOM/I-O. Runs in the cockpit, a Worker, or a
// Node test runner. Mutates none of its inputs; allocates fresh output.

import { runExperiment, type ExperimentMarks } from "./run-experiment.ts";
import { scoreEquivalence } from "./equivalence-scorer.ts";
import type { TimedFrame } from "./event-scorer.ts";
import type { ByteOrder } from "../protocol.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The meaning the operator assigns to a painted span AFTER the run (Markhunt
 * spec §3). Drives which scorer the span feeds.
 */
export type SpanType =
  | "stable" // steady state → negative-control / baseline reference
  | "rampUp" // continuous increase → trend, direction up
  | "rampDown" // continuous decrease → trend, direction down
  | "level" // a held, non-baseline level → compare(stable → level)
  | "event" // a momentary action (the span onset is the cue instant)
  | "ignore"; // explicitly excluded from analysis

/**
 * One painted, typed span. `id` is the span's own identity (so `equivalentTo`
 * can reference other spans). Windows are [startTUs, endTUs] on the backend µs
 * clock (both inclusive), non-overlapping (the painter guarantees this).
 */
export interface TypedSpan {
  id: string;
  startTUs: number;
  endTUs: number;
  type: SpanType;
  /** Ids of OTHER spans this one is asserted to hold the same value as ("≈"). */
  equivalentTo?: string[];
}

/** A typed field run: the executed spans over one recording. */
export interface FieldRunInput {
  spans: TypedSpan[];
}

export interface FieldRunConfig {
  /** A candidate FAILS the control when its change-rate over stable spans is ≥ this. */
  noiseFailRate: number;
  /** Known signal slots to exclude up front, `"id:byteIndex"` (decimal). */
  excluded: ReadonlyArray<string>;
}

export const FIELD_RUN_DEFAULTS: FieldRunConfig = {
  noiseFailRate: 0.5,
  excluded: [],
};

/** A candidate locus surfaced by one or more of the run's questions. */
export interface FieldRunCandidate {
  /** Numeric CAN id. */
  id: number;
  /** Byte index of the (first) byte of the locus. */
  byteIndex: number;
  /** Bit within the byte for a 1-bit (event) locus; undefined for a field locus. */
  bit?: number;
  /** Field width in bits for a multi-bit field locus (8/16); undefined for a bit. */
  width?: number;
  /** Byte order for a field locus; undefined for a bit. */
  byteOrder?: ByteOrder;
  /** Stable locus key (normalized across questions so the same field merges). */
  key: string;
  /** Which questions surfaced this locus (deduped, in first-seen order). */
  sources: string[];
  /** Best (max) score across the questions that surfaced it; clamped to [0,1]. */
  score: number;
  /** The rationale of the strongest contributing question. */
  rationale: string;
  /** Change rate over the stable (control) windows, 0..1 (NaN-safe: 0 if no control). */
  noiseResponse: number;
  /** False when the locus also moves during the stable windows (confounded). */
  passesControl: boolean;
}

export interface FieldRunResult {
  candidates: FieldRunCandidate[];
  framesAnalyzed: number;
  /** Human labels of the questions actually run (e.g. "trend up", "≈ x↔y"). */
  questionsRun: string[];
  /** Empty when at least one candidate cleared the control; else an explanation. */
  note: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Analyze a typed field run: dispatch each span-type to the matching scorer,
 * merge candidates by locus, and check each against the stable (control)
 * windows. Pure: mutates none of its inputs.
 */
export function analyzeFieldRun(
  input: FieldRunInput,
  frames: ReadonlyArray<TimedFrame>,
  config: Partial<FieldRunConfig> = {},
): FieldRunResult {
  const cfg: FieldRunConfig = { ...FIELD_RUN_DEFAULTS, ...config };
  const excluded = new Set(cfg.excluded);
  const spans = input.spans;

  const stable = spans.filter((s) => s.type === "stable");
  const ramps = spans.filter((s) => s.type === "rampUp" || s.type === "rampDown");
  const levels = spans.filter((s) => s.type === "level");
  const events = spans.filter((s) => s.type === "event");
  const equivPairs = spans.filter((s) => s.equivalentTo && s.equivalentTo.length > 0);

  const merged = new Map<string, FieldRunCandidate>();
  const questionsRun: string[] = [];

  // helper: fold a batch of unified candidates (from runExperiment) into the map.
  const foldUnified = (
    cands: ReturnType<typeof runExperiment>["candidates"],
    label: string,
  ) => {
    for (const c of cands) {
      const locus = unifiedLocus(c);
      if (!locus) continue;
      addCandidate(merged, locus, c.score, c.rationale, label);
    }
  };

  // ── TREND (rampUp/rampDown) — one runExperiment per ramp span. ───────────────
  for (const s of ramps) {
    const direction = s.type === "rampUp" ? "up" : "down";
    const marks: ExperimentMarks = {
      trend: { startTUs: s.startTUs, endTUs: s.endTUs, direction },
    };
    const res = runExperiment({ frames: frames as TimedFrame[], marks, excluded });
    foldUnified(res.candidates, `trend ${direction}`);
    questionsRun.push(`trend ${direction}`);
  }

  // ── LEVEL — compare each level span against a stable reference span. ─────────
  // Needs at least one stable span as state A; without one, a level shift has no
  // baseline to be measured against, so the question is skipped (noted).
  if (levels.length > 0 && stable.length > 0) {
    const ref = stable[0];
    for (const s of levels) {
      const marks: ExperimentMarks = {
        compare: {
          a: { startTUs: ref.startTUs, endTUs: ref.endTUs },
          b: { startTUs: s.startTUs, endTUs: s.endTUs },
        },
      };
      const res = runExperiment({ frames: frames as TimedFrame[], marks, excluded });
      foldUnified(res.candidates, "level shift");
      questionsRun.push("level shift");
    }
  }

  // ── EVENT — the span onsets are the cue instants (one combined run). ─────────
  if (events.length > 0) {
    const marks: ExperimentMarks = {
      events: events.map((s) => ({ at: s.startTUs, quality: "good" as const })),
    };
    const res = runExperiment({ frames: frames as TimedFrame[], marks, excluded });
    foldUnified(res.candidates, "event");
    questionsRun.push("event");
  }

  // ── EQUIVALENCE ("≈") — returned-to-the-same-value test per asserted pair. ───
  const byId = new Map(spans.map((s) => [s.id, s]));
  const seenPairs = new Set<string>();
  for (const s of equivPairs) {
    for (const targetId of s.equivalentTo!) {
      const t = byId.get(targetId);
      if (!t || t.id === s.id) continue;
      // Dedupe symmetric pairs (x≈y and y≈x are the same question).
      const pairKey = [s.id, t.id].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const [early, late] = s.startTUs <= t.startTUs ? [s, t] : [t, s];
      const framesX = sliceWindow(frames, early);
      const framesY = sliceWindow(frames, late);
      const framesBetween = frames.filter(
        (f) => f.tUs > early.endTUs && f.tUs < late.startTUs,
      );
      const res = scoreEquivalence(framesX, framesY, framesBetween, excluded);
      for (const c of res.candidates) {
        const locus = fieldLocus(c.id, c.byteIndex, c.width, c.byteOrder);
        addCandidate(merged, locus, c.score, c.rationale, "≈ equivalence");
      }
      questionsRun.push("≈ equivalence");
    }
  }

  // ── Negative control: change-rate over the stable windows. ───────────────────
  const candidates = [...merged.values()];
  for (const c of candidates) {
    c.noiseResponse =
      c.bit !== undefined
        ? bitChangeRate(frames, c.id, c.byteIndex, c.bit, stable)
        : byteChangeRate(frames, c.id, c.byteIndex, stable);
    c.passesControl = c.noiseResponse < cfg.noiseFailRate;
  }

  // Cleared (passed the control) first, then by score.
  candidates.sort(
    (a, b) => (b.passesControl ? 1 : 0) - (a.passesControl ? 1 : 0) || b.score - a.score,
  );

  const note =
    candidates.length === 0
      ? questionsRun.length === 0
        ? "no analyzable spans — assign a type (ramp/level/event) or an ≈ link"
        : "the spans produced no candidate"
      : candidates.some((c) => c.passesControl)
        ? ""
        : "no candidate cleared the stable-window control — the signal may move under normal driving (or not be on this bus)";

  return { candidates, framesAnalyzed: frames.length, questionsRun: dedupe(questionsRun), note };
}

/* ────────────────────────────────────────────────────────────────────────
 * Locus normalization + merge
 * ──────────────────────────────────────────────────────────────────────── */

interface Locus {
  id: number;
  byteIndex: number;
  bit?: number;
  width?: number;
  byteOrder?: ByteOrder;
  key: string;
}

/** Bit locus key (event): `b:<id>:<byte>:<bit>`. */
function bitLocus(id: number, byteIndex: number, bit: number): Locus {
  return { id, byteIndex, bit, key: `b:${id}:${byteIndex}:${bit}` };
}

/** Field locus key (trend/compare/equivalence): `f:<id>:<byte>:<width>:<order>`. */
function fieldLocus(id: number, byteIndex: number, width: number, byteOrder: ByteOrder): Locus {
  return {
    id,
    byteIndex,
    width,
    byteOrder,
    key: `f:${id}:${byteIndex}:${width}:${byteOrder}`,
  };
}

/** Map a runExperiment UnifiedCandidate to a normalized locus (mode-independent). */
function unifiedLocus(c: ReturnType<typeof runExperiment>["candidates"][number]): Locus | null {
  if (c.event) return bitLocus(c.id, c.byteIndex, c.event.bit);
  if (c.trend) return fieldLocus(c.id, c.byteIndex, c.trend.width, c.trend.byteOrder);
  if (c.compare) return fieldLocus(c.id, c.byteIndex, c.compare.width, c.compare.byteOrder);
  if (c.flag) {
    return c.flag.bit !== null
      ? bitLocus(c.id, c.byteIndex, c.flag.bit)
      : fieldLocus(c.id, c.byteIndex, 8, "little");
  }
  return null;
}

/** Insert or strengthen a candidate at `locus` from one question's evidence. */
function addCandidate(
  merged: Map<string, FieldRunCandidate>,
  locus: Locus,
  score: number,
  rationale: string,
  source: string,
): void {
  const clamped = Math.min(1, Math.max(0, score));
  const existing = merged.get(locus.key);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (clamped > existing.score) {
      existing.score = clamped;
      existing.rationale = rationale;
    }
    return;
  }
  merged.set(locus.key, {
    id: locus.id,
    byteIndex: locus.byteIndex,
    bit: locus.bit,
    width: locus.width,
    byteOrder: locus.byteOrder,
    key: locus.key,
    sources: [source],
    score: clamped,
    rationale,
    noiseResponse: 0,
    passesControl: true,
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Negative-control change rates over a set of windows (mirrors logbook.ts)
 * ──────────────────────────────────────────────────────────────────────── */

function inAny(tUs: number, windows: ReadonlyArray<{ startTUs: number; endTUs: number }>): boolean {
  for (const w of windows) if (tUs >= w.startTUs && tUs <= w.endTUs) return true;
  return false;
}

function sliceWindow(
  frames: ReadonlyArray<TimedFrame>,
  w: { startTUs: number; endTUs: number },
): TimedFrame[] {
  return frames.filter((f) => f.tUs >= w.startTUs && f.tUs <= w.endTUs);
}

/** Frames of one id whose tUs falls in any window, time-sorted. */
function sliceId(
  frames: ReadonlyArray<TimedFrame>,
  id: number,
  windows: ReadonlyArray<{ startTUs: number; endTUs: number }>,
): TimedFrame[] {
  return frames.filter((f) => f.id === id && inAny(f.tUs, windows)).sort((a, b) => a.tUs - b.tUs);
}

/** Fraction of consecutive frame-pairs where the byte changed (0 when <2 pairs). */
function byteChangeRate(
  frames: ReadonlyArray<TimedFrame>,
  id: number,
  byteIndex: number,
  windows: ReadonlyArray<{ startTUs: number; endTUs: number }>,
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
  windows: ReadonlyArray<{ startTUs: number; endTUs: number }>,
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

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
