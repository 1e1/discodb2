/**
 * Signal-correlation SCAN seam (DESIGN §9) — the FIFTH PASSIVE analyzer, sibling
 * to bitActivity.ts, byteHistogram.ts, signalDiscovery.ts and coOccurrence.ts. The
 * Hunt "Scan" sub-view runs framework-free analyzers over a window of the ring
 * buffer. Unlike the other four this one takes ONE operator input: a REFERENCE
 * signal the operator ALREADY decoded (rpm, speed, …). The analyzer then ranks
 * every candidate locus by how tightly its decoded series CO-VARIES (Spearman ρ)
 * with that reference over the window — the "find the gear by correlating against
 * rpm/speed" use case (docs/WIZARD.md, project notes).
 *
 * The pure analyzer lives in frontend/shared/analysis/signal-correlation.ts; this
 * file is the thin BOUNDARY ADAPTER that plugs it into the cockpit's seam,
 * mirroring signalDiscovery.ts:
 *
 *     scanSignalCorrelation(frames, reference, opts?) -> SignalCorrelationScanResult
 *
 * Two impedances to reconcile, both local to the cockpit:
 *   1. FRAME SHAPE — the ring hands us FrameView (Uint8Array `data`); the shared
 *      analyzer wants CorrelationFrame (number[] `data`). Mapped identically to the
 *      other seams: frames.map((f) => ({ id, tUs, data: Array.from(f.data) })).
 *   2. THE REFERENCE SERIES — the operator picks a §3.5 EditableSignal as the
 *      reference. We DECODE it here, in the cockpit, reusing decode.ts/extractRaw
 *      (the SAME bit walk the rest of the cockpit uses, so the reference series is
 *      exactly what the operator sees in the Inspector) — the pure analyzer is fed
 *      only a plain (tUs, value) series and never imports decode. The reference is
 *      decoded from the frames whose id/isExtended match the reference signal's
 *      frame, over the SAME window, in arrival order.
 *
 * Counter/checksum EXCLUSION is wired through the SAME Brick-0 tagger as the other
 * analyzers — and, like signal-discovery, we EXCLUDE (not just annotate): a +1
 * counter rises monotonically and would correlate spuriously with any rising
 * reference over a non-wrapping window, so candidates overlapping a tagged
 * counter/checksum byte are dropped before scoring.
 *
 * The adapter is PURE and synchronous over the provided frames + reference (it
 * calls the pure shared fns, maps shapes, and decodes the reference via the
 * cockpit's own pure decode), so it stays trivially testable.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  signalCorrelation,
  signalCorrelationPacked,
  type SignalCorrelationResult,
  type SignalCorrelationConfig,
  type CorrelationFrame,
  type ReferenceSample,
} from '@shared/analysis/signal-correlation.ts';
import { tagFrames, tagFramesPacked, excludedBytes, type RawFrame } from '@shared/analysis/tagger.ts';
import { payloadLen, isExtended as packedIsExtended, type PackedFrames } from '@shared/analysis/packed.ts';
import { extractRaw } from '../protocol/decode';
import type { EditableSignal } from '../protocol/datamodel';

/** The cockpit-side scan result: the ranked candidates plus the run-wide totals. */
export interface SignalCorrelationScanResult {
  /** The pure correlation result (candidates ranked by strongest |ρ| first). */
  correlation: SignalCorrelationResult;
}

/** Map ring FrameView[] → the shared analyzer's CorrelationFrame[] (the seam idiom). */
function toCorrelationFrames(frames: ReadonlyArray<FrameView>): CorrelationFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * Decode the REFERENCE signal's value series from the windowed frames, in arrival
 * order. Only frames matching the reference's frame (id + isExtended) and long
 * enough to carry the whole signal contribute; short frames are skipped (a missing
 * byte is not a value-0 sample), matching the analyzer's SHORT-DLC rule. Uses the
 * cockpit's own extractRaw so the series is identical to the Inspector's decode;
 * the physical value (raw·factor + offset) is what we correlate, but since Spearman
 * is rank-based the factor/offset don't change ρ — we apply them anyway so the
 * series is the operator's real signal, not a raw integer.
 */
export function decodeReferenceSeries(
  frames: ReadonlyArray<FrameView>,
  reference: EditableSignal,
): ReferenceSample[] {
  const out: ReferenceSample[] = [];
  const lastBit = highestBit(reference);
  for (const f of frames) {
    if (f.id !== reference.frameId || f.isExtended !== reference.isExtended) continue;
    if (lastBit >> 3 >= f.data.length) continue; // SHORT-DLC: can't carry the signal.
    const raw = extractRaw(f.data, reference);
    out.push({ tUs: f.tUs, value: Number(raw) * reference.factor + reference.offset });
  }
  return out;
}

