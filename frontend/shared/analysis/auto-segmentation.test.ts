// Unit tests for the AUTO-SEGMENTATION analyzer (analysis/auto-segmentation.ts).
//
// node:test + node:assert/strict, run with `node --test --experimental-strip-types`.
// Deterministic. Test signals use VARYING steps (like a real analog value), not a
// constant step — a constant-step byte is a counter, which the tagger excludes.
//
// Pins: a multi-byte value's monotonic activity gradient yields one segment with
// the right byte order (#1 little, #2 big); two equal-activity bytes stay separate
// (#3); a constant byte breaks a run (#4); a counter byte is excluded (#5);
// floor/allow-list/defaults/purity (#6).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoSegment, AUTO_SEGMENT_DEFAULTS, type SegmentFrame } from './auto-segmentation.ts';

const ID = 0x100;

function build(count: number, mk: (n: number) => number[]): SegmentFrame[] {
  const out: SegmentFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id: ID, tUs: n * 10000, data: mk(n) });
  return out;
}

/** A 16-bit value wandering up in small VARYING steps (LSB changes every frame, MSB rarely). */
function wander16(count: number, le: boolean): SegmentFrame[] {
  let v = 0;
  return build(count, (n) => {
    v = (v + 30 + (n % 31)) & 0xffff; // step 30..60 → not a constant-step counter
    const lo = v & 0xff;
    const hi = (v >> 8) & 0xff;
    return le ? [lo, hi] : [hi, lo];
  });
}

function segsOf(frames: SegmentFrame[]) {
  const res = autoSegment(frames);
  const id = res.ids.find((x) => x.id === ID);
  assert.ok(id, 'expected a segmentation for the id');
  return id!.segments;
}

test('#1 a little-endian 16-bit value → one 2-byte segment, byteOrder little', () => {
  const segs = segsOf(wander16(600, true));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].startByte, 0);
  assert.equal(segs[0].length, 2);
  assert.equal(segs[0].byteOrder, 'little'); // activity decreases LSB→MSB
  assert.ok(segs[0].confidence > 0.5, 'a clean gradient is confident');
});

test('#2 a big-endian 16-bit value → one 2-byte segment, byteOrder big', () => {
  const segs = segsOf(wander16(600, false));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 2);
  assert.equal(segs[0].byteOrder, 'big'); // activity increases MSB→LSB
});

test('#3 two equal-activity independent bytes are NOT merged', () => {
  // Both bytes change every frame with varying steps (≈ equal activity) → no
  // gradient → kept as two separate 8-bit signals.
  let a = 0;
  let b = 0;
  const frames = build(400, (n) => {
    a = (a + 30 + (n % 31)) & 0xff;
    b = (b + 40 + (n % 17)) & 0xff;
    return [a, b];
  });
  const segs = segsOf(frames);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((s) => [s.startByte, s.length, s.byteOrder]),
    [
      [0, 1, 'unknown'],
      [1, 1, 'unknown'],
    ],
  );
});

test('#4 a constant byte breaks a run', () => {
  let a = 0;
  let c = 0;
  const frames = build(400, (n) => {
    a = (a + 30 + (n % 31)) & 0xff;
    c = (c + 40 + (n % 17)) & 0xff;
    return [a, 0x00, c]; // byte1 constant → not segmentable, splits 0 from 2
  });
  const segs = segsOf(frames);
  assert.deepEqual(
    segs.map((s) => [s.startByte, s.length]),
    [
      [0, 1],
      [2, 1],
    ],
  );
});

test('#5 a counter byte is excluded (tagger), not segmented', () => {
  // byte0 = constant-step counter → tagged & excluded. byte1 = a real varying byte.
  let b = 0;
  const frames = build(300, (n) => {
    b = (b + 30 + (n % 31)) & 0xff;
    return [n & 0xff, b];
  });
  const segs = segsOf(frames);
  assert.deepEqual(
    segs.map((s) => [s.startByte, s.length]),
    [[1, 1]],
  );
});

test('#6 minFrames floor, allow-list, defaults & purity', () => {
  assert.equal(AUTO_SEGMENT_DEFAULTS.maxBytes, 8);
  assert.equal(AUTO_SEGMENT_DEFAULTS.minFrames, 8);

  // Below the floor → dropped.
  const thin = build(4, () => [1, 2]);
  assert.equal(autoSegment(thin).idCount, 0);

  // Allow-list restricts the scan.
  const a = wander16(200, true); // id 0x100
  const other = a.map((f) => ({ ...f, id: 0x200 }));
  const res = autoSegment([...a, ...other], [0x200]);
  assert.equal(res.idCount, 1);
  assert.equal(res.ids[0].id, 0x200);

  // Purity: input not mutated.
  const frames = wander16(50, true);
  const snapshot = JSON.stringify(frames);
  autoSegment(frames);
  assert.equal(JSON.stringify(frames), snapshot);
});
