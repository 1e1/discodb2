// discodb2 — Brick 3: the FLAG / BYTE-CHANGE SCORER (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Modes → Flag (byte-change)". Like the
// event/trend/compare scorers this stands on Brick 0 (the tagger): it is handed
// the tagger's set of excluded byte slots and never scores them, so free-running
// counters and checksums can't surface as fake candidates.
//
// Pure & framework-free (like tagger.ts / event-scorer.ts / trend-scorer.ts /
// protocol.ts): no Svelte/Vite/DOM-only deps; runs in the cockpit, a Web Worker,
// or a plain Node test runner. Mutates nothing, allocates fresh output.
//
// What it finds — and how it DIFFERS from compareStates (Brick 2′):
//   compareStates ranks fields by the MAGNITUDE of a robust LEVEL shift (median
//   Δ) — right for an ANALOG signal (tank FULL vs LOW). This scorer is about
//   DISCRETE byte changes: which byte(s) take a DIFFERENT VALUE in B vs A,
//   regardless of magnitude — right for an on/off FLAG (handbrake, reverse,
//   ignition) or a small flag exchange. A +1 change on a clean flag byte and a
//   +200 change on a noisy gauge are NOT comparable by magnitude here; what
//   matters is whether the byte holds ONE value in A and a DIFFERENT one value
//   in B (a clean separation), and that FEW bytes changed at once.
//
// The operator captures two steady-state windows A and B (the SAME Start/Stop
// capture UX as 2-point, two windows in sequence). For each candidate byte slot
// we read its DOMINANT value in each window and how cleanly it holds it:
//   • A byte is a candidate only if it is STABLE within EACH window (its
//     dominant value holds for ≥ flagStability of that window's frames) AND its
//     dominant value DIFFERS between A and B. A byte that chatters within a
//     window (no dominant value) self-rejects, exactly like the event scorer.
//   • ≤2-byte emphasis (docs/WIZARD.md): a real flag/exchange moves ONE or TWO
//     bytes; a whole-payload change is a MODE change, not a flag. We count how
//     many byte slots changed for an id and DE-RATE candidates from ids where
//     many bytes changed at once, so single-byte and pair changes rank highest.
//   • Down to the BIT (like the event scorer's bit locus): when exactly one bit
//     differs between the dominant A and B byte values, we report that single
//     bit (width-1 locus) and its 0->1 / 1->0 direction; otherwise the change
//     spans several bits and we report the whole byte.

// Unlike the event/trend scorers this brick has NO cross-Wizard knob (no cue
// guard, no Spearman floor), so it imports nothing from wizard-config.ts; its
// thresholds are flag-local and live in FLAG_SCORER_DEFAULTS below.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw classic-CAN frame stamped with its capture time (microseconds). The
 * same shape the event/trend scorers consume (`id`/`data` like the tagger's
 * `RawFrame`, plus `tUs`); re-declared here so this module stands alone.
 * `data` is 0..8 bytes; each entry is a byte 0..255.
 */
export interface TimedFrame {
  id: number;
  data: number[];
  /** Capture timestamp, microseconds. */
  tUs: number;
}

/**
 * A scored changed-byte candidate. The byte that changed is `id × byteIndex`;
 * `bit` pinpoints a SINGLE flipped bit (0 = LSB .. 7 = MSB) when exactly one bit
 * differs between the dominant A/B values, else it is `null` (a multi-bit byte
 * change). `score` is in [0,1], higher = a cleaner, more confined flag.
 */
export interface RankedCandidate {
  id: number;
  /** Byte index within the frame payload. */
  byteIndex: number;
  /**
   * The single flipped bit (0..7) when the A↔B change is confined to ONE bit;
   * `null` when several bits of the byte changed (report the whole byte).
   */
  bit: number | null;
  /** Strength in [0,1], higher = cleaner & more confined; set-relative. */
  score: number;
  /** Dominant (modal) byte value held across window A's frames. */
  valueA: number;
  /** Dominant (modal) byte value held across window B's frames. */
  valueB: number;
  /**
   * The flip direction when `bit !== null`: `"0->1"` if the bit is set in B and
   * clear in A, `"1->0"` for the reverse. `null` for a multi-bit byte change.
   */
  direction: "0->1" | "1->0" | null;
  /**
   * How many byte slots of THIS id changed cleanly between A and B (this
   * candidate included). 1 or 2 is a flag/exchange; a high count is a mode
   * change and is de-rated. Surfaced so a UI can explain the ranking.
   */
  changedBytesForId: number;
  /** Human-readable one-liner for the UI / logs. */
  rationale: string;
}

