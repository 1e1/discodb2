// discodb2 — PASSIVE analyzer: AUTO-SEGMENTATION of fixed-layout payloads
// (frontend/shared/analysis).
//
// SOURCE OF TRUTH: the decoding-strategy step back (project memory "CAN
// multiplexor & decoding reality") — most real automotive broadcast frames are
// FIXED-LAYOUT (not multiplexed), so the core RE need is to find WHERE the fields
// are. This analyzer infers field BOUNDARIES (which adjacent bytes form one
// multi-byte signal) and the likely byte ORDER, automatically, from passive
// traffic — the missing piece the audit flagged. It feeds signal discovery and
// (later) the hunt log: a proposed segment becomes a one-click "hypothesis".
//
// PRINCIPLE: a multi-byte integer/analog signal has a MONOTONIC ACTIVITY GRADIENT
// across its bytes — the least-significant byte changes most often, each
// more-significant byte changes strictly less (it only moves when the lower bytes
// carry/overflow into it). So:
//   • a run of adjacent active bytes whose change-frequency DECREASES left→right
//     is a LITTLE-endian field (LSB first);
//   • an INCREASING run is BIG-endian (MSB first);
//   • two adjacent bytes with ~equal activity are NOT merged — they are
//     independent signals (a real MSB changes markedly less than its LSB; the
//     `mergeRatio` guard enforces that margin).
// CONSTANT bytes (no activity) and COUNTER/CHECKSUM bytes (tagger) are excluded —
// they break runs and are never part of a value field.
//
// Pure & framework-free: no Svelte/Vite/DOM deps; runs in the cockpit, a Web
// Worker, or a Node test runner. Mutates nothing, allocates fresh output.
//
// SHORT-DLC handling matches the stack: a byte is judged only on the frames that
// carry it; a missing byte is not a value-0 sample.

import { tagFrames, excludedBytes } from './tagger.ts';

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

export type ByteOrder = 'little' | 'big' | 'unknown';

/** One frame for the scan: id + 0..8 raw bytes (same shape as the other analyzers). */
export interface SegmentFrame {
  id: number;
  tUs: number;
  data: number[];
}

export interface AutoSegmentConfig {
  /** Max byte slots to consider (classic CAN = 8). */
  maxBytes: number;
  /** An id needs at least this many frames before segmentation is trusted. */
  minFrames: number;
  /**
   * A byte counts as ACTIVE (segmentable) only above this change-frequency
   * (transitions / pairs). At or below it the byte is treated as constant and
   * breaks a run. Small but non-zero so a single stray flip doesn't start a field.
   */
  minActivity: number;
  /**
   * Merge a more-significant byte into a field only when its activity is at most
   * this fraction of the adjacent less-significant byte's — i.e. it changes
   * MARKEDLY less, as a real high byte must. Two ~equal-activity bytes (ratio
   * above this) are kept as separate signals.
   */
  mergeRatio: number;
}

export const AUTO_SEGMENT_DEFAULTS: AutoSegmentConfig = {
  maxBytes: 8,
  minFrames: 8,
  minActivity: 0.02,
  mergeRatio: 0.7,
};

/**
 * One inferred field of an id.
 *   • `startByte`/`length` — the contiguous byte span (length 1 = a lone byte).
 *   • `byteOrder` — 'little' (activity ↓ across the span), 'big' (↑), or
 *     'unknown' (a single byte: width/order undetermined).
 *   • `activities` — per-byte change-frequency over the span (LSB→MSB reads as
 *     the gradient that justified the merge).
 *   • `confidence` — 0..1: how pronounced the monotonic gradient is (1 = each
 *     step a clean drop; lower = shallower). A lone byte gets a neutral 0.5.
 */
export interface Segment {
  startByte: number;
  length: number;
  byteOrder: ByteOrder;
  activities: number[];
  confidence: number;
}

/** The segmentation of one id over the scanned window. */
export interface IdSegmentation {
  id: number;
  frames: number;
  maxByte: number;
  /** Fields covering the ACTIVE bytes; constant/counter bytes leave gaps. */
  segments: Segment[];
}

