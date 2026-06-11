/**
 * Tests for the INCREMENTAL message model (messageModel.ts) and the ring cursor
 * (RawFrameRing.since) it rides on.
 *
 * The model must produce the SAME rows as the from-scratch computeMessages — the
 * incremental append is just an optimization. So the central test feeds frames in
 * two batches (forcing the append path) and asserts the result equals both a
 * fresh model AND computeMessages over the whole history. Rate is bucket-based
 * (±1 s vs computeMessages' exact-µs windowing), so the structural comparison
 * ignores `rate`; a dedicated test pins the windowed rate on its own terms.
 * Run with vitest (`npm run test`).
 */

import { describe, test, expect } from 'vitest';
import { RawFrameRing } from '../state/ringBuffer';
import { computeMessages, type MessageRow } from './messages';
import { createMessageModel } from './messageModel';
import type { FrameDef } from './datamodel';
import type { CanFrame } from './types';

const US = 1e6;
const sel = { id: 0x100, isExtended: false };

/** Force byte 0 (8-bit) as the discriminator — deterministic, no Auto variance. */
const forcedByte0 = {
  id: 0x100,
  isExtended: false,
  name: '0x100',
  signals: [
    { id: 's0', frameId: 0x100, isExtended: false, name: 'mid', bitStart: 0, bitLength: 8, byteOrder: 'little', isMultiplexor: true },
  ],
} as unknown as FrameDef;

function cf(tSec: number, bytes: number[], id = 0x100): CanFrame {
  return { tUs: tSec * US, id, isExtended: false, isError: false, isRtr: false, dlc: bytes.length, data: Uint8Array.from(bytes) } as CanFrame;
}

function ringOf(frames: CanFrame[], cap = 1000): RawFrameRing {
  const r = new RawFrameRing(cap);
  r.pushMany(frames);
  return r;
}

/** Structural view of rows, ignoring `rate` (bucket vs exact-µs differ by ≤1 s). */
function bare(rows: MessageRow[]) {
  return rows.map((r) => ({
    mux: r.mux,
    count: r.count,
    dlc: r.dlc,
    data: Array.from(r.data),
    lastTUs: r.lastTUs,
    idBytes: r.idBytes,
    idHexWidth: r.idHexWidth,
  }));
}

/** computeMessages over the ring's full history for the selection (the reference). */
function reference(ring: RawFrameRing, def: FrameDef | undefined, win: number, now: number): MessageRow[] {
  const fs = ring.lastSeconds(86400, sel.id).filter((f) => f.isExtended === sel.isExtended);
  const denom = win === 0 ? (fs.length < 2 ? 1 : Math.max((fs[fs.length - 1].tUs - fs[0].tUs) / 1e6, 1e-6)) : win;
  return computeMessages(fs, def, denom, now);
}

