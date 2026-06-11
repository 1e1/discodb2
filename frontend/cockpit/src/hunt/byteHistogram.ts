/**
 * Byte-histogram SCAN seam (DESIGN §9) — the second PASSIVE analyzer, sibling to
 * bitActivity.ts. The Hunt "Scan" sub-view runs framework-free analyzers over a
 * window of the ring buffer with NO operator action. Where the bit-activity
 * heatmap answers "which BITS move?", the PER-BYTE VALUE HISTOGRAM answers "HOW
 * is each byte's VALUE distributed?" — few discrete values ⇒ enum/flag, a wide
 * continuous spread ⇒ analog signal (docs/WIZARD.md). The pure analyzer lives in
 * frontend/shared/analysis/byte-histogram.ts; this file is the thin BOUNDARY
 * ADAPTER that plugs it into the cockpit's seam, mirroring bitActivity.ts:
 *
 *     scanByteHistogram(frames: FrameView[], opts?) -> ByteHistogramScanResult
 *
 * The only impedance to reconcile is the frame shape: the ring hands us
 * FrameView (with a Uint8Array `data`), and the shared analyzer wants
 * HistogramFrame (with a number[] `data`). We map it identically to bitActivity:
 *
 *     frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }))
 *
 * Counter/checksum annotation rides ALONGSIDE the histogram result, exactly as
 * the heatmap does: the same windowed frames are passed through the Brick-0
 * tagger so the UI can mark which bytes are mere counters/checksums (a counter
 * spreads over many values and would otherwise masquerade as a rich analog byte)
 * rather than real signal.
 *
 * The adapter is PURE and synchronous over the provided frames (it just calls
 * the pure shared fns and maps shapes), so it stays trivially testable and
 * relocatable into a worker later, exactly as the seam contract requires.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  byteHistogram,
  byteHistogramPacked,
  type ByteHistogramResult,
  type ByteHistogramConfig,
  type HistogramFrame,
} from '@shared/analysis/byte-histogram.ts';
import { tagFrames, tagFramesPacked, type Tag, type RawFrame } from '@shared/analysis/tagger.ts';
import type { PackedFrames } from '@shared/analysis/packed.ts';

/** The cockpit-side scan result: the histogram plus per-id tagger annotations. */
export interface ByteHistogramScanResult {
  /** The pure per-byte value histogram (ids sorted richest-first). */
  histogram: ByteHistogramResult;
  /**
   * Per-id counter/checksum tags from Brick 0, so the UI can annotate which
   * bytes are noise (a free-running counter looks analog-rich but is meaningless).
   * Keyed by numeric id (same keying the tagger uses).
   */
  tagsById: Map<number, Tag[]>;
}

/** Map ring FrameView[] → the shared analyzer's HistogramFrame[] (the seam idiom). */
function toHistogramFrames(frames: ReadonlyArray<FrameView>): HistogramFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * THE SCAN SEAM. Runs the passive per-byte value histogram (and the tagger for
 * annotation) over an already-windowed slice of ring frames.
 *
 * @param frames   the windowed ring frames (caller slices via ring.window /
 *                 ring.lastSeconds, exactly like the bit-activity scan path).
 * @param allowIds optional id allow-list (empty/undefined = all ids).
 * @param config   optional analyzer threshold overrides.
 */
export function scanByteHistogram(
  frames: ReadonlyArray<FrameView>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<ByteHistogramConfig> = {},
): ByteHistogramScanResult {
  const histFrames = toHistogramFrames(frames);
  const histogram = byteHistogram(histFrames, allowIds, config);
  // The tagger consumes the SAME frames (it ignores tUs); reuse the mapped
  // payloads — RawFrame is a structural subset of HistogramFrame ({id, data}).
  const tagsById = tagFrames(histFrames as RawFrame[]);
  return { histogram, tagsById };
}

/**
 * Packed-window variant of {@link scanByteHistogram} (DESIGN §6.1.4 step 3b): reads
 * a columnar {@link PackedFrames} straight from RawFrameRing.windowPacked — no
 * FrameView objects, no per-frame `Array.from` payload copy. Behaviour-identical to
 * scanByteHistogram (the shared analyzers' equivalence tests pin packed ≡ frame).
 */
export function scanByteHistogramPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<ByteHistogramConfig> = {},
): ByteHistogramScanResult {
  const histogram = byteHistogramPacked(p, allowIds, config);
  const tagsById = tagFramesPacked(p);
  return { histogram, tagsById };
}
