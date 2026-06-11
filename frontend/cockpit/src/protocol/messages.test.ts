/**
 * Tests for the CUMULATIVE per-frame observed-mux model (computeMessages).
 *
 * The model used to group only a rolling window of frames, so a rare mux value
 * dropped out of the list once it aged past the window. The cumulative model
 * instead derives the row set from the FULL buffered history (every mux value
 * seen since connect PERSISTS), while the per-message RATE is still computed over
 * the user's selected window and `lastTUs` drives a growing "Last" age.
 *
 * These tests pin: (1) a rare mux seen ONCE stays listed after the rate window
 * elapses; (2) its rate decays to 0 while a still-active mux keeps a real rate;
 * (3) its last-seen age grows; plus the cumulative count and the no-mux single
 * message. Run with vitest (`npm run test`).
 */

import { describe, test, expect } from 'vitest';
import type { FrameView } from '../state/ringBuffer';
import type { FrameDef } from './datamodel';
import { computeMessages } from './messages';

const US = 1e6; // µs per second

/** Build a minimal FrameView; computeMessages only reads tUs / data / dlc. */
function frame(tSec: number, bytes: number[]): FrameView {
  return {
    tUs: tSec * US,
    id: 0x100,
    isExtended: false,
    isError: false,
    isRtr: false,
    dlc: bytes.length,
    data: Uint8Array.from(bytes),
  };
}

/** Force byte 0 as the discriminator (a Forced multiplexor at byte 0). */
const forcedByte0: FrameDef = {
  id: 0x100,
  isExtended: false,
  name: '0x100',
  signals: [
    {
      id: 's0',
      frameId: 0x100,
      isExtended: false,
      name: 'message_id',
      bitStart: 0,
      bitLength: 8,
      byteOrder: 'little',
      isMultiplexor: true,
    },
  ],
} as unknown as FrameDef;

describe('computeMessages — cumulative observed-mux model', () => {
  test('a rare mux value seen ONCE stays listed after the rate window elapses', () => {
    const win = 10;
    // mux 0x01: a steady stream. mux 0x02: seen exactly once, early (t=1s).
    const frames: FrameView[] = [frame(1, [0x02, 0xaa])];
    for (let t = 1; t <= 30; t++) frames.push(frame(t, [0x01, t & 0xff]));

    // "now" = 30s. The rare 0x02 (last seen at 1s) is 29s old — far past the 10s
    // rate window — yet it must still appear as a row.
    const rows = computeMessages(frames, forcedByte0, win, 30 * US);
    const muxes = rows.map((r) => r.mux);
    expect(muxes).toContain(0x02);
    expect(muxes).toContain(0x01);

    const rare = rows.find((r) => r.mux === 0x02)!;
    // Out of the rate window → rate decayed to 0, but the cumulative count holds.
    expect(rare.rate).toBe(0);
    expect(rare.count).toBe(1);
  });

  test('rate decays to 0 for an aged-out mux while an active mux keeps a real rate', () => {
    const win = 10;
    const frames: FrameView[] = [frame(0.5, [0x02, 0xaa])];
    // 0x01 at 1 Hz for the whole 30s span.
    for (let t = 1; t <= 30; t++) frames.push(frame(t, [0x01, 0x00]));

    const rows = computeMessages(frames, forcedByte0, win, 30 * US);
    const active = rows.find((r) => r.mux === 0x01)!;
    const rare = rows.find((r) => r.mux === 0x02)!;

    // 0x01: ~1 frame/s within the last 10s window → ~1 fps.
    expect(active.rate).toBeGreaterThan(0.5);
    expect(active.rate).toBeLessThanOrEqual(1.1);
    // 0x02: nothing in the last 10s → rate 0.
    expect(rare.rate).toBe(0);
  });

  test('last-seen age grows: lastTUs is the cumulative most-recent time per mux', () => {
    const frames: FrameView[] = [
      frame(1, [0x02, 0x01]), // 0x02 last seen at t=1s
      frame(2, [0x01, 0x00]),
      frame(40, [0x01, 0x00]), // 0x01 last seen at t=40s
    ];
    const now = 40 * US;
    const rows = computeMessages(frames, forcedByte0, 10, now);

    const rare = rows.find((r) => r.mux === 0x02)!;
    const active = rows.find((r) => r.mux === 0x01)!;
    expect(rare.lastTUs).toBe(1 * US);
    expect(active.lastTUs).toBe(40 * US);
    // The UI computes age = (now - lastTUs); the rare mux is ~39s old, far older
    // than the active one — i.e. visibly stale rather than gone.
    const rareAge = (now - rare.lastTUs) / US;
    const activeAge = (now - active.lastTUs) / US;
    expect(rareAge).toBeCloseTo(39, 5);
    expect(rareAge).toBeGreaterThan(activeAge);
  });

  test('cumulative count includes frames older than the rate window', () => {
    const win = 5;
    const frames: FrameView[] = [];
    // 0x03 seen 4× spread across 20s, only one of them inside the last 5s.
    frames.push(frame(1, [0x03]));
    frames.push(frame(5, [0x03]));
    frames.push(frame(12, [0x03]));
    frames.push(frame(20, [0x03]));
    const rows = computeMessages(frames, forcedByte0, win, 20 * US);
    const g = rows.find((r) => r.mux === 0x03)!;
    expect(g.count).toBe(4); // cumulative: all four
    // Only the t=20 frame is within [15, 20] → 1 frame / 5s = 0.2 fps.
    expect(g.rate).toBeCloseTo(0.2, 5);
  });

  test('latest payload is the newest frame in the group, not the windowed one', () => {
    const frames: FrameView[] = [
      frame(1, [0x02, 0x11]),
      frame(2, [0x02, 0x22]),
      frame(3, [0x02, 0x33]), // newest for 0x02
    ];
    const rows = computeMessages(frames, forcedByte0, 10, 3 * US);
    const g = rows.find((r) => r.mux === 0x02)!;
    expect(Array.from(g.data)).toEqual([0x02, 0x33]);
  });

  test('no effective discriminator → one cumulative single message (mux null)', () => {
    // None mode: one row representing the frame itself, cumulative count.
    const noneDef: FrameDef = {
      id: 0x100,
      isExtended: false,
      name: '0x100',
      signals: [],
      messageIdAuto: false,
    } as unknown as FrameDef;
    const frames: FrameView[] = [];
    for (let t = 1; t <= 12; t++) frames.push(frame(t, [t & 0xff]));

    const rows = computeMessages(frames, noneDef, 10, 12 * US);
    expect(rows).toHaveLength(1);
    expect(rows[0].mux).toBeNull();
    expect(rows[0].count).toBe(12); // cumulative
    // 10s window over a 1 Hz stream → ~10 frames / 10s ≈ 1 fps.
    expect(rows[0].rate).toBeGreaterThan(0.5);
    expect(rows[0].rate).toBeLessThanOrEqual(1.1);
    // Latest payload = newest frame.
    expect(Array.from(rows[0].data)).toEqual([12]);
  });

  test('rows are sorted by mux value ascending (stable, value order never moves)', () => {
    const frames: FrameView[] = [
      frame(1, [0x05]),
      frame(2, [0x01]),
      frame(3, [0x03]),
      frame(4, [0x05]),
    ];
    const rows = computeMessages(frames, forcedByte0, 10, 4 * US);
    expect(rows.map((r) => r.mux)).toEqual([0x01, 0x03, 0x05]);
  });

  test('nowTUs defaults to the newest frame (rate over the observed span)', () => {
    const frames: FrameView[] = [];
    for (let t = 0; t < 10; t++) frames.push(frame(t, [0x07]));
    // No nowTUs, window = observed span (9s) → all 10 frames counted.
    const span = 9;
    const rows = computeMessages(frames, forcedByte0, span);
    const g = rows.find((r) => r.mux === 0x07)!;
    expect(g.count).toBe(10);
    expect(g.rate).toBeCloseTo(10 / span, 5);
  });
});

