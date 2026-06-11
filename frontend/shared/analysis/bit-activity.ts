// discodb2 — PASSIVE analyzer: the BIT-ACTIVITY HEATMAP (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → passive scan analyzers (the Hunt "Scan"
// sub-view). Unlike the GUIDED scorers (event / trend / 2-point / flag), this
// analyzer takes NO operator action: it scans the capture buffer and surfaces
// structure automatically. It answers "which bits MOVE, and which sit still?"
//
// For each id, for each bit index (0..maxBits-1, up to 8 bytes = 64 bits), it
// counts how often that bit CHANGED between consecutive frames of THAT id, and
// reports the TOGGLE FREQUENCY = transitions / (frames - 1). A constant bit
// scores 0 (dim); a bit that flips every frame scores ~1.0 (bright). This is the
// AGGREGATE, time-summarized version of the per-frame live BitGrid
// (cockpit src/components/BitGrid.svelte).
//
// Pure & framework-free (like tagger.ts / protocol.ts): no Svelte/Vite/DOM-only
// deps; runs in the cockpit, a Web Worker, or a plain Node test runner. Mutates
// nothing, allocates fresh output.
//
// Bit numbering matches the rest of the analysis stack: GLOBAL bit index =
// byteIndex * 8 + bitInByte, with bitInByte 0 = the byte's LSB. (The cockpit's
// BitGrid draws the MSB on the left for human reading; that's a render choice,
// not a numbering one. Heatmap consumers map index → row/col as they see fit.)

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the scan, in arrival order, on the backend µs clock. `data`
 * is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. Same thin shape
 * the tagger's RawFrame uses, plus the timestamp the windowing needs upstream
 * (the analyzer itself does not look at tUs — the caller has already sliced the
 * window — but accepting it keeps the cockpit seam a trivial pass-through).
 */
export interface ScanFrame {
  id: number;
  tUs: number;
  /**
   * The payload bytes. Accepts the ring's `Uint8Array` (zero-copy — already
   * byte-clamped) or a plain `number[]` (a decoder/test, defensively clamped).
   */
  data: ArrayLike<number>;
}

/** Tunable thresholds. Kept local & overridable; sane defaults below. */
export interface BitActivityConfig {
  /**
   * Max bit columns to analyze, i.e. 8 bytes × 8 bits. Classic CAN is ≤8 bytes,
   * so 64 is the natural cap; kept configurable for CAN-FD experiments later.
   */
  maxBits: number;
  /**
   * An id needs at least this many frames before its activity is trusted. With
   * fewer than 2 frames there are zero transitions, so nothing can be measured;
   * a small floor also stops a single stray frame from dominating the view.
   */
  minFrames: number;
}

export const BIT_ACTIVITY_DEFAULTS: BitActivityConfig = {
  maxBits: 64, // 8 bytes
  minFrames: 2, // need ≥1 transition to measure anything
};

/**
 * The activity profile for ONE id over the scanned window.
 *
 *   • `frames`       — how many frames of this id were in the window.
 *   • `transitions`  — per global-bit count of consecutive changes (length =
 *                      maxBits). A bit only present on SOME frames (short DLC)
 *                      counts a transition only across pairs where BOTH frames
 *                      carry the bit (see the short-DLC note below).
 *   • `pairs`        — per global-bit number of consecutive frame PAIRS where
 *                      both frames carried the bit (the denominator for that
 *                      bit's activity). Usually frames-1, but smaller for bits
 *                      that come and go with the DLC.
 *   • `activity`     — transitions / pairs, in [0,1], 0 when pairs is 0.
 *   • `constant`     — true where the bit never changed across its pairs (and
 *                      had ≥1 pair to judge): the "dim, ignore me" bits.
 *   • `maxByte`      — the widest payload (in bytes) seen for this id, so a
 *                      consumer can grey out columns this id never carries.
 */
export interface IdBitActivity {
  id: number;
  frames: number;
  maxByte: number;
  transitions: number[];
  pairs: number[];
  activity: number[];
  constant: boolean[];
}

