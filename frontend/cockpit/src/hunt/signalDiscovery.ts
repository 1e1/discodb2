/**
 * Signal-discovery SCAN seam (DESIGN §9) — the THIRD PASSIVE analyzer, sibling to
 * bitActivity.ts and byteHistogram.ts. The Hunt "Scan" sub-view runs
 * framework-free analyzers over a window of the ring buffer with NO operator
 * action. Where the bit-activity heatmap answers "which BITS move?" and the byte
 * histogram "HOW is a byte's value distributed?", the SIGNAL-DISCOVERY SWEEP
 * answers "if I read THIS bit-range as a NUMBER under THIS convention, does it
 * behave like a real analog signal?" — SavvyCAN's "signal discovery / range
 * state" analog (docs/WIZARD.md). The pure analyzer lives in
 * frontend/shared/analysis/signal-discovery.ts; this file is the thin BOUNDARY
 * ADAPTER that plugs it into the cockpit's seam, mirroring byteHistogram.ts:
 *
 *     scanSignalDiscovery(frames: FrameView[], opts?) -> SignalDiscoveryScanResult
 *
 * The only impedance to reconcile is the frame shape: the ring hands us
 * FrameView (with a Uint8Array `data`), and the shared analyzer wants SignalFrame
 * (with a number[] `data`). We map it identically to bitActivity/byteHistogram:
 *
 *     frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }))
 *
 * Counter/checksum EXCLUSION is wired through the SAME Brick-0 tagger the other
 * two analyzers annotate with — but here we don't merely annotate, we EXCLUDE: a
 * +1 counter is perfectly "smooth" until it wraps and would otherwise rank as a
 * great analog signal, so the candidates that overlap a tagged counter/checksum
 * byte are dropped before scoring. We pass the tagger's flattened `excludedBytes`
 * set (keyed "id:byteIndex") straight into the analyzer.
 *
 * The adapter is PURE and synchronous over the provided frames (it just calls the
 * pure shared fns and maps shapes), so it stays trivially testable and relocatable
 * into a worker later, exactly as the seam contract requires.
 */

import type { FrameView } from '../state/ringBuffer';
import {
  signalDiscovery,
  signalDiscoveryPacked,
  type SignalDiscoveryResult,
  type SignalDiscoveryConfig,
  type SignalFrame,
} from '@shared/analysis/signal-discovery.ts';
import { tagFrames, tagFramesPacked, excludedBytes, type RawFrame } from '@shared/analysis/tagger.ts';
import type { PackedFrames } from '@shared/analysis/packed.ts';

/** The cockpit-side scan result: the ranked candidates plus the run-wide totals. */
export interface SignalDiscoveryScanResult {
  /** The pure signal-discovery result (candidates ranked most-plausible first). */
  discovery: SignalDiscoveryResult;
}

/** Map ring FrameView[] → the shared analyzer's SignalFrame[] (the seam idiom). */
function toSignalFrames(frames: ReadonlyArray<FrameView>): SignalFrame[] {
  return frames.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
}

/**
 * THE SCAN SEAM. Runs the passive signal-discovery sweep over an already-windowed
 * slice of ring frames, excluding counter/checksum byte slots the Brick-0 tagger
 * flags (so a wrapping counter can't masquerade as a smooth analog signal).
 *
 * @param frames   the windowed ring frames (caller slices via ring.window /
 *                 ring.lastSeconds, exactly like the other Scan analyzers).
 * @param allowIds optional id allow-list (empty/undefined = all ids).
 * @param config   optional analyzer threshold / sweep overrides.
 */
export function scanSignalDiscovery(
  frames: ReadonlyArray<FrameView>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<SignalDiscoveryConfig> = {},
): SignalDiscoveryScanResult {
  const sigFrames = toSignalFrames(frames);
  // The tagger consumes the SAME frames (it ignores tUs); RawFrame is a structural
  // subset of SignalFrame ({id, data}). Flatten its tags to the "id:byteIndex"
  // exclusion set the analyzer skips before scoring.
  const tagsById = tagFrames(sigFrames as RawFrame[]);
  const excluded = excludedBytes(tagsById);
  const discovery = signalDiscovery(sigFrames, allowIds, excluded, config);
  return { discovery };
}

/**
 * Packed-window variant of {@link scanSignalDiscovery} (DESIGN §6.1.4 step 3b):
 * reads a columnar {@link PackedFrames} straight from RawFrameRing.windowPacked —
 * no FrameView objects, no per-frame `Array.from` payload copy. The tagger→exclusion
 * wiring is identical; behaviour matches scanSignalDiscovery (the shared analyzers'
 * equivalence tests pin packed ≡ frame).
 */
export function scanSignalDiscoveryPacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  config: Partial<SignalDiscoveryConfig> = {},
): SignalDiscoveryScanResult {
  const excluded = excludedBytes(tagFramesPacked(p));
  const discovery = signalDiscoveryPacked(p, allowIds, excluded, config);
  return { discovery };
}