describe('computeMessages — auto sub-byte discriminator detection', () => {
  test('detects a SUB-BYTE discriminator, excluding constant bits from the value', () => {
    // byte0 = 0x80 | (n % 4): bit7 constant 1, bits 0-1 cycle a 4-value enum,
    // bits 2-6 constant 0. byte1 = key * 0x10 → the payload DEPENDS on the field
    // (a real multiplexor), so the predictive gate accepts it. No FrameDef → Auto.
    const frames: FrameView[] = [];
    for (let n = 0; n < 24; n++) frames.push(frame(n, [0x80 | (n % 4), (n % 4) * 0x10]));

    const rows = computeMessages(frames, undefined, 30, 24 * US);
    // The discriminator is the 2-bit sub-field, so the constant bit7 (0x80) is
    // NOT part of the value: mux reads 0..3, not 0x80..0x83.
    expect(rows.map((r) => r.mux)).toEqual([0, 1, 2, 3]);
    // Field lives in byte 0 and is 2 bits wide (1 hex digit).
    expect(rows[0].idBytes).toEqual([0]);
    expect(rows[0].idHexWidth).toBe(1);
  });

  test('ignores a constant leading byte and finds the discriminator further right', () => {
    // byte0 = 0x00 always (constant padding), byte1 = a 3-value enum key, byte2 =
    // key * 0x10 (payload depends on the key). Auto skips constant byte0, picks byte1.
    const frames: FrameView[] = [];
    for (let n = 0; n < 24; n++) frames.push(frame(n, [0x00, n % 3, (n % 3) * 0x10]));

    const rows = computeMessages(frames, undefined, 30, 24 * US);
    expect(rows.map((r) => r.mux)).toEqual([0, 1, 2]);
    // Discriminator is byte 1, not the constant byte 0.
    expect(rows[0].idBytes).toEqual([1]);
  });

  test('finds no discriminator when every byte is constant or analog → single message', () => {
    // byte0 constant; byte1 a wide pseudo-analog spread (too many distinct → not
    // a small enum, not a constant-step counter). Nothing qualifies → one message.
    const frames: FrameView[] = [];
    for (let n = 0; n < 24; n++) frames.push(frame(n, [0xff, (n * 37) & 0xff]));

    const rows = computeMessages(frames, undefined, 30, 24 * US);
    expect(rows).toHaveLength(1);
    expect(rows[0].mux).toBeNull();
  });

  test('rejects a low-cardinality STATUS byte whose payload is independent (predictive gate)', () => {
    // byte0 = n%4 (a 4-value status, e.g. a gear) — looks like a discriminator by
    // cardinality alone. byte1 = ARR[n%15] (15 values, period coprime to 4 ⇒
    // INDEPENDENT of byte0). Pre-2.5 byte0 would have split the list; the
    // predictive gate sees the payload doesn't depend on it → no split.
    const ARR = [0x10, 0x23, 0x4a, 0x05, 0xf1, 0x88, 0x3c, 0x67, 0xb2, 0x09, 0xde, 0x71, 0x55, 0xa0, 0x2e];
    const frames: FrameView[] = [];
    for (let n = 0; n < 60; n++) frames.push(frame(n, [n % 4, ARR[n % 15]]));

    const rows = computeMessages(frames, undefined, 30, 60 * US);
    expect(rows).toHaveLength(1);
    expect(rows[0].mux).toBeNull();
  });
});
