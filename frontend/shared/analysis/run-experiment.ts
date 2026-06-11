// discodb2 — Wizard INTEGRATION GLUE: runExperiment (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → the seam
//     runExperiment(window): RankedCandidate[]
//   with window.marks = { events?: {at, quality}[];                  // event mode
//                         trend?:  {startTUs, endTUs, direction} }   // trend mode
//
// This is the ONE pure function that wires the three analysis bricks together:
//
//   Brick 0 — tagFrames / excludedBytes (tagger.ts): mark the counter/checksum
//             byte slots so the scorers never surface them as fake candidates.
//   Brick 1 — scoreEvents (event-scorer.ts): a bit that flips in phase with a
//             repeated action (handbrake/reverse/ignition).
//   Brick 2 — scoreTrend (trend-scorer.ts): a decoded field that rises/falls
//             monotonically over a marked window (RPM ramp, fuel draining).
//   Brick 2′ — compareStates (trend-scorer.ts): the 2-POINT sub-case — two
//             captured steady states (tank FULL vs LOW) for a signal you can't
//             ramp; rank the fields whose robust LEVEL shifted the most.
//   Brick 3 — scoreFlags (flag-scorer.ts): the FLAG / BYTE-CHANGE case — two
//             captured steady states, but rank the BYTES that took a DIFFERENT
//             (individually stable) value between them, emphasizing changes
//             confined to ≤2 bytes (handbrake on/off, reverse, a small exchange).
//
// It runs the tagger once, merges its exclusions with any the caller supplies,
// dispatches to the matching scorer by which mark is present, and maps the
// scorers' differently-shaped candidates into ONE unified result so a UI (or the
// cockpit seam) reads a single shape regardless of mode.
//
// ── Mode selection / PRECEDENCE (exactly one scorer runs) ─────────────────────
// A run carries exactly one mode of mark, but the marks are independent fields,
// so when more than one is present we pick by SPECIFICITY of the evidence:
//
//     events (non-empty)  >  trend  >  compare  >  flags
//
//   • A NON-EMPTY `events` list is the most specific evidence (discrete, operator-
//     confirmed instants), so it wins over everything. An EMPTY `events` array
//     carries no confirmed instants and must NOT shadow a real trend/compare/flags
//     mark.
//   • `trend` (a continuous ramp with a known direction) outranks `compare`: a
//     monotone sweep is richer than two static snapshots, and the directionality
//     is a stronger discriminator (rise-then-fall, see docs/WIZARD.md).
//   • `compare` (two captured windows over the SAME frames, docs/WIZARD.md
//     "Trend and 2-point are user-driven captures") is the fallback for an ANALOG
//     signal that can't be ramped, ranking by robust LEVEL magnitude.
//   • `flags` (the SAME two-window capture) is last: it answers a DIFFERENT
//     question — which DISCRETE byte(s) flipped, ≤2-byte-confined — so it only
//     runs when no richer mark is present. `compare` and `flags` are sibling
//     reads of two windows; a run carries whichever one the operator's mode chose.
//   • NONE → an empty `"none"` result (the tagger still ran; tags surfaced).
//
// Pure & framework-free (like tagger.ts / event-scorer.ts / trend-scorer.ts /
// protocol.ts): no Svelte/Vite/DOM-only deps, no I/O, no globals; deterministic.
// Runs in the cockpit, a Web Worker, or a plain Node test runner. Mutates none
// of its inputs; allocates fresh output.
//
// ── Cockpit-seam reconciliation (frontend/cockpit/src/hunt/hunt.ts) ───────────
// The cockpit's `runExperiment` seam (DESIGN §9) types the SAME function with a
// DIFFERENT vocabulary; this glue speaks the SHARED scorers' vocabulary. The
// cockpit is intentionally NOT modified — the deltas an eventual adapter at the
// cockpit boundary must reconcile are catalogued here (and exercised by the
// tests) so nothing is silently lost:
//
//   • Event marks. Seam `ExperimentMarks.events: number[]` (bare timestamps);
//     shared `EventMark[] = {at, quality:'good'|'failed'}`. Only GOOD trials feed
//     the scorer (docs/WIZARD.md), so the missing per-mark `quality` is the
//     load-bearing field a bare `number[]` cannot carry — the adapter must attach
//     it (default 'good' for a legacy bare list) when crossing the boundary.
//   • Candidate locus. Seam `bitStart`/`bitLength` (an absolute bit RANGE within
//     the payload) + `byteOrder`; shared event candidates use `byteIndex`+`bit`
//     (a SINGLE bit) and trend candidates use `byteIndex`+`width{8,16}`+`byteOrder`
//     +`signed`. Mapping: event → bitStart = byteIndex*8 + bit, bitLength = 1;
//     trend → bitStart = byteIndex*8, bitLength = width. `signed` has no seam
//     field. We surface byteIndex/bit/width/byteOrder/signed on the unified
//     candidate so the adapter has everything it needs without re-deriving it.
//   • Frame shape. Seam frames are `FrameView` (id, isExtended, data, tUs);
//     shared frames are `TimedFrame` (id, data, tUs) — structurally a subset, so
//     a FrameView[] flows in directly. `isExtended` is dropped by the shared
//     scorers (id alone keys a candidate); an adapter that needs it must thread
//     it back from the original window by id.
//   • Candidate `id`. Seam needs a stable STRING `id` (for UI keys) plus a numeric
//     `frameId`; we expose the numeric CAN id and a deterministic string `key`
//     ("evt:<id>:<byte>:<bit>" / "trnd:<id>:<byte>:<width><BE|LE><u|s>") the
//     adapter can use verbatim as the seam's `id`.
//   • Return shape & signature. The seam (WIZARD.md / DEVELOPERS.md / hunt.ts)
//     types `runExperiment(window): RankedCandidate[]` — a BARE array, one arg.
//     This shared version returns an `ExperimentResult` WRAPPER ({mode,
//     candidates, tags, excludedCount, stats}) and takes an optional 2nd `config`.
//     The adapter maps `result.candidates` to the array and may surface
//     tags/stats/excludedCount out-of-band (e.g. a Hunt status line); it omits config.
//   • Dropped window fields. The seam's `startTUs`/`endTUs`/`candidateIds`/`note`
//     have no shared equivalent: trend bounds come ONLY from `marks.trend`, and
//     the scorers always sweep every id (no `candidateIds` allow-list) — an
//     adapter must pre-filter `frames` by id if a caller restricts ids.
//   • 2-point mode (trend-scorer `compareStates`, FULL-vs-LOW) IS wired here via
//     the `marks.compare` variant (two windows over the SAME `window.frames`,
//     sliced by tUs) and surfaces under a dedicated unified mode `"compare"`
//     with its own evidence block (`delta`/`medianA`/`medianB`). The cockpit seam
//     has no 2-point vocabulary yet: an adapter must add a `bitStart`/`bitLength`
//     locus (= byteIndex*8 / width, same as trend) and decide how to carry the
//     signed `delta`/medians (no seam field today) when crossing the boundary.
//     The string `key` is "cmp:<id>:<byte>:<width><BE|LE><u|s>".
//   • FLAG mode (flag-scorer `scoreFlags`, byte-change) is wired via the
//     `marks.flags` variant — the SAME {a,b} two-window shape as `compare`,
//     sliced by tUs — and surfaces under unified mode `"flag"` with its own
//     evidence block (`bit`/`direction`/`valueA`/`valueB`/`changedBytesForId`).
//     Its locus is per-BIT when one bit flipped (`bitStart = byteIndex*8 + bit`,
//     `bitLength = 1`, like event) and per-BYTE otherwise (`bitStart =
//     byteIndex*8`, `bitLength = 8`, like a width-8 compare field). The string
//     `key` is "flag:<id>:<byte>:b<bit>" for a single-bit flip and
//     "flag:<id>:<byte>:byte" for a whole-byte change.

