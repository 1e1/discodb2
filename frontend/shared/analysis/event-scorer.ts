// discodb2 — Brick 1: the EVENT SCORER (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Modes → Event" and "Scoring → Event
// scorer". This stands on Brick 0 (the tagger): it is handed the tagger's set
// of excluded byte slots and never scores them, so free-running counters and
// checksums can't surface as fake candidates.
//
// Pure & framework-free (like tagger.ts / protocol.ts): no Svelte/Vite/DOM-only
// deps; runs in the cockpit, a Web Worker, or a plain Node test runner. Mutates
// nothing, allocates fresh output.
//
// What it finds:
//   A bit (id × byte × bit 0..7) that flips IN PHASE with a repeated physical
//   action — handbrake, reverse, ignition. The operator performs the action on
//   an audible cue; we record the instant of each cue (`at`, µs) and whether the
//   trial was clean (`quality`). For each GOOD trial we read the bit's STABLE
//   value just before the cue (REST) and just after the cue, past a latency
//   guard (ACTION). A real event bit changes between the two, the SAME way, on
//   every good trial. Chatter and counters also change at rest / change in
//   random directions, so they self-reject.
//
// Why only good trials (docs/WIZARD.md "Per-trial feedback"): a FAILED trial
// means the operator didn't actually perform the action (or aborted it), so the
// bit legitimately may not flip. Counting failed trials would punish a perfect
// candidate for the operator's miss. The UI reports "N good / M total".

import { WIZARD_DEFAULTS } from "../wizard-config.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw classic-CAN frame in arrival order, stamped with the time it was
 * captured (microseconds, the same clock as the event marks). A timed
 * projection of the tagger's `RawFrame` — same `id`/`data` shape, plus `tUs`.
 * `data` is 0..8 bytes; each entry is a byte 0..255.
 */
export interface TimedFrame {
  id: number;
  data: number[];
  /** Capture timestamp, microseconds (same clock as `EventMark.at`). */
  tUs: number;
}

/** One action instant (a cue the operator reacted to), microseconds. */
export interface EventMark {
  /** Cue instant, microseconds. */
  at: number;
  /** `good` = operator confirmed the action; `failed` = miss/abort (ignored). */
  quality: "good" | "failed";
}

/**
 * The per-trial evidence behind a candidate's score: for one good event, the
 * stable bit value at REST and during the ACTION (each `0`, `1`, or `null` when
 * that segment had no frame of this id to read).
 */
export interface TrialEvidence {
  /** The good event's cue instant, microseconds. */
  at: number;
  /** Stable bit value just before the cue, or null if the segment was empty. */
  rest: 0 | 1 | null;
  /** Stable bit value after the cue (past the guard), or null if empty. */
  action: 0 | 1 | null;
}

/**
 * A scored candidate bit. `score` is the fraction of good trials whose
 * rest→action change matched the candidate's dominant direction. `direction`
 * is that dominant flip (`"0->1"` for a bit that goes high on the action,
 * `"1->0"` for one that goes low).
 */
export interface RankedCandidate {
  id: number;
  /** Byte index within the frame payload. */
  byteIndex: number;
  /** Bit within the byte, 0 = LSB .. 7 = MSB. */
  bit: number;
  /** Fraction of good trials matching the dominant direction, 0..1. */
  score: number;
  /** The dominant in-phase flip. */
  direction: "0->1" | "1->0";
  /** Human-readable one-liner for the UI / logs. */
  rationale: string;
  /** Per-good-trial values that produced the score (rest/action per event). */
  evidence: TrialEvidence[];
}

/** Outcome of a scoring run: the ranked shortlist + how much data backed it. */
export interface EventScoreResult {
  /** Candidates with score ≥ eventConsistency, sorted by score desc. */
  candidates: RankedCandidate[];
  /** Good (quality === "good") events actually used. */
  goodEvents: number;
  /** Total events supplied (good + failed). */
  totalEvents: number;
}

/**
 * Tunable knobs. The two cross-Wizard ones come from `WizardConfig`
 * (cueGuardMs, eventConsistency); the segment widths are event-scorer-local.
 * All defaults below; everything overridable.
 */
