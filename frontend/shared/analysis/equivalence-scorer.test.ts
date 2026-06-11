// Unit tests for the EQUIVALENCE / RETURN scorer (analysis/equivalence-scorer.ts).
//
// node:test + node:assert/strict, run with `node --test --experimental-strip-types`.
// Deterministic. The scorer answers "which field held the same value at X and Y
// but moved in between?". Tests pin:
//   #1 a field that ramps away and RETURNS is found (high returnScore);
//   #2 a field that moved away but did NOT come back is rejected (low closeness);
//   #3 a CONSTANT field is rejected (no movement, trivial equality);
//   #4 an excluded slot is not surfaced;
//   #5 an unstable (jittery) endpoint is rejected by the stable-level gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreEquivalence, type TimedFrame } from './equivalence-scorer.ts';

const S = 1e6; // µs per second

/**
 * Build a 20 Hz stream of one id over [t0, t1] seconds, byte index 1 set by
 * `b1(t)`; byte 0 fixed at 0 so the field at byte 1 is the only mover.
 */
function stream(id: number, t0: number, t1: number, b1: (tSec: number) => number): TimedFrame[] {
  const out: TimedFrame[] = [];
  const periodUs = 50_000; // 20 fps
  for (let t = t0 * S; t <= t1 * S; t += periodUs) {
    out.push({ id, tUs: t, data: [0x00, b1(t / S) & 0xff] });
  }
  return out;
}

test('#1 a field that leaves its level and RETURNS is found with a high score', () => {
  // X (0–3s): byte1 ≈ 10. Between (3–7s): ramps up to ~200 then back. Y (7–10s): ≈ 10.
  const x = stream(0x200, 0, 3, () => 10);
  const between = stream(0x200, 3, 7, (t) => 10 + 190 * Math.sin(((t - 3) / 4) * Math.PI)); // 10 → ~200 → 10
  const y = stream(0x200, 7, 10, () => 10);

  const res = scoreEquivalence(x, y, between);
  assert.ok(res.candidates.length >= 1, 'expected a candidate');
  const top = res.candidates.find((c) => c.byteIndex === 1 && c.width === 8);
  assert.ok(top, 'byte1 u8 should surface');
  assert.equal(top!.id, 0x200);
  assert.equal(top!.medianX, 10);
  assert.equal(top!.medianY, 10);
  assert.ok(top!.levelDelta < 0.05, 'returned to ~the same value');
  assert.ok(top!.movement > 0.5, 'it travelled most of its range between');
  assert.ok(top!.score > 0.5, `strong return (got ${top!.score.toFixed(2)})`);
});

test('#2 a field that moved away but did NOT return is rejected (low closeness)', () => {
  // X ≈ 10, ramps up, and STAYS at ~200 in Y → big level delta → closeness ≈ 0.
  const x = stream(0x201, 0, 3, () => 10);
  const between = stream(0x201, 3, 7, (t) => 10 + 47.5 * (t - 3)); // 10 → 200 ramp
  const y = stream(0x201, 7, 10, () => 200);

  const res = scoreEquivalence(x, y, between);
  const c = res.candidates.find((x) => x.byteIndex === 1 && x.width === 8);
  assert.equal(c, undefined, 'did not return to its X value → not an equivalence');
});

test('#3 a CONSTANT field is rejected (no movement → trivial equality)', () => {
  // Equal at X and Y, but never moved between → movement ≈ 0 → score ≈ 0.
  const x = stream(0x202, 0, 3, () => 42);
  const between = stream(0x202, 3, 7, () => 42);
  const y = stream(0x202, 7, 10, () => 42);

  const res = scoreEquivalence(x, y, between);
  const c = res.candidates.find((x) => x.byteIndex === 1 && x.width === 8);
  assert.equal(c, undefined, 'constant byte is equal only trivially');
});

test('#4 an excluded slot is not surfaced', () => {
  const x = stream(0x200, 0, 3, () => 10);
  const between = stream(0x200, 3, 7, (t) => 10 + 190 * Math.sin(((t - 3) / 4) * Math.PI));
  const y = stream(0x200, 7, 10, () => 10);
  // 0x200 = 512, byte 1 → "512:1".
  const res = scoreEquivalence(x, y, between, new Set(['512:1']));
  assert.equal(res.candidates.find((c) => c.byteIndex === 1), undefined);
});

test('#5 a jittery endpoint is rejected by the stable-level gate', () => {
  // Y is not a stable level (swings across its whole range every frame) → rejected
  // even though its median happens to match X.
  const x = stream(0x203, 0, 3, () => 10);
  const between = stream(0x203, 3, 7, (t) => 10 + 190 * Math.sin(((t - 3) / 4) * Math.PI));
  let k = 0;
  const y = stream(0x203, 7, 10, () => (k++ % 2 === 0 ? 0 : 220)); // mean ~110, wild spread
  const res = scoreEquivalence(x, y, between);
  const c = res.candidates.find((x) => x.byteIndex === 1 && x.width === 8);
  assert.equal(c, undefined, 'unstable endpoint is not a steady "same value"');
});