import {
  scoreEvents,
  type TimedFrame,
  type EventMark,
  type EventScorerConfig,
} from "./event-scorer.ts";
import {
  scoreTrend,
  compareStates,
  type TrendWindow,
  type TrendScorerConfig,
  type FieldWidth,
} from "./trend-scorer.ts";
import {
  scoreFlags,
  type FlagScorerConfig,
} from "./flag-scorer.ts";
import {
  tagFrames,
  excludedBytes,
  type RawFrame,
  type Tag,
  type TaggerConfig,
} from "./tagger.ts";
import type { ByteOrder } from "../protocol.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The operator's annotation of what they did and when, on the same µs clock as
 * the frames. Exactly one mode is expected per run:
 *   • `events`  → EVENT mode (a flag flipping in phase with a repeated action).
 *   • `trend`   → TREND mode (a value ramping over a window).
 *   • `compare` → 2-POINT mode (two captured steady states, FULL vs LOW).
 *   • `flags`   → FLAG mode (two captured states; which DISCRETE byte changed).
 * When more than one is present, precedence is events (non-empty) > trend >
 * compare > flags; see `runExperiment` and the file header. If NONE is present
 * there is nothing to score and the result is empty.
 *
 * Note the shape difference vs the cockpit seam (hunt.ts `ExperimentMarks`),
 * documented at the top of this file: here `events` carries per-trial
 * `quality`, which the scorer requires and a bare `number[]` cannot express.
 */
