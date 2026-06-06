/**
 * Tests for RawFrameRing's zero-copy view variants (DESIGN §6.1.4 step 3a).
 *
 * Two properties matter:
 *  1. EQUIVALENCE — atView/windowView/lastSecondsView yield the same logical
 *     frames and bit-identical bytes as the copying at/window/lastSeconds.
 *  2. The UNSAFE-TO-RETAIN contract — a retained view reflects a later push that
 *     overwrites its physical slot, whereas a window() copy is unaffected. This
 *     test documents (and pins) exactly why views are synchronous-scan-only.
 * Run with vitest (`npm run test`).
 */

import { describe, test, expect } from 'vitest';
import { RawFrameRing, type FrameView } from './ringBuffer';
import type { CanFrame } from '../protocol/types';
import type { PackedFrames } from '@shared/analysis/packed.ts';

const US = 1e6;

function cf(tSec: number, bytes: number[], id = 0x100, isExtended = false): CanFrame {
  return {
    tUs: tSec * US,
    id,
    isExtended,
    isError: false,
    isRtr: false,
    dlc: bytes.length,
    data: Uint8Array.from(bytes),
  } as CanFrame;
}

function sameFrame(a: FrameView, b: FrameView): void {
  expect(a.tUs).toBe(b.tUs);
  expect(a.id).toBe(b.id);
  expect(a.isExtended).toBe(b.isExtended);
  expect(a.isError).toBe(b.isError);
  expect(a.isRtr).toBe(b.isRtr);
  expect(a.dlc).toBe(b.dlc);
  expect(Array.from(a.data)).toEqual(Array.from(b.data));
}

function sameSeq(a: FrameView[], b: FrameView[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) sameFrame(a[i], b[i]);
}

const mixed: CanFrame[] = [
  cf(0, [1, 2, 3, 4, 5, 6, 7, 8], 0x100),
  cf(1, [9, 8, 7], 0x200), // short dlc → exercises subarray length
  cf(2, [0xaa, 0xbb], 0x100),
  cf(3, [0, 0, 0, 0, 0, 0, 0, 0], 0x200),
  cf(4, [255, 254, 253, 252], 0x100, true),
];

describe('RawFrameRing view variants — equivalence with copying reads', () => {
  test('atView ≡ at for every logical index', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    for (let l = 0; l < r.size; l++) sameFrame(r.atView(l), r.at(l));
  });

  test('atView throws out of range like at', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    expect(() => r.atView(-1)).toThrow(RangeError);
    expect(() => r.atView(r.size)).toThrow(RangeError);
  });

  test('windowView ≡ window (full span, id filter, sub-range)', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    sameSeq(r.windowView(0, 4 * US), r.window(0, 4 * US));
    sameSeq(r.windowView(0, 4 * US, 0x100), r.window(0, 4 * US, 0x100));
    sameSeq(r.windowView(1 * US, 3 * US), r.window(1 * US, 3 * US));
  });

  test('lastSecondsView ≡ lastSeconds', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    sameSeq(r.lastSecondsView(2.5), r.lastSeconds(2.5));
    sameSeq(r.lastSecondsView(2.5, 0x200), r.lastSeconds(2.5, 0x200));
    expect(new RawFrameRing(4).lastSecondsView(5)).toEqual([]);
  });

  test('equivalence holds after the ring has wrapped', () => {
    const r = new RawFrameRing(3); // smaller than the dataset → wraparound
    r.pushMany(mixed);
    expect(r.size).toBe(3);
    for (let l = 0; l < r.size; l++) sameFrame(r.atView(l), r.at(l));
    sameSeq(r.windowView(0, 10 * US), r.window(0, 10 * US));
  });
});