/** The whole-scan result: one profile per id, plus run-wide totals. */
export interface BitActivityResult {
  /** Per-id profiles, sorted by descending peak activity (busiest id first). */
  ids: IdBitActivity[];
  /** Total frames actually analyzed (after the optional allow-list / minFrames). */
  framesAnalyzed: number;
  /** Number of distinct ids in {@link ids}. */
  idCount: number;
  /** The maxBits the scan ran with (so the UI can size its grid). */
  maxBits: number;
}

import { byteAt, payloadLen, groupByIdPacked, type PackedFrames } from "./packed.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the bit-activity heatmap over a window of frames.
 *
 * Groups `frames` by id internally (arrival order is preserved within each id —
 * that order is what transition counting needs). Ids with fewer than
 * `minFrames` frames are dropped (nothing measurable). The remaining profiles
 * are sorted busiest-first so the operator sees the active ids at the top.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames  the windowed scan frames (the caller slices the ring window).
 * @param allowIds optional id allow-list; empty/undefined = all ids.
 * @param config  optional threshold overrides.
 */
export function bitActivity(
  frames: ReadonlyArray<ScanFrame>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<BitActivityConfig> = {},
): BitActivityResult {
  const cfg: BitActivityConfig = { ...BIT_ACTIVITY_DEFAULTS, ...config };
  const allow =
    allowIds && allowIds.length > 0 ? new Set(allowIds) : null;

  // Group payloads by id, preserving arrival order (the transition basis).
  const byId = new Map<number, ArrayLike<number>[]>();
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // A Uint8Array (the ring's payload) is already byte-clamped and indexable →
    // keep it as-is (zero-copy). A plain number[] (a decoder/test) may carry an
    // out-of-range value, so defensively copy+clamp only that case.
    group.push(f.data instanceof Uint8Array ? f.data : Array.from(f.data, (b) => b & 0xff));
  }

  const ids: IdBitActivity[] = [];
  let framesAnalyzed = 0;
  for (const [id, group] of byId) {
    if (group.length < cfg.minFrames) continue;
    const profile = profileOneId(id, group, cfg.maxBits);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  // Busiest id first (see compareBusiest).
  ids.sort(compareBusiest);

  return {
    ids,
    framesAnalyzed,
    idCount: ids.length,
    maxBits: cfg.maxBits,
  };
}

/**
 * Packed-window variant of {@link bitActivity} (DESIGN §6.1.4 step 3b). Same
 * output, but reads a columnar {@link PackedFrames} via index lists + byteAt — no
 * per-frame payload objects. Used by the synchronous worker Hunt scans; the
 * frame-based {@link bitActivity} stays for the pure Node tests / arbitrary-width
 * callers. An equivalence test pins packed ≡ frame, bit-identical.
 */
