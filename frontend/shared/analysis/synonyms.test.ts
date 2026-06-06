// Unit tests for cross-session SYNONYM matching (analysis/synonyms.ts).
// node:test + node:assert/strict. Two fields are synonyms when their value series
// move together (Pearson over a resampled common grid).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findSynonyms, type FieldLocator } from './synonyms.ts';
import type { TimedFrame } from './event-scorer.ts';

const MS = 1000;

/** A 10 Hz stream for one id over `count` samples; `byte0(n)` sets byte index 0. */
function stream(id: number, count: number, byte0: (n: number) => number): TimedFrame[] {
  const out: TimedFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * 100 * MS, data: [byte0(n)] });
  return out;
}

test('a redundant broadcast (same series on another id) is found as a synonym', () => {
  // 0x100 and 0x200 carry the SAME ramp; 0x300 is an unrelated pseudo-random byte.
  const ramp = (n: number) => n & 0xff;
  const frames = [
    ...stream(0x100, 200, ramp),
    ...stream(0x200, 200, ramp),
    ...stream(0x300, 200, (n) => (n * 97 + 13) & 0xff),
  ];
  const target: FieldLocator = { id: 0x100, byteIndex: 0 };
  const known: FieldLocator[] = [
    { id: 0x200, byteIndex: 0, name: 'speed_echo' },
    { id: 0x300, byteIndex: 0, name: 'random' },
  ];
  const matches = findSynonyms(frames, target, known);

  assert.equal(matches.length, 1, 'only the redundant broadcast matches');
  assert.equal(matches[0].field.id, 0x200);
  assert.equal(matches[0].field.name, 'speed_echo');
  assert.ok(matches[0].correlation > 0.99, 'identical ramps correlate ~1');
});

test('the target is never its own synonym; constant fields do not match', () => {
  const frames = [
    ...stream(0x100, 100, (n) => n & 0xff),
    ...stream(0x200, 100, () => 0x00), // constant → no variance → r = 0
  ];
  const target: FieldLocator = { id: 0x100, byteIndex: 0 };
  const matches = findSynonyms(frames, target, [
    { id: 0x100, byteIndex: 0 }, // self
    { id: 0x200, byteIndex: 0 }, // constant
  ]);
  assert.equal(matches.length, 0);
});

test('bit-level synonyms: two flags that toggle together correlate', () => {
  // bit0 of 0x100 and bit3 of 0x200 both follow the same on/off pattern.
  const onoff = (n: number) => (Math.floor(n / 10) % 2); // 0 for 10, 1 for 10, …
  const frames = [
    ...stream(0x100, 200, (n) => onoff(n)), // bit0
    ...stream(0x200, 200, (n) => onoff(n) << 3), // bit3
  ];
  const matches = findSynonyms(frames, { id: 0x100, byteIndex: 0, bit: 0 }, [
    { id: 0x200, byteIndex: 0, bit: 3, name: 'lights_status' },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].field.name, 'lights_status');
  assert.ok(matches[0].correlation > 0.99);
});

test('too little overlap → no match (guards against a flukey short window)', () => {
  const frames = [
    ...stream(0x100, 200, (n) => n & 0xff),
    ...stream(0x200, 5, (n) => n & 0xff), // only 5 samples → below minOverlap
  ];
  const matches = findSynonyms(frames, { id: 0x100, byteIndex: 0 }, [{ id: 0x200, byteIndex: 0 }]);
  assert.equal(matches.length, 0);
});