/** Highest standard-CAN bit index touched by the reference (for the DLC guard). */
function highestBit(sig: EditableSignal): number {
  // little (Intel): contiguous from bitStart; the top bit is bitStart + len - 1.
  // big (Motorola sawtooth): bitStart is the MSB at local bit 7 of its byte; the
  // signal's LOWEST bit sits len-1 bits "down" the sawtooth. The simplest safe
  // bound is the max byte the signal could touch, derived the same way decode.ts
  // walks the order — but since we only need a DLC guard, computing the LSB byte
  // suffices: for big-endian the run ends at a higher byte index than it starts.
  if (sig.byteOrder === 'little') return sig.bitStart + sig.bitLength - 1;
  // Motorola walk: start at bitStart's byte/bit (MSB), step down 7→0 then to the
  // next byte. The final (LSB) bit index is what bounds the read.
  let byteIndex = sig.bitStart >> 3;
  let bitInByte = sig.bitStart & 7;
  for (let i = 1; i < sig.bitLength; i++) {
    if (bitInByte === 0) {
      bitInByte = 7;
      byteIndex += 1;
    } else {
      bitInByte -= 1;
    }
  }
  return byteIndex * 8 + bitInByte;
}

/**
 * THE SCAN SEAM. Runs the passive correlation-against-a-known-signal analyzer over
 * an already-windowed slice of ring frames, ranking candidate loci by Spearman
 * correlation with the operator's chosen reference signal — excluding
 * counter/checksum byte slots the Brick-0 tagger flags.
 *
 * @param frames    the windowed ring frames (caller slices via ring.window /
 *                  ring.lastSeconds, exactly like the other Scan analyzers).
 * @param reference the operator's known §3.5 signal, decoded over the same frames
 *                  to form the reference series.
 * @param allowIds  optional id allow-list for the CANDIDATES (empty/undefined = all
 *                  ids). The reference id is decoded regardless of this list.
 * @param config    optional analyzer threshold / sweep overrides.
 */
export function scanSignalCorrelation(
  frames: ReadonlyArray<FrameView>,
  reference: EditableSignal,
  allowIds?: ReadonlyArray<number>,
  config: Partial<SignalCorrelationConfig> = {},
): SignalCorrelationScanResult {
  const corrFrames = toCorrelationFrames(frames);
  const refSeries = decodeReferenceSeries(frames, reference);
  // The tagger consumes the SAME mapped frames (it ignores tUs); RawFrame is a
  // structural subset of CorrelationFrame ({id, data}). Flatten its tags to the
  // "id:byteIndex" exclusion set the analyzer skips before scoring.
  const tagsById = tagFrames(corrFrames as RawFrame[]);
  const excluded = excludedBytes(tagsById);
  const correlation = signalCorrelation(corrFrames, refSeries, allowIds, excluded, config);
  return { correlation };
}

/**
 * Decode the reference series directly from a {@link PackedFrames}: per matching
 * frame, a length-dlc subarray VIEW of the packed payload is fed to the cockpit's
 * extractRaw — identical bytes to {@link decodeReferenceSeries}, no per-frame copy.
 * Only the reference id's frames are touched (a bounded subset), so the transient
 * subarray views are few.
 */
function decodeReferenceSeriesPacked(p: PackedFrames, reference: EditableSignal): ReferenceSample[] {
  const out: ReferenceSample[] = [];
  const lastBit = highestBit(reference);
  for (let i = 0; i < p.count; i++) {
    if (p.id[i] !== reference.frameId || packedIsExtended(p, i) !== reference.isExtended) continue;
    const len = payloadLen(p, i);
    if (lastBit >> 3 >= len) continue; // SHORT-DLC: can't carry the signal.
    const raw = extractRaw(p.data.subarray(i * 8, i * 8 + len), reference);
    out.push({ tUs: p.tUs[i], value: Number(raw) * reference.factor + reference.offset });
  }
  return out;
}

/**
 * Packed-window variant of {@link scanSignalCorrelation} (DESIGN §6.1.4 step 3b):
 * reads a columnar {@link PackedFrames} straight from RawFrameRing.windowPacked — no
 * FrameView objects, no per-frame `Array.from` payload copy. The reference decode +
 * tagger→exclusion wiring are identical; behaviour matches scanSignalCorrelation
 * (the shared analyzers' equivalence tests pin packed ≡ frame).
 */
export function scanSignalCorrelationPacked(
  p: PackedFrames,
  reference: EditableSignal,
  allowIds?: ReadonlyArray<number>,
  config: Partial<SignalCorrelationConfig> = {},
): SignalCorrelationScanResult {
  const refSeries = decodeReferenceSeriesPacked(p, reference);
  const excluded = excludedBytes(tagFramesPacked(p));
  const correlation = signalCorrelationPacked(p, refSeries, allowIds, excluded, config);
  return { correlation };
}