/** A PackedFrames must reproduce, frame-for-frame, the FrameViews of window(). */
function samePacked(p: PackedFrames, fvs: FrameView[]): void {
  expect(p.count).toBe(fvs.length);
  for (let i = 0; i < p.count; i++) {
    const f = fvs[i];
    expect(p.tUs[i]).toBe(f.tUs);
    expect(p.id[i]).toBe(f.id);
    expect(p.dlc[i]).toBe(f.dlc);
    expect((p.flags[i] & 1) !== 0).toBe(f.isExtended);
    expect((p.flags[i] & 2) !== 0).toBe(f.isError);
    expect((p.flags[i] & 4) !== 0).toBe(f.isRtr);
    for (let b = 0; b < f.dlc; b++) expect(p.data[i * 8 + b]).toBe(f.data[b]);
  }
}

describe('RawFrameRing.windowPacked / lastSecondsPacked — equivalence with window', () => {
  test('windowPacked ≡ window: full span (fast two-span path), id filter, sub-range', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    samePacked(r.windowPacked(0, 4 * US), r.window(0, 4 * US)); // n===count → fast path
    samePacked(r.windowPacked(0, 4 * US, 0x100), r.window(0, 4 * US, 0x100)); // general path
    samePacked(r.windowPacked(1 * US, 3 * US), r.window(1 * US, 3 * US)); // general path
  });

  test('windowPacked ≡ window after the ring has wrapped (fast path across the wrap)', () => {
    const r = new RawFrameRing(3);
    r.pushMany(mixed);
    expect(r.size).toBe(3);
    samePacked(r.windowPacked(0, 10 * US), r.window(0, 10 * US));
  });

  test('lastSecondsPacked ≡ lastSeconds; empty ring → count 0', () => {
    const r = new RawFrameRing(16);
    r.pushMany(mixed);
    samePacked(r.lastSecondsPacked(2.5), r.lastSeconds(2.5));
    samePacked(r.lastSecondsPacked(2.5, 0x200), r.lastSeconds(2.5, 0x200));
    expect(new RawFrameRing(4).lastSecondsPacked(5).count).toBe(0);
  });

  test('windowPacked is a real copy (safe to retain across an overwriting push)', () => {
    const r = new RawFrameRing(4);
    r.pushMany([
      cf(0, [10, 11, 12, 13, 14, 15, 16, 17]),
      cf(1, [20, 21, 22, 23, 24, 25, 26, 27]),
      cf(2, [30, 31, 32, 33, 34, 35, 36, 37]),
      cf(3, [40, 41, 42, 43, 44, 45, 46, 47]),
    ]);
    const p = r.windowPacked(0, 10 * US);
    r.push(cf(4, [99, 98, 97, 96, 95, 94, 93, 92])); // overwrites physical slot 0
    // The packed COPY of the oldest frame is unaffected (unlike a windowView).
    expect(Array.from(p.data.subarray(0, 8))).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

describe('RawFrameRing view variants — unsafe-to-retain contract', () => {
  test('a later push that overwrites the slot mutates a retained view but not a copy', () => {
    const r = new RawFrameRing(4);
    // Fill to capacity → head wraps back to physical slot 0 (oldest = logical 0).
    r.pushMany([
      cf(0, [10, 11, 12, 13, 14, 15, 16, 17]),
      cf(1, [20, 21, 22, 23, 24, 25, 26, 27]),
      cf(2, [30, 31, 32, 33, 34, 35, 36, 37]),
      cf(3, [40, 41, 42, 43, 44, 45, 46, 47]),
    ]);

    const view = r.windowView(0, 10 * US);
    const copy = r.window(0, 10 * US);
    // Oldest frame (logical 0) currently reads its original bytes via both.
    expect(Array.from(view[0].data)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(Array.from(copy[0].data)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);

    // Push a new frame: it overwrites physical slot 0, the slot logical-0 viewed.
    r.push(cf(4, [99, 98, 97, 96, 95, 94, 93, 92]));

    // The retained VIEW now reflects the overwrite (UNSAFE to retain) ...
    expect(Array.from(view[0].data)).toEqual([99, 98, 97, 96, 95, 94, 93, 92]);
    // ... while the COPY is untouched (safe to retain across pushes).
    expect(Array.from(copy[0].data)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });
});
