/**
 * Auto-segmentation SCAN seam — a PASSIVE analyzer sibling to byteHistogram.ts /
 * signalCorrelation.ts. Where the histogram answers "how is each byte
 * distributed?" and bit-activity "which bits move?", AUTO-SEGMENTATION answers
 * "which adjacent bytes form ONE multi-byte signal, and in what byte order?" — it
 * infers field boundaries from a multi-byte value's monotonic activity gradient
 * (LSB changes most, MSB least). It is the field-discovery counterpart that feeds
 * signal promotion (and, later, the hunt log: a proposed segment → a hypothesis).
 *
 * The pure analyzer lives in frontend/shared/analysis/auto-segmentation.ts; this
 * is the thin BOUNDARY ADAPTER that reconciles the frame shape — the ring hands us
 * FrameView (Uint8Array `data`), the analyzer wants SegmentFrame (number[] `data`)
 * — exactly as the other seams do. Counter/checksum exclusion is handled INSIDE
 * the analyzer (it runs the Brick-0 tagger itself), so no extra annotation here.
 *
 * Pure & synchronous over the provided frames → trivially testable and
 * relocatable into a worker later, per the seam contract.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  autoSegment,
  type AutoSegmentResult,
  type AutoSegmentConfig,
  type SegmentFrame,
} from '@shared/analysis/auto-segmentation.ts';

/** Map ring FrameView[] → the shared analyzer's SegmentFrame[] (the seam idiom). */
function toSegmentFrames(frames: ReadonlyArray<FrameView>): SegmentFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * THE SCAN SEAM. Infers field segments per id over an already-windowed slice of
 * ring frames.
 *
 * @param frames   the windowed ring frames (caller slices via ring.window /
 *                 ring.lastSeconds, like the other scan paths).
 * @param allowIds optional id allow-list (empty/undefined = all ids).
 * @param config   optional analyzer threshold overrides.
 */
export function scanAutoSegment(
  frames: ReadonlyArray<FrameView>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<AutoSegmentConfig> = {},
): AutoSegmentResult {
  return autoSegment(toSegmentFrames(frames), allowIds, config);
}