/** Outcome of a `scoreFlags` run: the ranked shortlist + per-state frame counts. */
export interface FlagScoreResult {
  /** Bytes that are a stable-but-different value A↔B, ranked best-first. */
  candidates: RankedCandidate[];
  /** Frames supplied for state A. */
  framesA: number;
  /** Frames supplied for state B. */
  framesB: number;
}

/**
 * Tunable knobs. `flagStability` mirrors the event scorer's `segmentStability`
 * intent (how dominant a byte's value must be WITHIN a window to count as that
 * window's stable value). All defaults below; everything overridable.
 */
export interface FlagScorerConfig {
  /**
   * Min fraction of a window's frames that must hold the byte's dominant value
   * for that value to count as the window's STABLE value, 0..1. A genuine flag
   * holds one value steadily across the whole capture (dominance ≈ 1.0); a byte
   * that toggles within a window has no dominant value → it is not a stable
   * level and self-rejects (mirrors event-scorer `segmentStability`). 1.0 demands
   * a perfectly steady byte; the default leaves a little slack for an edge frame
   * caught mid-transition.
   */
  flagStability: number;
  /**
   * Min frames a byte slot needs inside EACH window before it is scored. Below
   * this there isn't enough evidence that a value is steady; the slot is skipped
   * (not scored 0). Mirrors the trend scorer's `minSamples`.
   */
  minSamples: number;
  /**
   * ≤2-byte emphasis (docs/WIZARD.md): a per-id penalty applied once MORE than
   * this many byte slots of the id changed at once. At or below the threshold
   * (a single byte or a pair) NO penalty is applied; above it the score is
   * divided by `1 + softness·(changed − threshold)`, so a clean flag buried in a
   * whole-payload mode change is pushed down without being dropped outright.
   */
  maxChangedBytes: number;
  /** Strength of the de-rating above `maxChangedBytes` (see above). 0 disables it. */
  manyChangePenalty: number;
}

export const FLAG_SCORER_DEFAULTS: FlagScorerConfig = {
  // 0.8: tolerate up to one-in-five frames against the value (an edge frame
  // caught mid-flip), but reject a byte that toggles freely within a window —
  // the same slack the event scorer's segmentStability uses.
  flagStability: 0.8,
  // 8 samples per window ≈ a handful of frames of a 100 ms id over a ~1 s hold;
  // below this a "dominant value" is too easy to hit by chance. Matches the
  // trend scorer's floor so the two user-driven captures behave alike.
  minSamples: 8,
  // 2: a flag or a small flag exchange moves ONE or TWO bytes; beyond two
  // changed bytes the operator captured a mode change, not a flag.
  maxChangedBytes: 2,
  // 0.75: a 3-byte change is ÷1.75, a 4-byte ÷2.5, … — a steep-enough slope that
  // a genuine ≤2-byte flag always out-ranks a many-byte change, while a lone
  // clean flag inside a noisy mode change can still appear lower in the list.
  manyChangePenalty: 0.75,
};

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Compare two captured steady states and rank the BYTES that took a different
 * (but individually stable) value between them — the flag / small-exchange case.
 *
 * For each id present in BOTH states, for each non-excluded byte slot, we read
 * the byte's dominant value and dominance fraction in each window. A slot is a
 * candidate iff it is a stable level in BOTH windows (dominance ≥ flagStability,
 * with ≥ minSamples frames each) AND its dominant value differs A↔B. We then
 * count, per id, how many slots changed and de-rate candidates from ids where
 * many bytes changed at once (≤2-byte emphasis). When the change is confined to
 * a single bit we narrow the locus to that bit.
 *
 * @param framesA  raw frames captured in state A (order irrelevant).
 * @param framesB  raw frames captured in state B.
 * @param excluded tagger exclusions, keyed `"id:byteIndex"` (decimal); every
 *                 excluded byte slot is skipped (never proposed as a flag).
 * @param config   optional overrides (see FlagScorerConfig).
 *
 * Pure: mutates none of its inputs; returns fresh output.
 */