export interface AutoSegmentResult {
  /** Per-id segmentations, most-segmented id first. */
  ids: IdSegmentation[];
  framesAnalyzed: number;
  idCount: number;
  maxBytes: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Infer field segments for each id over a window of frames.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames   the windowed scan frames (the caller slices the ring window).
 * @param allowIds optional id allow-list; empty/undefined = all ids.
 * @param config   optional threshold overrides.
 */
export function autoSegment(
  frames: ReadonlyArray<SegmentFrame>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<AutoSegmentConfig> = {},
): AutoSegmentResult {
  const cfg: AutoSegmentConfig = { ...AUTO_SEGMENT_DEFAULTS, ...config };
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;

  // Counter/checksum byte slots ("id:byteIndex") — never part of a value field.
  const excluded = excludedBytes(tagFrames(frames.map((f) => ({ id: f.id, data: f.data }))));

  // Group payloads by id, preserving arrival order (transition counting needs it).
  const byId = new Map<number, number[][]>();
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let g = byId.get(f.id);
    if (g === undefined) {
      g = [];
      byId.set(f.id, g);
    }
    g.push(f.data.map((b) => b & 0xff));
  }

  const ids: IdSegmentation[] = [];
  let framesAnalyzed = 0;
  for (const [id, payloads] of byId) {
    if (payloads.length < cfg.minFrames) continue;
    const seg = segmentOneId(id, payloads, cfg, excluded);
    ids.push(seg);
    framesAnalyzed += seg.frames;
  }

  // Most-segmented id first (richest structure), then more frames, then id.
  ids.sort((a, b) => {
    if (b.segments.length !== a.segments.length) return b.segments.length - a.segments.length;
    if (b.frames !== a.frames) return b.frames - a.frames;
    return a.id - b.id;
  });

  return { ids, framesAnalyzed, idCount: ids.length, maxBytes: cfg.maxBytes };
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id segmentation
 * ──────────────────────────────────────────────────────────────────────── */

function segmentOneId(
  id: number,
  payloads: number[][],
  cfg: AutoSegmentConfig,
  excluded: ReadonlySet<string>,
): IdSegmentation {
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;
  const byteCount = Math.min(maxByte, cfg.maxBytes);

  // Per-byte change frequency over consecutive frames that BOTH carry the byte.
  const activity = new Array<number>(byteCount).fill(0);
  for (let j = 0; j < byteCount; j++) {
    let pairs = 0;
    let changes = 0;
    for (let i = 1; i < payloads.length; i++) {
      const prev = payloads[i - 1];
      const cur = payloads[i];
      if (j >= prev.length || j >= cur.length) continue;
      pairs += 1;
      if (prev[j] !== cur[j]) changes += 1;
    }
    activity[j] = pairs > 0 ? changes / pairs : 0;
  }

  // A byte is segmentable if it actually moves and is not a counter/checksum.
  const active = (j: number): boolean =>
    activity[j] >= cfg.minActivity && !excluded.has(`${id}:${j}`);

  const segments: Segment[] = [];
  let j = 0;
  while (j < byteCount) {
    if (!active(j)) {
      j += 1;
      continue;
    }
    // Greedily extend a field across adjacent active bytes that keep a single
    // monotonic direction with the mergeRatio margin.
    const start = j;
    let dir: 'little' | 'big' | null = null; // little = ↓ activity, big = ↑
    let k = j;
    while (k + 1 < byteCount && active(k + 1)) {
      const a = activity[k];
      const b = activity[k + 1];
      const stepDir = b <= a * cfg.mergeRatio ? 'little' : a <= b * cfg.mergeRatio ? 'big' : null;
      if (stepDir === null) break; // ~equal activity → independent signals.
      if (dir === null) dir = stepDir;
      else if (dir !== stepDir) break; // trend reversed → field ends here.
      k += 1;
    }
    const length = k - start + 1;
    const activities = activity.slice(start, k + 1);
    segments.push({
      startByte: start,
      length,
      byteOrder: length === 1 ? 'unknown' : (dir as 'little' | 'big'),
      activities,
      confidence: segmentConfidence(activities, dir),
    });
    j = k + 1;
  }

  return { id, frames: payloads.length, maxByte, segments };
}

/**
 * Confidence in the segmentation: for a multi-byte field, the mean per-step drop
 * (1 = each more-significant byte changes far less than the previous; near 0 =
 * shallow gradient). A lone byte gets a neutral 0.5 (it varies, but its true
 * width is undetermined from one byte alone).
 */
function segmentConfidence(activities: number[], dir: 'little' | 'big' | null): number {
  if (activities.length < 2 || dir === null) return 0.5;
  let acc = 0;
  let steps = 0;
  for (let i = 1; i < activities.length; i++) {
    const lo = dir === 'little' ? activities[i - 1] : activities[i];
    const hi = dir === 'little' ? activities[i] : activities[i - 1];
    if (lo <= 0) continue;
    acc += 1 - hi / lo; // hi is the more-significant (smaller) byte → drop in [0,1).
    steps += 1;
  }
  return steps > 0 ? Math.max(0, Math.min(1, acc / steps)) : 0.5;
}