export function bitActivityPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<BitActivityConfig> = {},
): BitActivityResult {
  const cfg: BitActivityConfig = { ...BIT_ACTIVITY_DEFAULTS, ...config };
  const byId = groupByIdPacked(p, allowIds);

  const ids: IdBitActivity[] = [];
  let framesAnalyzed = 0;
  for (const [id, indices] of byId) {
    if (indices.length < cfg.minFrames) continue;
    const profile = profileOneIdPacked(id, p, indices, cfg.maxBits);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  ids.sort(compareBusiest);
  return { ids, framesAnalyzed, idCount: ids.length, maxBits: cfg.maxBits };
}

/**
 * Busiest id first: sort by the id's PEAK bit activity, then by frame count (more
 * evidence wins ties), then by id (stable, deterministic). Shared by both paths.
 */
function compareBusiest(a: IdBitActivity, b: IdBitActivity): number {
  const pa = peak(a.activity);
  const pb = peak(b.activity);
  if (pb !== pa) return pb - pa;
  if (b.frames !== a.frames) return b.frames - a.frames;
  return a.id - b.id;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id profiling
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Count per-bit transitions across the ordered payloads of one id.
 *
 * SHORT-DLC handling: frames of one id can legally differ in length. A bit is
 * only judged across a consecutive PAIR where BOTH frames carry the byte that
 * holds it; pairs where either side is too short are skipped for that bit (a
 * missing byte is not a 0 sample). So a bit present on only some frames is
 * handled without crashing and without inventing fake transitions.
 */
function profileOneId(id: number, payloads: ArrayLike<number>[], maxBits: number): IdBitActivity {
  const transitions = new Array<number>(maxBits).fill(0);
  const pairs = new Array<number>(maxBits).fill(0);
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;

  for (let n = 1; n < payloads.length; n++) {
    const prev = payloads[n - 1];
    const cur = payloads[n];
    // Only bits whose byte exists in BOTH frames of this pair are comparable.
    const commonBytes = Math.min(prev.length, cur.length, maxBits >> 3);
    const bitCeil = Math.min(maxBits, commonBytes * 8);
    for (let bit = 0; bit < bitCeil; bit++) {
      const byteIndex = bit >> 3;
      const bitInByte = bit & 7;
      pairs[bit]++;
      const a = (prev[byteIndex] >> bitInByte) & 1;
      const b = (cur[byteIndex] >> bitInByte) & 1;
      if (a !== b) transitions[bit]++;
    }
  }

  const activity = new Array<number>(maxBits).fill(0);
  const constant = new Array<boolean>(maxBits).fill(false);
  for (let bit = 0; bit < maxBits; bit++) {
    activity[bit] = pairs[bit] > 0 ? transitions[bit] / pairs[bit] : 0;
    // "Constant" only means something once we have evidence (≥1 pair) for the
    // bit; a bit we never got to compare is left false (unknown, not constant).
    constant[bit] = pairs[bit] > 0 && transitions[bit] === 0;
  }

  return {
    id,
    frames: payloads.length,
    maxByte,
    transitions,
    pairs,
    activity,
    constant,
  };
}

/**
 * Packed twin of {@link profileOneId}: identical transition/pair tally, but reads
 * each pair's bytes via byteAt over an index list instead of payload arrays.
 * Short-DLC pairing is preserved via payloadLen (a bit counts only across pairs
 * where both frames carry its byte).
 */
function profileOneIdPacked(id: number, p: PackedFrames, indices: number[], maxBits: number): IdBitActivity {
  const transitions = new Array<number>(maxBits).fill(0);
  const pairs = new Array<number>(maxBits).fill(0);
  let maxByte = 0;
  for (const i of indices) {
    const len = payloadLen(p, i);
    if (len > maxByte) maxByte = len;
  }

  for (let n = 1; n < indices.length; n++) {
    const prev = indices[n - 1];
    const cur = indices[n];
    const commonBytes = Math.min(payloadLen(p, prev), payloadLen(p, cur), maxBits >> 3);
    const bitCeil = Math.min(maxBits, commonBytes * 8);
    for (let bit = 0; bit < bitCeil; bit++) {
      const byteIndex = bit >> 3;
      const bitInByte = bit & 7;
      pairs[bit]++;
      const a = (byteAt(p, prev, byteIndex) >> bitInByte) & 1;
      const b = (byteAt(p, cur, byteIndex) >> bitInByte) & 1;
      if (a !== b) transitions[bit]++;
    }
  }

  const activity = new Array<number>(maxBits).fill(0);
  const constant = new Array<boolean>(maxBits).fill(false);
  for (let bit = 0; bit < maxBits; bit++) {
    activity[bit] = pairs[bit] > 0 ? transitions[bit] / pairs[bit] : 0;
    constant[bit] = pairs[bit] > 0 && transitions[bit] === 0;
  }

  return { id, frames: indices.length, maxByte, transitions, pairs, activity, constant };
}

/** The maximum value in an array (0 for an empty array). */
function peak(xs: number[]): number {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
}