export function scoreFlags(
  framesA: ReadonlyArray<TimedFrame>,
  framesB: ReadonlyArray<TimedFrame>,
  excluded: ReadonlySet<string> = new Set<string>(),
  config: Partial<FlagScorerConfig> = {},
): FlagScoreResult {
  const cfg: FlagScorerConfig = { ...FLAG_SCORER_DEFAULTS, ...config };

  const byIdA = groupById(framesA);
  const byIdB = groupById(framesB);

  // PASS 1 — collect every clean changed-byte slot (stable in both windows,
  // different value), WITHOUT its final score: we first need the per-id changed-
  // byte COUNT (PASS 2 applies the ≤2-byte de-rating from it).
  interface RawHit {
    id: number;
    byteIndex: number;
    valueA: number;
    valueB: number;
    /** Min of the two windows' dominance fractions (the cleaner-separation base). */
    cleanliness: number;
  }
  const hits: RawHit[] = [];
  const changedPerId = new Map<number, number>();

  for (const [id, idFramesA] of byIdA) {
    const idFramesB = byIdB.get(id);
    if (idFramesB === undefined) continue; // id absent from one state → can't compare.

    const width = Math.min(maxWidth(idFramesA), maxWidth(idFramesB));
    for (let byteIndex = 0; byteIndex < width; byteIndex++) {
      if (excluded.has(`${id}:${byteIndex}`)) continue; // tagger said skip.

      const a = dominantByte(idFramesA, byteIndex, cfg);
      const b = dominantByte(idFramesB, byteIndex, cfg);
      // Both windows must yield a STABLE dominant value, and it must DIFFER.
      if (a === null || b === null) continue;
      if (a.value === b.value) continue;

      hits.push({
        id,
        byteIndex,
        valueA: a.value,
        valueB: b.value,
        // The cleaner of the two separations is bounded by the weaker window:
        // a flag that is rock-steady in A but jittery in B is only as clean as B.
        cleanliness: Math.min(a.dominance, b.dominance),
      });
      changedPerId.set(id, (changedPerId.get(id) ?? 0) + 1);
    }
  }

  // PASS 2 — turn each hit into a scored candidate, applying the ≤2-byte
  // emphasis from the per-id changed count, and narrowing to a single bit when
  // exactly one bit flipped.
  const candidates: RankedCandidate[] = hits.map((h) => {
    const changed = changedPerId.get(h.id) ?? 1;
    const penalty = manyChangeDivisor(changed, cfg);
    const score = h.cleanliness / penalty;

    const { bit, direction } = singleBitFlip(h.valueA, h.valueB);

    return {
      id: h.id,
      byteIndex: h.byteIndex,
      bit,
      score,
      valueA: h.valueA,
      valueB: h.valueB,
      direction,
      changedBytesForId: changed,
      rationale: describeHit(h.id, h.byteIndex, h.valueA, h.valueB, bit, direction, changed),
    };
  });

  sortByScore(candidates);
  return { candidates, framesA: framesA.length, framesB: framesB.length };
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-byte dominant value (stability) reading
 * ──────────────────────────────────────────────────────────────────────── */

interface Dominant {
  /** The modal byte value over the window. */
  value: number;
  /** Fraction of the window's frames equal to `value`, 0..1. */
  dominance: number;
}

/**
 * The STABLE value of byte `byteIndex` over a window's frames: the most common
 * value (mode) AND the fraction of frames holding it, but only if that fraction
 * reaches `flagStability` AND there were at least `minSamples` frames with the
 * byte. Returns null otherwise (too little evidence, or no value dominates → the
 * byte chatters within the window and is not a stable level).
 *
 * Requiring a dominant value (not just any mode) is the core of self-rejection,
 * exactly as in the event scorer's `stableBit`: a genuine flag sits steady
 * across the whole window (dominance ≈ 1.0), while a counter/chatter byte sweeps
 * many values so none dominates → null → not a candidate.
 */
function dominantByte(
  idFrames: ReadonlyArray<TimedFrame>,
  byteIndex: number,
  cfg: FlagScorerConfig,
): Dominant | null {
  const counts = new Map<number, number>();
  let total = 0;
  for (const f of idFrames) {
    if (byteIndex >= f.data.length) continue; // frame too short for this byte.
    const v = f.data[byteIndex] & 0xff;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    total++;
  }
  if (total < cfg.minSamples) return null; // not enough evidence for "steady".

  let value = 0;
  let best = 0;
  for (const [v, c] of counts) {
    // Highest count wins; break ties toward the smaller value so the read is
    // deterministic regardless of Map iteration order.
    if (c > best || (c === best && v < value)) {
      best = c;
      value = v;
    }
  }
  const dominance = best / total;
  if (dominance < cfg.flagStability) return null; // chatters → not a stable level.
  return { value, dominance };
}

/* ────────────────────────────────────────────────────────────────────────
 * Single-bit locus & ≤2-byte de-rating
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * If the two byte values differ in EXACTLY one bit, return that bit (0 = LSB)
 * and its flip direction A→B (`"0->1"` when the bit is set in B and clear in A,
 * else `"1->0"`). Otherwise (≥2 bits differ) return `{bit: null, direction:
 * null}` so the caller reports the whole byte. Mirrors the event scorer's
 * single-bit locus on a discrete A↔B change rather than rest→action.
 */
function singleBitFlip(
  valueA: number,
  valueB: number,
): { bit: number | null; direction: "0->1" | "1->0" | null } {
  const x = (valueA ^ valueB) & 0xff;
  // popcount === 1 ⟺ x is a power of two ⟺ (x & (x-1)) === 0 (and x ≠ 0; we only
  // reach here on a real difference, so x ≠ 0 holds, but guard anyway).
  if (x === 0 || (x & (x - 1)) !== 0) return { bit: null, direction: null };
  let bit = 0;
  let v = x;
  while ((v & 1) === 0) {
    v >>= 1;
    bit++;
  }
  const direction: "0->1" | "1->0" = (valueB >> bit) & 1 ? "0->1" : "1->0";
  return { bit, direction };
}

/**
 * The ≤2-byte de-rating divisor for an id whose `changed` byte slots moved at
 * once: 1 (no penalty) at or below `maxChangedBytes`, then growing linearly as
 * `1 + manyChangePenalty·(changed − maxChangedBytes)`. Dividing the cleanliness
 * by this pushes whole-payload mode changes below genuine single-byte / pair
 * flags without discarding them (a lone clean flag inside a noisy change can
 * still surface lower down). `manyChangePenalty = 0` disables the de-rating.
 */
function manyChangeDivisor(changed: number, cfg: FlagScorerConfig): number {
  if (changed <= cfg.maxChangedBytes) return 1;
  return 1 + cfg.manyChangePenalty * (changed - cfg.maxChangedBytes);
}

/* ────────────────────────────────────────────────────────────────────────
 * Misc helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Compose a candidate's human-readable rationale. */
function describeHit(
  id: number,
  byteIndex: number,
  valueA: number,
  valueB: number,
  bit: number | null,
  direction: "0->1" | "1->0" | null,
  changed: number,
): string {
  const idHex = `0x${id.toString(16).toUpperCase()}`;
  const aHex = `0x${valueA.toString(16).toUpperCase().padStart(2, "0")}`;
  const bHex = `0x${valueB.toString(16).toUpperCase().padStart(2, "0")}`;
  const locus = bit !== null ? `byte${byteIndex} bit${bit} flips ${direction}` : `byte${byteIndex} ${aHex}→${bHex}`;
  const confined =
    changed === 1 ? "single changed byte" : changed === 2 ? "1 of a 2-byte change" : `1 of a ${changed}-byte change`;
  return `id ${idHex} ${locus} A↔B (${confined})`;
}

/** Max payload width seen across an id's frames. */
function maxWidth(idFrames: ReadonlyArray<TimedFrame>): number {
  return idFrames.reduce((m, f) => Math.max(m, f.data.length), 0);
}

/** Group frames by id (no time filter); a defensive byte copy keeps inputs pure. */
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

/**
 * Sort candidates best-first, breaking ties deterministically by field identity
 * (id, then byteIndex, then a definite bit before a whole-byte change, then bit
 * index) so the same input always yields the same order.
 */
function sortByScore(candidates: RankedCandidate[]): void {
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.id - b.id ||
      a.byteIndex - b.byteIndex ||
      bitRank(a.bit) - bitRank(b.bit),
  );
}

/** A whole-byte change (bit === null) sorts AFTER any specific bit. */
function bitRank(bit: number | null): number {
  return bit === null ? 8 : bit;
}