export interface ExperimentMarks {
  /** EVENT mode: the action instants with per-trial quality (failed = ignored). */
  events?: EventMark[];
  /** TREND mode: a continuous sweep window with an expected monotone direction. */
  trend?: TrendWindow;
  /**
   * 2-POINT mode: two operator-captured steady-state windows over the SAME
   * `window.frames`, each a [startTUs, endTUs] interval on the µs clock. The
   * frames inside `a` form state A, those inside `b` form state B; `compareStates`
   * ranks the fields whose robust median shifted most between them. The two
   * windows MAY be disjoint or (degenerately) overlap — slicing is by `tUs`, and
   * a frame falling in both windows feeds both states. (docs/WIZARD.md: "Trend
   * and 2-point are user-driven captures … one window per capture, two for
   * 2-point".)
   */
  compare?: TwoWindows;
  /**
   * FLAG mode: the SAME two captured steady-state windows as `compare` (sliced
   * from `window.frames` by tUs), but scored by `scoreFlags` for which DISCRETE
   * byte(s) took a different-but-individually-stable value between the states —
   * an on/off flag (handbrake/reverse/ignition) or a small flag exchange, with
   * changes confined to ≤2 bytes emphasized. `compare` ranks by analog LEVEL
   * magnitude; `flags` ranks by clean discrete separation. A run uses whichever
   * of the two the operator's chosen mode supplied; if both are present
   * `compare` wins (see the precedence in the file header).
   */
  flags?: TwoWindows;
}

/** Two operator-captured steady-state windows on the µs clock (A then B). */
export interface TwoWindows {
  /** State A capture window (e.g. tank FULL / handbrake OFF), µs, ends inclusive. */
  a: { startTUs: number; endTUs: number };
  /** State B capture window (e.g. tank LOW / handbrake ON), µs, ends inclusive. */
  b: { startTUs: number; endTUs: number };
}

/**
 * The analysis input: a slice of raw timed history plus the operator's marks and
 * any externally-known exclusions. Bounding the frame window is the caller's job
 * (as in the cockpit's Hunt panel); the scorers see only what they're handed.
 */
export interface ExperimentWindow {
  /** Raw timed frames (any ids interleaved); the scorers re-sort internally. */
  frames: TimedFrame[];
  /** Operator annotations of the stimulus — selects the mode. */
  marks: ExperimentMarks;
  /**
   * Extra byte slots to exclude, keyed `"id:byteIndex"` (decimal), MERGED with
   * the tagger's own exclusions. Lets a caller pin slots it already knows are
   * noise (e.g. a previously identified counter/checksum) without re-deriving.
   */
  excluded?: Set<string>;
}

/**
 * Optional per-brick overrides, forwarded verbatim. Omit a section to take that
 * brick's defaults (TAGGER_DEFAULTS / EVENT_SCORER_DEFAULTS / TREND_SCORER_DEFAULTS,
 * which themselves draw the cross-Wizard knobs from WIZARD_DEFAULTS).
 */