describe('createMessageModel — incremental grouping', () => {
  test('rebuild matches computeMessages from scratch', () => {
    const frames: CanFrame[] = [];
    for (let n = 0; n < 30; n++) frames.push(cf(n, [n % 4, n & 0xff]));
    const ring = ringOf(frames);
    const got = createMessageModel().sync(ring, sel, forcedByte0, 0, 29 * US);
    expect(bare(got)).toEqual(bare(reference(ring, forcedByte0, 0, 29 * US)));
    expect(got.map((r) => r.mux)).toEqual([0, 1, 2, 3]);
  });

  test('incremental append ≡ from-scratch ≡ computeMessages (the core guarantee)', () => {
    const all: CanFrame[] = [];
    for (let n = 0; n < 40; n++) all.push(cf(n, [n % 3, n & 0xff]));

    // Two batches → exercises the append path on the second sync.
    const ring = new RawFrameRing(1000);
    const model = createMessageModel();
    ring.pushMany(all.slice(0, 20));
    model.sync(ring, sel, forcedByte0, 0, 19 * US);
    ring.pushMany(all.slice(20));
    const incremental = model.sync(ring, sel, forcedByte0, 0, 39 * US);

    const fromScratch = createMessageModel().sync(ringOf(all), sel, forcedByte0, 0, 39 * US);

    expect(bare(incremental)).toEqual(bare(fromScratch));
    expect(bare(incremental)).toEqual(bare(reference(ringOf(all), forcedByte0, 0, 39 * US)));
    // Cumulative counts: 40 frames over 3 mux values → 14/13/13.
    expect(incremental.map((r) => r.count)).toEqual([14, 13, 13]);
  });

  test('windowed rate from buckets: frames in the last W seconds / W', () => {
    // mux 0x05 once per second for 10 s; window = 5 s, now = 9 s.
    const frames: CanFrame[] = [];
    for (let n = 0; n < 10; n++) frames.push(cf(n, [0x05]));
    const got = createMessageModel().sync(ringOf(frames), sel, forcedByte0, 5, 9 * US);
    expect(got[0].mux).toBe(5);
    // Seconds 5..9 carry one frame each → 5 frames / 5 s = 1 fps.
    expect(got[0].rate).toBeCloseTo(1, 5);
  });

  test('a reconnect (ring.clear) rebuilds — no stale groups', () => {
    const ring = ringOf([cf(0, [5]), cf(1, [5])]);
    const model = createMessageModel();
    const before = model.sync(ring, sel, forcedByte0, 0, 1 * US);
    expect(before.map((r) => r.mux)).toEqual([5]);

    ring.clear();
    ring.pushMany([cf(2, [7]), cf(3, [7])]);
    const after = model.sync(ring, sel, forcedByte0, 0, 3 * US);
    expect(after.map((r) => r.mux)).toEqual([7]); // not the stale 5
    expect(after[0].count).toBe(2);
  });

  test('returns [] when nothing is selected', () => {
    const ring = ringOf([cf(0, [1])]);
    expect(createMessageModel().sync(ring, null, undefined, 0, 0)).toEqual([]);
  });

  // ── the Auto-detection path (no FrameDef) — the gap the cache could open ──────
  test('AUTO path: incremental ≡ computeMessages (detection is not forced)', () => {
    // byte0 = key (n%4) with byte1 = key*0x10 depending on it → Auto detects the
    // byte-0 sub-field consistently on the partial AND full history (no drift).
    const all: CanFrame[] = [];
    for (let n = 0; n < 40; n++) all.push(cf(n, [n % 4, (n % 4) * 0x10]));

    const ring = new RawFrameRing(1000);
    const model = createMessageModel();
    ring.pushMany(all.slice(0, 20));
    model.sync(ring, sel, undefined, 0, 19 * US); // undefined def → Auto
    ring.pushMany(all.slice(20));
    const got = model.sync(ring, sel, undefined, 0, 39 * US);

    expect(bare(got)).toEqual(bare(reference(ring, undefined, 0, 39 * US)));
    expect(got.map((r) => r.mux)).toEqual([0, 1, 2, 3]);
  });

  test('AUTO path: a discriminator that only emerges later is ADOPTED (no stale field)', () => {
    // Batch 1: byte0/byte1 constant → Auto finds nothing → one message.
    // Batch 2: byte0 starts cycling and byte1 depends on it → a real discriminator
    // emerges. The growth-triggered re-detection must adopt it and split the list,
    // matching computeMessages over the full history (the stale-field gap closed).
    const ring = new RawFrameRing(1000);
    const model = createMessageModel();
    const b1: CanFrame[] = [];
    for (let n = 0; n < 20; n++) b1.push(cf(n, [0x00, 0x00]));
    ring.pushMany(b1);
    const before = model.sync(ring, sel, undefined, 0, 19 * US);
    expect(before.map((r) => r.mux)).toEqual([null]); // no discriminator yet

    const b2: CanFrame[] = [];
    for (let n = 20; n < 40; n++) b2.push(cf(n, [n % 4, (n % 4) * 0x10]));
    ring.pushMany(b2);
    const after = model.sync(ring, sel, undefined, 0, 39 * US);

    expect(after.map((r) => r.mux)).toEqual([0, 1, 2, 3]); // adopted, not stuck on null
    expect(bare(after)).toEqual(bare(reference(ring, undefined, 0, 39 * US)));
  });
});

describe('RawFrameRing.since — incremental cursor', () => {
  test('returns frames pushed since the cursor, advancing it', () => {
    const r = new RawFrameRing(1000);
    r.pushMany([cf(0, [1]), cf(1, [2])]);
    const a = r.since(0, 0x100);
    expect(a.frames.length).toBe(2);
    expect(a.lapped).toBe(false);
    expect(a.seq).toBe(2);

    r.push(cf(2, [3]));
    const b = r.since(a.seq, 0x100);
    expect(b.frames.map((f) => f.data[0])).toEqual([3]);
    expect(b.seq).toBe(3);
  });

  test('reports lapped when the cursor has fallen off the back', () => {
    const small = new RawFrameRing(4);
    small.pushMany([cf(0, [0]), cf(1, [1]), cf(2, [2]), cf(3, [3])]);
    expect(small.since(0, 0x100).lapped).toBe(false); // still all present
    small.pushMany([cf(4, [4]), cf(5, [5])]); // wraps past index 0..1
    expect(small.since(0, 0x100).lapped).toBe(true);
  });

  test('filters by id', () => {
    const r = new RawFrameRing(1000);
    r.push(cf(0, [1], 0x100));
    r.push(cf(1, [2], 0x200));
    expect(r.since(0, 0x100).frames.length).toBe(1);
  });
});