export interface EventScorerConfig {
  /**
   * Latency guard after the cue, milliseconds (human + CAN reaction). The
   * ACTION segment starts only after this delay so we read the settled
   * post-action state, not the moment of the cue. From WizardConfig.cueGuardMs.
   */
  cueGuardMs: number;
  /** Min fraction of good trials a bit must match to be kept, 0..1. From WizardConfig.eventConsistency. */
  eventConsistency: number;
  /**
   * ACTION segment width, milliseconds: how long after the guard we sample the
   * post-action state. Wide enough to catch a few frames of any id (a 100 ms id
   * appears ~6× in 600 ms) yet short enough to stay within one action.
   */
  actionWindowMs: number;
  /**
   * REST segment width, milliseconds: how long before the cue we sample the
   * baseline. Mirrors the action window so both segments see comparable
   * evidence.
   */
  restWindowMs: number;
  /**
   * How dominant a bit's value must be WITHIN a segment to count as that
   * segment's stable value, 0..1 (fraction of the segment's frames). A genuine
   * flag holds one value steadily across rest and across action; chatter toggles
   * many times within a segment so neither value dominates → the segment reads
   * `null` and the chatter self-rejects (docs/WIZARD.md: "they also change at
   * rest"). Below this, a segment is "unstable" and yields no read. 1.0 demands
   * a perfectly steady bit (no glitch); the default leaves a little slack for an
   * edge frame caught mid-transition.
   */
  segmentStability: number;
}

export const EVENT_SCORER_DEFAULTS: EventScorerConfig = {
  cueGuardMs: WIZARD_DEFAULTS.cueGuardMs, // 300
  eventConsistency: WIZARD_DEFAULTS.eventConsistency, // 0.8
  actionWindowMs: 600,
  restWindowMs: 600,
  // 0.8: tolerate up to one-in-five frames against the value (an edge frame
  // caught mid-flip), but reject a bit that toggles freely within the segment.
  segmentStability: 0.8,
};

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Score every candidate bit (id × byte × bit) for flipping in phase with the
 * marked action, using ONLY good events, and return the ranked shortlist.
 *
 * @param frames  raw timed frames in arrival order (any ids interleaved).
 * @param events  action instants with per-trial quality; failed are ignored.
 * @param excluded the tagger's excluded slots, keyed `"id:byteIndex"` (decimal);
 *                 every bit of an excluded byte is skipped.
 * @param config  optional overrides (see EventScorerConfig).
 *
 * Pure: mutates none of its inputs; returns fresh output.
 */