export interface RunExperimentConfig {
  tagger?: Partial<TaggerConfig>;
  event?: Partial<EventScorerConfig>;
  trend?: Partial<TrendScorerConfig>;
  flag?: Partial<FlagScorerConfig>;
}

/**
 * ONE unified candidate covering ALL four modes. The common fields (`mode`, CAN
 * `id`, `byteIndex`, `score`, `rationale`, `key`) are always present; the
 * mode-specific evidence is carried in `event?` / `trend?` / `compare?` /
 * `flag?` (exactly one set, matching `mode`). `score` is higher-is-better and
 * only comparable WITHIN one result set — it is the good-trial match fraction
 * for event, |ρ| for trend, the spread-normalized |Δ| for compare, and the
 * ≤2-byte-de-rated separation cleanliness for flag (different scales, same
 * ordering intent).
 *
 * `byteIndex` (+ the mode-specific locus below) and `key` are the bridge to the
 * cockpit seam's `bitStart`/`bitLength`/`byteOrder`/`id`; see the file header.
 */
export interface UnifiedCandidate {
  /** Which scorer produced this candidate. */
  mode: "event" | "trend" | "compare" | "flag";
  /** Numeric CAN id. */
  id: number;
  /** Byte index of the candidate's (first) byte within the payload. */
  byteIndex: number;
  /** Strength, higher = stronger; set-relative, not cross-set comparable. */
  score: number;
  /** Human-readable one-liner straight from the underlying scorer. */
  rationale: string;
  /**
   * Deterministic stable string key for UI selection / the seam's string `id`:
   *   event   → `evt:<id>:<byteIndex>:<bit>`
   *   trend   → `trnd:<id>:<byteIndex>:<width><BE|LE><u|s>`
   *   compare → `cmp:<id>:<byteIndex>:<width><BE|LE><u|s>`
   *   flag    → `flag:<id>:<byteIndex>:b<bit>` (single-bit flip) or
   *             `flag:<id>:<byteIndex>:byte` (whole-byte change)
   */
  key: string;

  /** EVENT mode only — the bit and its in-phase flip. */
  event?: {
    /** Bit within the byte, 0 = LSB .. 7 = MSB. */
    bit: number;
    /** The dominant in-phase flip across the good trials. */
    direction: "0->1" | "1->0";
    /** Per-good-trial (rest, action) bit values that produced the score. */
    evidence: { at: number; rest: 0 | 1 | null; action: 0 | 1 | null }[];
  };

  /** TREND mode only — the decoded field and its monotone evidence. */
  trend?: {
    /** Field width in bits (8 or 16). */
    width: FieldWidth;
    /** Byte order of a 16-bit field ("big"/"little"); "big" for 8-bit. */
    byteOrder: ByteOrder;
    /** Whether decoded as a signed two's-complement integer. */
    signed: boolean;
    /** Sign of the Theil–Sen slope (+1 rising, −1 falling). */
    slopeSign: 1 | -1;
    /** The signed Spearman ρ over the window, −1..1 (`score` is |ρ|). */
    spearman: number;
  };

  /** COMPARE (2-point) mode only — the decoded field and its between-state shift. */
  compare?: {
    /** Field width in bits (8 or 16). */
    width: FieldWidth;
    /** Byte order of a 16-bit field ("big"/"little"); "big" for 8-bit. */
    byteOrder: ByteOrder;
    /** Whether decoded as a signed two's-complement integer. */
    signed: boolean;
    /** Signed change between states: median_A − median_B, raw decoded units. */
    delta: number;
    /** Robust central value (median) in state A, raw decoded units. */
    medianA: number;
    /** Robust central value (median) in state B, raw decoded units. */
    medianB: number;
  };

  /** FLAG (byte-change) mode only — the changed byte, its A/B values and locus. */
  flag?: {
    /** The single flipped bit (0 = LSB .. 7 = MSB), or null for a multi-bit byte change. */
    bit: number | null;
    /** Flip direction A→B when `bit !== null`; null for a multi-bit byte change. */
    direction: "0->1" | "1->0" | null;
    /** Dominant (modal) byte value held across window A. */
    valueA: number;
    /** Dominant (modal) byte value held across window B. */
    valueB: number;
    /** How many byte slots of this id changed cleanly A↔B (≤2 = a flag/exchange). */
    changedBytesForId: number;
  };
}

