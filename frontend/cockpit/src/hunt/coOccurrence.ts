/**
 * Co-occurrence SCAN seam (DESIGN §9) — the FOURTH PASSIVE analyzer, sibling to
 * bitActivity.ts and byteHistogram.ts. The Hunt "Scan" sub-view runs
 * framework-free analyzers over a window of the ring buffer with NO operator
 * action. Where the bit-activity heatmap answers "which BITS move?" and the byte
 * histogram answers "HOW is each byte's VALUE distributed?", the CO-OCCURRENCE OF
 * CHANGES matrix answers "which BYTES change TOGETHER?" — the cross-byte coupling
 * the others can't see (docs/WIZARD.md). The pure analyzer lives in
 * frontend/shared/analysis/co-occurrence.ts; this file is the thin BOUNDARY
 * ADAPTER that plugs it into the cockpit's seam, mirroring the other two:
 *
 *     scanCoOccurrence(frames: FrameView[], opts?) -> CoOccurrenceScanResult
 *
 * The only impedance to reconcile is the frame shape: the ring hands us
 * FrameView (with a Uint8Array `data`), and the shared analyzer wants
 * CoOccurrenceFrame (with a number[] `data`). We map it identically to the other
 * seams:
 *
 *     frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }))
 *
 * Counter/checksum annotation is wired IN, not just alongside: this analyzer's
 * "likely groups" and "hubs" read-outs are about cross-byte coupling, and a
 * checksum is exactly a byte that couples with everything. So we run the same
 * Brick-0 tagger over the same windowed frames, flatten its tags to the set of
 * excluded byte slots (tagger.excludedBytes, keyed "id:byteIndex"), regroup those
 * into a per-id byte-index map, and HAND that map to the analyzer so its read-outs
 * are annotated (a "group" or "hub" that is really a counter/checksum is marked,
 * not mistaken for signal). The tags also ride alongside (tagsById) so the UI can
 * draw the same amber annotation as the heatmap/histogram.
 *
 * The adapter is PURE and synchronous over the provided frames (it just calls the
 * pure shared fns and maps shapes), so it stays trivially testable and relocatable
 * into a worker later, exactly as the seam contract requires.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  coOccurrence,
  coOccurrencePacked,
  type CoOccurrenceResult,
  type CoOccurrenceConfig,
  type CoOccurrenceFrame,
} from '@shared/analysis/co-occurrence.ts';
import { tagFrames, tagFramesPacked, excludedBytes, type Tag, type RawFrame } from '@shared/analysis/tagger.ts';
import type { PackedFrames } from '@shared/analysis/packed.ts';

/** The cockpit-side scan result: the co-change matrices plus tagger annotations. */
export interface CoOccurrenceScanResult {
  /** The pure per-id co-change profiles (ids sorted most-structured-first). */
  coOccurrence: CoOccurrenceResult;
  /**
   * Per-id counter/checksum tags from Brick 0, so the UI can annotate which
   * bytes are noise. Keyed by numeric id (same keying the tagger uses).
   */
  tagsById: Map<number, Tag[]>;
}

/** Map ring FrameView[] → the shared analyzer's CoOccurrenceFrame[] (the seam idiom). */
function toCoOccurrenceFrames(frames: ReadonlyArray<FrameView>): CoOccurrenceFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * Regroup the tagger's flat excluded-slot set (keys "id:byteIndex", both decimal)
 * back into a per-id map of byte indices, the shape the co-occurrence analyzer
 * wants for its read-out annotation. This reuses tagger.excludedBytes as the
 * single source of truth for "which slots are not real signal" (same set the
 * guided scorers skip), so the Scan analyzer's exclusions can never drift from
 * the rest of the stack.
 */
function excludedByIds(tagsById: Map<number, Tag[]>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const key of excludedBytes(tagsById)) {
    const sep = key.indexOf(':');
    const id = Number(key.slice(0, sep));
    const byteIndex = Number(key.slice(sep + 1));
    const list = out.get(id);
    if (list) list.push(byteIndex);
    else out.set(id, [byteIndex]);
  }
  return out;
}

/**
 * THE SCAN SEAM. Runs the passive co-occurrence-of-changes analyzer (and the
 * tagger for annotation) over an already-windowed slice of ring frames.
 *
 * @param frames   the windowed ring frames (caller slices via ring.window /
 *                 ring.lastSeconds, exactly like the other Scan analyzers).
 * @param allowIds optional id allow-list (empty/undefined = all ids).
 * @param config   optional analyzer threshold overrides.
 */
export function scanCoOccurrence(
  frames: ReadonlyArray<FrameView>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<CoOccurrenceConfig> = {},
): CoOccurrenceScanResult {
  const coFrames = toCoOccurrenceFrames(frames);
  // The tagger consumes the SAME frames (it ignores tUs); reuse the mapped
  // payloads — RawFrame is a structural subset of CoOccurrenceFrame ({id, data}).
  const tagsById = tagFrames(coFrames as RawFrame[]);
  // Wire the tagged byte slots INTO the analyzer so its groups/hubs are annotated.
  const result = coOccurrence(coFrames, allowIds, excludedByIds(tagsById), config);
  return { coOccurrence: result, tagsById };
}

/**
 * Packed-window variant of {@link scanCoOccurrence} (DESIGN §6.1.4 step 3b): reads a
 * columnar {@link PackedFrames} straight from RawFrameRing.windowPacked — no
 * FrameView objects, no per-frame `Array.from` payload copy. The tagger→exclusion
 * wiring is identical; behaviour matches scanCoOccurrence (the shared analyzers'
 * equivalence tests pin packed ≡ frame).
 */
export function scanCoOccurrencePacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<CoOccurrenceConfig> = {},
): CoOccurrenceScanResult {
  const tagsById = tagFramesPacked(p);
  const result = coOccurrencePacked(p, allowIds, excludedByIds(tagsById), config);
  return { coOccurrence: result, tagsById };
}
