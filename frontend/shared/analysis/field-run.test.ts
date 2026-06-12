// Unit tests for the MARKHUNT field-run analyzer (analysis/field-run.ts).
//
// node:test + node:assert/strict, run with `node --test --experimental-strip-types`.
// Deterministic. The analyzer dispatches each span TYPE to the matching scorer
// and merges. Tests pin:
//   #1 a rampUp span finds the field that rose during it (trend question);
//   #2 an event span finds a bit flipping in phase with the onset;
//   #3 an ≈ pair finds a field that left and returned;
//   #4 a candidate that also moves in a STABLE span fails the control;
//   #5 a run with no analyzable spans → empty + a note.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeFieldRun, type FieldRunInput } from './field-run.ts';
import type { TimedFrame } from './event-scorer.ts';

const S = 1e6; // µs per second

/** 20 Hz stream of one id over [t0,t1]s; byte0 = b0(t), byte1 = b1(t). */
function stream(
  id: number,
  t0: number,
  t1: number,
  b0: (tSec: number, n: number) => number,
  b1: (tSec: number, n: number) => number = () => 0,
): TimedFrame[] {
  const out: TimedFrame[] = [];
  const periodUs = 50_000;
  let n = 0;
  for (let t = t0 * S; t <= t1 * S; t += periodUs, n++) {
    out.push({ id, tUs: t, data: [b0(t / S, n) & 0xff, b1(t / S, n) & 0xff] });
  }
  return out;
}

test('#1 a rampUp span finds the field that rose during it', () => {
  // Stable 0–5s (byte0=10), ramp 5–10s (byte0: 10→250).
  const frames = [
    ...stream(0x300, 0, 5, () => 10),
    ...stream(0x300, 5, 10, (t) => 10 + 48 * (t - 5)),
  ];
  const input: FieldRunInput = {
    spans: [
      { id: 'a', startTUs: 0, endTUs: 5 * S, type: 'stable' },
      { id: 'b', startTUs: 5 * S, endTUs: 10 * S, type: 'rampUp' },
    ],
  };
  const res = analyzeFieldRun(input, frames);
  assert.ok(res.questionsRun.includes('trend up'));
  const top = res.candidates.find((c) => c.id === 0x300 && c.byteIndex === 0);
  assert.ok(top, 'the ramping byte is found');
  assert.equal(top!.passesControl, true, 'it was flat during the stable span');
});

test('#2 an event span finds a bit flipping in phase with the onset', () => {
  // bit1 of byte1 = 1 only during the two event spans; quiet (0) elsewhere.
  const ev = (t: number) => ((t >= 5 && t < 6) || (t >= 8 && t < 9) ? 0x02 : 0x00);
  const frames = stream(0x301, 0, 12, () => 0, (t) => ev(t));
  const input: FieldRunInput = {
    spans: [
      { id: 'base', startTUs: 0, endTUs: 4 * S, type: 'stable' },
      { id: 'e1', startTUs: 5 * S, endTUs: 6 * S, type: 'event' },
      { id: 'e2', startTUs: 8 * S, endTUs: 9 * S, type: 'event' },
    ],
  };
  const res = analyzeFieldRun(input, frames);
  assert.ok(res.questionsRun.includes('event'));
  const c = res.candidates.find((x) => x.id === 0x301 && x.byteIndex === 1 && x.bit === 1);
  assert.ok(c, 'the in-phase bit is found');
  assert.equal(c!.passesControl, true);
});

test('#3 an ≈ pair finds a field that left and returned', () => {
  // byte0 ≈ 10 in span x and span y, ramps to ~200 and back in between.
  const frames = [
    ...stream(0x302, 0, 3, () => 10),
    ...stream(0x302, 3, 7, (t) => 10 + 190 * Math.sin(((t - 3) / 4) * Math.PI)),
    ...stream(0x302, 7, 10, () => 10),
  ];
  const input: FieldRunInput = {
    spans: [
      { id: 'x', startTUs: 0, endTUs: 3 * S, type: 'stable', equivalentTo: ['y'] },
      { id: 'y', startTUs: 7 * S, endTUs: 10 * S, type: 'stable' },
    ],
  };
  const res = analyzeFieldRun(input, frames);
  assert.ok(res.questionsRun.includes('≈ equivalence'));
  const c = res.candidates.find((x) => x.id === 0x302 && x.byteIndex === 0 && x.width === 8);
  assert.ok(c, 'the return field is found');
  assert.ok(c!.sources.includes('≈ equivalence'));
});

test('#4 a candidate that also moves in a STABLE span fails the control', () => {
  // byte0 ramps during the ramp span AND jitters every frame during the stable
  // span → surfaced by the trend question but confounded by the control.
  const frames = [
    ...stream(0x303, 0, 5, (_t, n) => (n % 2) * 200), // jitter in "stable"
    ...stream(0x303, 5, 10, (t) => 10 + 48 * (t - 5)),
  ];
  const input: FieldRunInput = {
    spans: [
      { id: 'a', startTUs: 0, endTUs: 5 * S, type: 'stable' },
      { id: 'b', startTUs: 5 * S, endTUs: 10 * S, type: 'rampUp' },
    ],
  };
  const res = analyzeFieldRun(input, frames);
  const c = res.candidates.find((x) => x.id === 0x303 && x.byteIndex === 0);
  if (c) {
    assert.equal(c.passesControl, false, 'it moves during the stable span → confounded');
    assert.ok(c.noiseResponse > 0.4);
  }
  // Either way, nothing clean cleared the control → honest note.
  assert.match(res.note, /control/);
});

test('#5 a run with no analyzable spans → empty + a note', () => {
  const frames = stream(0x304, 0, 10, () => 42);
  const input: FieldRunInput = {
    spans: [{ id: 'a', startTUs: 0, endTUs: 10 * S, type: 'ignore' }],
  };
  const res = analyzeFieldRun(input, frames);
  assert.equal(res.candidates.length, 0);
  assert.match(res.note, /no analyzable spans/);
});