/**
 * The unified outcome of a run. `mode` echoes which scorer ran (`"none"` when no
 * mark was supplied → empty candidates). The scorer's own corpus counts are
 * passed through under `stats` so a UI can report "N good / M total" (event) or
 * frames/ids in window (trend) without re-deriving them. `excludedCount` is the
 * size of the MERGED exclusion set actually handed to the scorer.
 */
export interface ExperimentResult {
  mode: "event" | "trend" | "compare" | "flag" | "none";
  /** Candidates, already sorted best-first by the underlying scorer. */
  candidates: UnifiedCandidate[];
  /** Tags the run produced (Brick 0 output), for inspection/UI. */
  tags: Map<number, Tag[]>;
  /** Size of the merged (tagger ∪ caller) exclusion set used for scoring. */
  excludedCount: number;
  /** Mode-specific corpus stats, mirroring the underlying scorer's result. */
  stats: EventStats | TrendStats | CompareStats | FlagStats | EmptyStats;
}

/** Event-mode corpus stats (mirrors EventScoreResult's counts). */
export interface EventStats {
  mode: "event";
  /** Good (quality === "good") events actually used. */
  goodEvents: number;
  /** Total events supplied (good + failed). */
  totalEvents: number;
}

/** Trend-mode corpus stats (mirrors TrendScoreResult's counts). */
export interface TrendStats {
  mode: "trend";
  /** Distinct ids with ≥1 frame inside the window. */
  idsInWindow: number;
  /** Total frames inside [startTUs, endTUs]. */
  framesInWindow: number;
}

/** Compare-mode (2-point) corpus stats (mirrors CompareStatesResult's counts). */
export interface CompareStats {
  mode: "compare";
  /** Frames sliced into state A (inside the `a` window). */
  framesA: number;
  /** Frames sliced into state B (inside the `b` window). */
  framesB: number;
}

/** Flag-mode (byte-change) corpus stats (mirrors FlagScoreResult's counts). */
export interface FlagStats {
  mode: "flag";
  /** Frames sliced into state A (inside the `a` window). */
  framesA: number;
  /** Frames sliced into state B (inside the `b` window). */
  framesB: number;
}

