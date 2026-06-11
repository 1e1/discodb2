/**
 * Equivalence tests for the cockpit's PACKED scan wrappers (DESIGN §6.1.4 step 3b).
 *
 * Each scanXPacked(packed) must equal scanX(frames) on the same data — this guards
 * the wrapper-level wiring the shared equivalence tests don't see: the tagger →
 * excluded-slot regrouping (co-occurrence), the excludedBytes flatten (discovery),
 * and the reference-series decode (correlation). Frames are fed to scanX as
 * FrameView[] (via the ring) and to scanXPacked as the ring's windowPacked output,
 * so both the windowPacked fill and the packed analyzer path are exercised end to end.
 * Run with vitest (`npm run test`).
 */

import { describe, test, expect } from 'vitest';
import { RawFrameRing } from '../state/ringBuffer';
import type { CanFrame } from '../protocol/types';
import type { EditableSignal } from '../protocol/datamodel';
import { scanBitActivity, scanBitActivityPacked } from './bitActivity';
import { scanByteHistogram, scanByteHistogramPacked } from './byteHistogram';
import { scanCoOccurrence, scanCoOccurrencePacked } from './coOccurrence';
import { scanSignalDiscovery, scanSignalDiscoveryPacked } from './signalDiscovery';
import { scanSignalCorrelation, scanSignalCorrelationPacked } from './signalCorrelation';

const US = 1e6;

function cf(tSec: number, bytes: number[], id: number, isExtended = false): CanFrame {
  return { tUs: tSec * US, id, isExtended, isError: false, isRtr: false, dlc: bytes.length, data: Uint8Array.from(bytes) } as CanFrame;
}

/** A varied synthetic capture: a multi-byte ramp, a counter+checksum id, a flag. */
function buildFrames(): CanFrame[] {
  const frames: CanFrame[] = [];
  let v = 0;
  for (let i = 0; i < 120; i++) {
    v += 257;
    // 0x100: 16-bit LE ramp (bytes 0,1) + a flag (byte 2) + analog byte 3.
    frames.push(cf(i * 0.01, [v & 0xff, (v >> 8) & 0xff, i % 8 === 0 ? 1 : 0, (i * 11) & 0xff], 0x100));
    // 0x200: free-running counter (byte 0) + xor-prefix checksum (byte 3).
    const d = [i & 0xff, (i * 3) & 0xff, 0x10, 0];
    d[3] = d[0] ^ d[1] ^ d[2];
    frames.push(cf(i * 0.01 + 0.002, d, 0x200));
  }
  return frames;
}

function ringOf(frames: CanFrame[]): RawFrameRing {
  const r = new RawFrameRing(4096);
  r.pushMany(frames);
  return r;
}

describe('cockpit packed scan wrappers ≡ frame wrappers', () => {
  const frames = buildFrames();
  const ring = ringOf(frames);
  const now = ring.stats().newestTUs ?? 0;
  const fvs = ring.window(0, now);
  const packed = ring.windowPacked(0, now);

  test('scanBitActivityPacked ≡ scanBitActivity', () => {
    expect(scanBitActivityPacked(packed)).toEqual(scanBitActivity(fvs));
  });

  test('scanByteHistogramPacked ≡ scanByteHistogram', () => {
    expect(scanByteHistogramPacked(packed)).toEqual(scanByteHistogram(fvs));
  });

  test('scanCoOccurrencePacked ≡ scanCoOccurrence (incl. tagger→exclusion wiring)', () => {
    expect(scanCoOccurrencePacked(packed)).toEqual(scanCoOccurrence(fvs));
  });

  test('scanSignalDiscoveryPacked ≡ scanSignalDiscovery (incl. excluded slots)', () => {
    expect(scanSignalDiscoveryPacked(packed)).toEqual(scanSignalDiscovery(fvs));
  });

  test('scanSignalCorrelationPacked ≡ scanSignalCorrelation (incl. reference decode)', () => {
    const reference = {
      id: 'ref', frameId: 0x100, isExtended: false, name: 'ramp',
      bitStart: 0, bitLength: 16, byteOrder: 'little', signed: false, factor: 1, offset: 0,
    } as unknown as EditableSignal;
    expect(scanSignalCorrelationPacked(packed, reference)).toEqual(scanSignalCorrelation(fvs, reference));
  });

  test('allow-list is honoured identically', () => {
    expect(scanBitActivityPacked(packed, [0x100])).toEqual(scanBitActivity(fvs, [0x100]));
    expect(scanByteHistogramPacked(packed, [0x200])).toEqual(scanByteHistogram(fvs, [0x200]));
  });
});
