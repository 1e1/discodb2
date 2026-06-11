/**
 * Bit-activity SCAN seam (DESIGN §9) — the PASSIVE counterpart to hunt.ts.
 *
 * The Hunt "Scan" sub-view runs framework-free analyzers over a window of the
 * ring buffer with NO operator action. The first analyzer — the BIT-ACTIVITY
 * HEATMAP — lives in frontend/shared/analysis/bit-activity.ts. This file is the
 * thin BOUNDARY ADAPTER that plugs it into the cockpit's seam, exactly mirroring
 * how hunt.ts plugs in the guided `runExperiment`:
 *
 *     scanBitActivity(frames: FrameView[], opts?) -> BitActivityResult
 *
 * The only impedance to reconcile is the frame shape: the ring hands us
 * FrameView (with a Uint8Array `data`), and the shared analyzer wants ScanFrame
 * (with a number[] `data`). We map it identically to hunt.ts's window mapping:
 *
 *     frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }))
 *
 * Counter/checksum annotation rides ALONGSIDE the activity result: the same
 * windowed frames are passed through the Brick-0 tagger so the UI can mark which
 * busy bytes are mere counters/checksums (noise) rather than real signal.
 *
 * The adapter is PURE and synchronous over the provided frames (it just calls
 * the pure shared fns and maps shapes), so it stays trivially testable and
 * relocatable into a worker later, exactly as the seam contract requires.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  bitActivity,
  bitActivityPacked,
  type BitActivityResult,
  type BitActivityConfig,
  type ScanFrame,
} from '@shared/analysis/bit-activity.ts';
import { tagFrames, tagFramesPacked, type Tag, type RawFrame } from '@shared/analysis/tagger.ts';
import type { PackedFrames } from '@shared/analysis/packed.ts';

/** The cockpit-side scan result: the heatmap plus per-id tagger annotations. */
export interface ScanResult {
  /** The pure bit-activity heatmap (ids sorted busiest-first). */
  activity: BitActivityResult;
  /**
   * Per-id counter/checksum tags from Brick 0, so the UI can annotate which
   * busy bytes are noise. Keyed by numeric id (same keying the tagger uses).
   */
  tagsById: Map<number, Tag[]>;
}

/** Map ring FrameView[] → the shared analyzer's ScanFrame[] (the hunt.ts idiom). */
function toScanFrames(frames: ReadonlyArray<FrameView>): ScanFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * THE SCAN SEAM. Runs the passive bit-activity heatmap (and the tagger for
 * annotation) over an already-windowed slice of ring frames.
 *
 * @param frames   the windowed ring frames (caller slices via ring.window /
 *                 ring.lastSeconds, exactly like the guided Hunt path).
 * @param allowIds optional id allow-list (empty/undefined = all ids).
 * @param config   optional analyzer threshold overrides.
 */
export function scanBitActivity(
  frames: ReadonlyArray<FrameView>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<BitActivityConfig> = {},
): ScanResult {
  const scanFrames = toScanFrames(frames);
  const activity = bitActivity(scanFrames, allowIds, config);
  // The tagger consumes the SAME frames (it ignores tUs); reuse the mapped
  // payloads — RawFrame is a structural subset of ScanFrame ({id, data}).
  const tagsById = tagFrames(scanFrames as RawFrame[]);
  return { activity, tagsById };
}

/**
 * Packed-window variant of {@link scanBitActivity} (DESIGN §6.1.4 step 3b): reads a
 * columnar {@link PackedFrames} straight from RawFrameRing.windowPacked — no
 * FrameView objects, no per-frame `Array.from` payload copy. Behaviour-identical to
 * scanBitActivity (the shared analyzers' equivalence tests pin packed ≡ frame).
 */
export function scanBitActivityPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<BitActivityConfig> = {},
): ScanResult {
  const activity = bitActivityPacked(p, allowIds, config);
  const tagsById = tagFramesPacked(p);
  return { activity, tagsById };
}