/** No-mode stats (no mark supplied). */
export interface EmptyStats {
  mode: "none";
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API — the seam
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Run the Wizard analysis over `window` and return ONE unified result.
 *
 * Steps:
 *   1. Brick 0: tag the frames, derive the excluded byte slots, and MERGE them
 *      with any `window.excluded` the caller supplied.
 *   2. Dispatch by mode, in precedence order: a NON-EMPTY `marks.events` →
 *      scoreEvents; else `marks.trend` → scoreTrend; else `marks.compare` →
 *      compareStates; else `marks.flags` → scoreFlags (the last three each slice
 *      `frames` into states A/B by tUs). (See the file header for why events >
 *      trend > compare > flags. If none, return an empty `"none"` result with the
 *      tags still populated.)
 *   3. Map the chosen scorer's candidates into the unified shape.
 *
 * Pure: mutates none of its inputs; returns fresh output. Deterministic for a
 * given input (the scorers sort their output deterministically).
 */
export function runExperiment(
  window: ExperimentWindow,
  config: RunExperimentConfig = {},
): ExperimentResult {
  const { frames, marks } = window;

  // ── Brick 0: tag once, then merge exclusions. ──────────────────────────────
  // tagFrames wants RawFrame (id/data); a TimedFrame is that plus tUs, so it is
  // a structural superset and flows in directly — we only widen the type.
  const tags = tagFrames(frames as ReadonlyArray<RawFrame>, config.tagger);
  const excluded = mergeExclusions(excludedBytes(tags), window.excluded);

  // ── Brick 1 / Brick 2: dispatch by which mark is present. ──────────────────
  // Events are the more specific evidence (confirmed discrete instants), so a
  // NON-EMPTY events list takes precedence over trend. An empty events array
  // carries no confirmed instants, so it must NOT shadow a real trend mark
  // (nor be treated as event mode when supplied alone).
  if (marks.events && marks.events.length > 0) {
    const res = scoreEvents(frames, marks.events, excluded, config.event);
    return {
      mode: "event",
      candidates: res.candidates.map(toUnifiedEvent),
      tags,
      excludedCount: excluded.size,
      stats: { mode: "event", goodEvents: res.goodEvents, totalEvents: res.totalEvents },
    };
  }

  if (marks.trend) {
    const res = scoreTrend(frames, marks.trend, excluded, config.trend);
    return {
      mode: "trend",
      candidates: res.candidates.map(toUnifiedTrend),
      tags,
      excludedCount: excluded.size,
      stats: { mode: "trend", idsInWindow: res.idsInWindow, framesInWindow: res.framesInWindow },
    };
  }

  // 2-POINT: slice the ONE frame history into the two captured states by tUs,
  // then compare. compareStates reuses the trend brick's knobs (it is the same
  // module / Brick 2), so `config.trend` configures it too.
  if (marks.compare) {
    const a = sliceWindow(frames, marks.compare.a);
    const b = sliceWindow(frames, marks.compare.b);
    const res = compareStates(a, b, excluded, config.trend);
    return {
      mode: "compare",
      candidates: res.candidates.map(toUnifiedCompare),
      tags,
      excludedCount: excluded.size,
      stats: { mode: "compare", framesA: res.framesA, framesB: res.framesB },
    };
  }

  // FLAG (byte-change): the SAME two-window slice as compare, but scored by the
  // flag scorer (Brick 3) for the DISCRETE byte(s) that changed, ≤2-byte-confined.
  if (marks.flags) {
    const a = sliceWindow(frames, marks.flags.a);
    const b = sliceWindow(frames, marks.flags.b);
    const res = scoreFlags(a, b, excluded, config.flag);
    return {
      mode: "flag",
      candidates: res.candidates.map(toUnifiedFlag),
      tags,
      excludedCount: excluded.size,
      stats: { mode: "flag", framesA: res.framesA, framesB: res.framesB },
    };
  }

  // No mark → nothing to score, but the tagger ran, so surface its output.
  return {
    mode: "none",
    candidates: [],
    tags,
    excludedCount: excluded.size,
    stats: { mode: "none" },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Mapping the two scorer shapes into the unified candidate
 * ──────────────────────────────────────────────────────────────────────── */

/** Map an event scorer's RankedCandidate → the unified shape. */
function toUnifiedEvent(c: {
  id: number;
  byteIndex: number;
  bit: number;
  score: number;
  direction: "0->1" | "1->0";
  rationale: string;
  evidence: { at: number; rest: 0 | 1 | null; action: 0 | 1 | null }[];
}): UnifiedCandidate {
  return {
    mode: "event",
    id: c.id,
    byteIndex: c.byteIndex,
    score: c.score,
    rationale: c.rationale,
    key: `evt:${c.id}:${c.byteIndex}:${c.bit}`,
    event: {
      bit: c.bit,
      direction: c.direction,
      // Fresh evidence array (don't alias the scorer's, even though it is fresh).
      evidence: c.evidence.map((e) => ({ at: e.at, rest: e.rest, action: e.action })),
    },
  };
}

/** Map a trend scorer's RankedCandidate → the unified shape. */
function toUnifiedTrend(c: {
  id: number;
  byteIndex: number;
  width: FieldWidth;
  byteOrder: ByteOrder;
  signed: boolean;
  score: number;
  slopeSign?: 1 | -1;
  spearman?: number;
  rationale: string;
}): UnifiedCandidate {
  // scoreTrend always sets slopeSign/spearman on a kept candidate; default
  // defensively so the unified shape's fields are never undefined.
  const slopeSign: 1 | -1 = c.slopeSign ?? (c.spearman !== undefined && c.spearman < 0 ? -1 : 1);
  const spearman = c.spearman ?? 0;
  const order = c.byteOrder === "big" ? "BE" : "LE";
  const sign = c.signed ? "s" : "u";
  return {
    mode: "trend",
    id: c.id,
    byteIndex: c.byteIndex,
    score: c.score,
    rationale: c.rationale,
    key: `trnd:${c.id}:${c.byteIndex}:${c.width}${order}${sign}`,
    trend: {
      width: c.width,
      byteOrder: c.byteOrder,
      signed: c.signed,
      slopeSign,
      spearman,
    },
  };
}

/** Map a compareStates (2-point) RankedCandidate → the unified shape. */
function toUnifiedCompare(c: {
  id: number;
  byteIndex: number;
  width: FieldWidth;
  byteOrder: ByteOrder;
  signed: boolean;
  score: number;
  delta?: number;
  medianA?: number;
  medianB?: number;
  rationale: string;
}): UnifiedCandidate {
  // compareStates always sets delta/medianA/medianB on a kept candidate; default
  // defensively so the unified shape's fields are never undefined (mirrors how
  // toUnifiedTrend guards slopeSign/spearman).
  const medianA = c.medianA ?? 0;
  const medianB = c.medianB ?? 0;
  const delta = c.delta ?? medianA - medianB;
  const order = c.byteOrder === "big" ? "BE" : "LE";
  const sign = c.signed ? "s" : "u";
  return {
    mode: "compare",
    id: c.id,
    byteIndex: c.byteIndex,
    score: c.score,
    rationale: c.rationale,
    key: `cmp:${c.id}:${c.byteIndex}:${c.width}${order}${sign}`,
    compare: {
      width: c.width,
      byteOrder: c.byteOrder,
      signed: c.signed,
      delta,
      medianA,
      medianB,
    },
  };
}

/** Map a scoreFlags (byte-change) RankedCandidate → the unified shape. */
function toUnifiedFlag(c: {
  id: number;
  byteIndex: number;
  bit: number | null;
  score: number;
  valueA: number;
  valueB: number;
  direction: "0->1" | "1->0" | null;
  changedBytesForId: number;
  rationale: string;
}): UnifiedCandidate {
  // A single-bit flip keys per-bit; a whole-byte change keys per-byte. This
  // mirrors the locus the adapter will build (bitStart = byteIndex*8 + bit /
  // bitLength 1, vs byteIndex*8 / bitLength 8) so the key stays in step with it.
  const locus = c.bit !== null ? `b${c.bit}` : "byte";
  return {
    mode: "flag",
    id: c.id,
    byteIndex: c.byteIndex,
    score: c.score,
    rationale: c.rationale,
    key: `flag:${c.id}:${c.byteIndex}:${locus}`,
    flag: {
      bit: c.bit,
      direction: c.direction,
      valueA: c.valueA,
      valueB: c.valueB,
      changedBytesForId: c.changedBytesForId,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 2-point window slicing
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Select the frames whose `tUs` falls inside `[startTUs, endTUs]` (BOTH ends
 * inclusive — same convention as the trend scorer's in-window grouping). Returns
 * a FRESH array of the SAME frame objects (no payload copy: `compareStates`
 * defensively copies internally, and we never mutate). A frame that falls in
 * both of a compare run's windows is simply selected by each call.
 */
function sliceWindow(
  frames: ReadonlyArray<TimedFrame>,
  w: { startTUs: number; endTUs: number },
): TimedFrame[] {
  return frames.filter((f) => f.tUs >= w.startTUs && f.tUs <= w.endTUs);
}

/* ────────────────────────────────────────────────────────────────────────
 * Exclusion merge
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Union the tagger's exclusions with the caller's, into a FRESH set (mutating
 * neither input). Both are keyed `"id:byteIndex"` (decimal). A caller-supplied
 * key the tagger didn't find is honoured verbatim; duplicates collapse.
 */
function mergeExclusions(
  fromTagger: ReadonlySet<string>,
  fromCaller: ReadonlySet<string> | undefined,
): Set<string> {
  const out = new Set<string>(fromTagger);
  if (fromCaller) for (const k of fromCaller) out.add(k);
  return out;
}