export function scoreEvents(
  frames: ReadonlyArray<TimedFrame>,
  events: ReadonlyArray<EventMark>,
  excluded: ReadonlySet<string> = new Set<string>(),
  config: Partial<EventScorerConfig> = {},
): EventScoreResult {
  const cfg: EventScorerConfig = { ...EVENT_SCORER_DEFAULTS, ...config };
  const guardUs = cfg.cueGuardMs * 1000;
  const actionUs = cfg.actionWindowMs * 1000;
  const restUs = cfg.restWindowMs * 1000;

  const goodEvents = events.filter((e) => e.quality === "good");

  // No good trials → nothing to score. Report the counts honestly.
  if (goodEvents.length === 0) {
    return { candidates: [], goodEvents: 0, totalEvents: events.length };
  }

  // Group frames by id once, keeping them time-sorted so segment lookups are a
  // simple scan. (Arrival order is usually already time order, but we don't
  // assume it.)
  const byId = groupByIdSorted(frames);

  // For every (id, byteIndex, bit) candidate, collect the per-good-trial
  // (rest, action) value pair. We discover candidate byte slots from the data:
  // any byte position that ever appears for an id, minus the excluded ones.
  const candidates: RankedCandidate[] = [];

  for (const [id, idFrames] of byId) {
    const width = idFrames.reduce((m, f) => Math.max(m, f.data.length), 0);

    for (let byteIndex = 0; byteIndex < width; byteIndex++) {
      if (excluded.has(`${id}:${byteIndex}`)) continue; // tagger said skip.

      for (let bit = 0; bit < 8; bit++) {
        const cand = scoreCandidate(id, byteIndex, bit, idFrames, goodEvents, {
          guardUs,
          actionUs,
          restUs,
          stability: cfg.segmentStability,
        });
        if (cand && cand.score >= cfg.eventConsistency) candidates.push(cand);
      }
    }
  }

  // Best first; break ties by id/byte/bit so the order is deterministic.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.id - b.id ||
      a.byteIndex - b.byteIndex ||
      a.bit - b.bit,
  );

  return {
    candidates,
    goodEvents: goodEvents.length,
    totalEvents: events.length,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-candidate scoring
 * ──────────────────────────────────────────────────────────────────────── */

interface Windows {
  guardUs: number;
  actionUs: number;
  restUs: number;
  /** Min dominant-value fraction for a segment read to count (see config). */
  stability: number;
}

/**
 * Score one (id, byteIndex, bit) candidate over the good trials.
 *
 * For each good event we read the bit's STABLE value (the mode over the
 * segment's frames, but only if that value is dominant enough — see `stableBit`)
 * at REST `[at - restUs, at)` and during the ACTION
 * `[at + guardUs, at + guardUs + actionUs]`. The guard skips the reaction
 * latency so the action segment reflects the settled post-action state.
 *
 * A trial "votes" only if both segments yielded a STABLE value AND the bit
 * changed (rest !== action) — that vote's direction is `rest->action`. The
 * candidate's dominant direction is whichever flip won the votes; score =
 * matching votes / good trials. Dividing by ALL good trials (not just voting
 * ones) is deliberate: a trial where the bit didn't move, or wasn't stable at
 * rest, is evidence AGAINST an event bit, so it must count in the denominator. A
 * bit that never cleanly flips scores 0 and is dropped — this is how chatter
 * (unstable within a segment → no read) and counters self-reject.
 *
 * Returns null only when the candidate is unscorable (no trial produced a
 * change in either direction) — i.e. there is nothing to keep.
 */
function scoreCandidate(
  id: number,
  byteIndex: number,
  bit: number,
  idFrames: ReadonlyArray<TimedFrame>,
  goodEvents: ReadonlyArray<EventMark>,
  w: Windows,
): RankedCandidate | null {
  const evidence: TrialEvidence[] = [];
  let up = 0; // good trials with a 0->1 flip
  let down = 0; // good trials with a 1->0 flip

  for (const ev of goodEvents) {
    const rest = stableBit(idFrames, byteIndex, bit, ev.at - w.restUs, ev.at, w.stability);
    const action = stableBit(
      idFrames,
      byteIndex,
      bit,
      ev.at + w.guardUs,
      ev.at + w.guardUs + w.actionUs,
      w.stability,
    );
    evidence.push({ at: ev.at, rest, action });

    if (rest === null || action === null || rest === action) continue;
    if (rest === 0 && action === 1) up++;
    else down++; // rest === 1 && action === 0
  }

  // Nothing ever flipped → not an event bit, nothing to rank.
  if (up === 0 && down === 0) return null;

  const dominant: "0->1" | "1->0" = up >= down ? "0->1" : "1->0";
  const matched = up >= down ? up : down;
  const score = matched / goodEvents.length;

  return {
    id,
    byteIndex,
    bit,
    score,
    direction: dominant,
    rationale:
      `id 0x${id.toString(16).toUpperCase()} byte${byteIndex} bit${bit} ` +
      `flips ${dominant} on ${matched}/${goodEvents.length} good trials`,
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Segment reading
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The STABLE value of one bit over the frames of `idFrames` whose `tUs` lies in
 * `[startUs, endUs)`. Returns the dominant value (0 or 1) ONLY if it holds for
 * at least `stability` of the segment's frames; otherwise null. Also null when
 * no frame fell in the window or none was long enough to have the byte.
 *
 * Requiring a dominant value (not just any mode) is the core of self-rejection:
 * a genuine flag sits steady across the whole segment (dominance ≈ 1.0), while
 * chatter toggles many times so neither value dominates → null → no vote. Ties
 * resolve to 1 only when it also clears the threshold (so `stability ≤ 0.5`
 * would, by design, accept a 50/50 toggle — keep the default well above 0.5).
 */
function stableBit(
  idFrames: ReadonlyArray<TimedFrame>,
  byteIndex: number,
  bit: number,
  startUs: number,
  endUs: number,
  stability: number,
): 0 | 1 | null {
  let zeros = 0;
  let ones = 0;
  for (const f of idFrames) {
    if (f.tUs < startUs) continue;
    if (f.tUs >= endUs) break; // idFrames is time-sorted: past the window, stop.
    if (byteIndex >= f.data.length) continue; // frame too short for this byte.
    if (((f.data[byteIndex] >> bit) & 1) === 1) ones++;
    else zeros++;
  }
  const total = zeros + ones;
  if (total === 0) return null; // no evidence in this segment.
  const value: 0 | 1 = ones >= zeros ? 1 : 0;
  const dominant = Math.max(zeros, ones);
  if (dominant / total < stability) return null; // not steady enough → no read.
  return value;
}

/** Group frames by id, each group sorted by ascending `tUs` (stable). */
function groupByIdSorted(
  frames: ReadonlyArray<TimedFrame>,
): Map<number, TimedFrame[]> {
  const byId = new Map<number, TimedFrame[]>();
  for (const f of frames) {
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // Defensive copy clamped to bytes, so readers can index freely.
    group.push({ id: f.id, tUs: f.tUs, data: f.data.map((b) => b & 0xff) });
  }
  for (const group of byId.values()) {
    group.sort((a, b) => a.tUs - b.tUs);
  }
  return byId;
}
