// Unit tests for the LOGBOOK run analyzer (analysis/logbook.ts).
//
// node:test + node:assert/strict, run with `node --test --experimental-strip-types`.
// Deterministic. The analyzer maps a storyboard run → runExperiment (positive
// evidence) + a baseline/noise NEGATIVE control. Tests pin:
//   #1 a clean target (a bit flipping in phase with the stimulus, quiet in noise)
//      is found and PASSES the control;
//   #2 the SAME flip but also TOGGLING during noise → found, but FAILS the control;
//   #3 a known-excluded slot is not surfaced;
//   #4 a run with no stimulus window → 'none' + a note.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRun, type LogbookRun, type RunWindow } from './logbook.ts';
import type { TimedFrame } from './event-scorer.ts';

const S = 1e6; // µs per second

// Standard skeleton windows: baseline 0–20 · noise 20–50 · wait 50–55 ·
// [stimulus 3s → observe 5s] ×3 · recover.
const WINDOWS: RunWindow[] = [
  { role: 'baseline', startTUs: 0, endTUs: 20 * S },
  { role: 'noise', startTUs: 20 * S, endTUs: 50 * S },
  { role: 'wait', startTUs: 50 * S, endTUs: 55 * S },
  { role: 'stimulus', startTUs: 55 * S, endTUs: 58 * S, rep: 1 },
  { role: 'observe', startTUs: 58 * S, endTUs: 63 * S, rep: 1 },
  { role: 'stimulus', startTUs: 63 * S, endTUs: 66 * S, rep: 2 },
  { role: 'observe', startTUs: 66 * S, endTUs: 71 * S, rep: 2 },
  { role: 'stimulus', startTUs: 71 * S, endTUs: 74 * S, rep: 3 },
  { role: 'observe', startTUs: 74 * S, endTUs: 79 * S, rep: 3 },
  { role: 'recover', startTUs: 79 * S, endTUs: 89 * S },
];
const run: LogbookRun = { windows: WINDOWS, stimulusKind: 'event' };

const inStim = (t: number) => WINDOWS.some((w) => w.role === 'stimulus' && t >= w.startTUs && t <= w.endTUs);
const inNoise = (t: number) => t >= 20 * S && t <= 50 * S;

/** A 20 Hz stream for one id over the whole run; `byte2(t,n)` sets byte index 2. */
function stream(id: number, byte2: (t: number, n: number) => number): TimedFrame[] {
  const out: TimedFrame[] = [];
  const periodUs = 50_000; // 20 fps
  for (let n = 0; n * periodUs <= 89 * S; n++) {
    const t = n * periodUs;
    out.push({ id, tUs: t, data: [0x00, 0x00, byte2(t, n)] });
  }
  return out;
}

test('#1 a clean stimulus-locked bit is found and PASSES the noise control', () => {
  // 0x100 byte2 bit1 = 1 only during the stimulus windows (quiet everywhere else).
  const frames = stream(0x100, (t) => (inStim(t) ? 0x02 : 0x00));
  const res = analyzeRun(run, frames);

  assert.equal(res.mode, 'event');
  assert.ok(res.candidates.length >= 1, 'expected a candidate');
  const top = res.candidates[0];
  assert.equal(top.id, 0x100);
  assert.equal(top.byteIndex, 2);
  assert.equal(top.event?.bit, 1);
  assert.equal(top.passesControl, true);
  assert.ok(top.noiseResponse < 0.1, 'the bit is quiet during noise');
  assert.equal(top.type, 'pulse', 'on during stimulus, back to rest in observe → pulse');
  assert.equal(top.significant, true, 'quiet off-stimulus → not a coincidence');
  assert.equal(res.note, '');
});

const inObserve = (t: number) => WINDOWS.some((w) => w.role === 'observe' && t >= w.startTUs && t <= w.endTUs);

test('#5 a LATCHED response (stays on through observe, reset before the next rep) is typed level', () => {
  // bit = 1 during stimulus AND most of observe (latched), but RESET to 0 in the
  // last 600 ms of each observe — so each rep still presents a fresh 0→1 flip
  // (a real latch must be reset between trials, else only the first flash flips).
  const resetTail = (t: number) =>
    WINDOWS.some((w) => w.role === 'observe' && t >= w.endTUs - 0.6 * S && t <= w.endTUs);
  const frames = stream(0x100, (t) => (inStim(t) || (inObserve(t) && !resetTail(t)) ? 0x02 : 0x00));
  const top = analyzeRun(run, frames).candidates[0];
  assert.equal(top.id, 0x100);
  assert.equal(top.type, 'level');
  assert.equal(top.passesControl, true);
  assert.equal(top.significant, true);
});

test('#6 a bit that is mostly ON off-stimulus FAILS the chance gate (low-rep coincidence)', () => {
  // bit = 1 almost always, dipping to 0 only in the 600 ms before each onset (so
  // the event-scorer still sees a 0→1 flip), then 1 during the stimulus. It is
  // quiet in noise (passes the control) but matches the action value ~always
  // off-stimulus → p≈1 → p^3 ≈ 1 ≥ alpha → NOT significant.
  const onsets = [55 * S, 63 * S, 71 * S];
  const dip = (t: number) => onsets.some((o) => t >= o - 0.6 * S && t < o);
  const frames = stream(0x100, (t) => (dip(t) ? 0x00 : 0x02));
  const res = analyzeRun(run, frames);
  const c = res.candidates.find((x) => x.id === 0x100 && x.byteIndex === 2);
  assert.ok(c, 'still surfaced (it does flip 0→1 at each onset)');
  assert.equal(c!.passesControl, true, 'constant during noise → passes the noise control');
  assert.equal(c!.significant, false, 'but mostly-on off-stimulus → could be chance');
  assert.ok(c!.chanceLevel > 0.5, 'high coincidence probability');
  assert.match(res.note, /significance/);
});

test('#2 the same flip but TOGGLING during noise → found, but FAILS the control', () => {
  // Same stimulus flip, but during noise the bit alternates every frame (a
  // confounder that also moves under normal driving).
  const frames = stream(0x100, (t, n) => (inStim(t) ? 0x02 : inNoise(t) ? (n % 2) << 1 : 0x00));
  const res = analyzeRun(run, frames);

  const c = res.candidates.find((x) => x.id === 0x100 && x.byteIndex === 2);
  assert.ok(c, 'still surfaced as a stimulus-locked candidate');
  assert.equal(c!.passesControl, false, 'but it also moves during noise → rejected by the control');
  assert.ok(c!.noiseResponse > 0.4, 'high noise change rate');
  // It is the only candidate and it failed the control → honest negative note.
  assert.match(res.note, /noise control/);
});

test('#3 a known-excluded slot is not surfaced', () => {
  const frames = stream(0x100, (t) => (inStim(t) ? 0x02 : 0x00));
  // 0x100 = 256, byte index 2 → "256:2".
  const res = analyzeRun(run, frames, { excluded: ['256:2'] });
  assert.equal(res.candidates.find((x) => x.id === 0x100 && x.byteIndex === 2), undefined);
});

test('#4 a run with no stimulus window → mode none + note', () => {
  const frames = stream(0x100, (t) => (inStim(t) ? 0x02 : 0x00));
  const noStim: LogbookRun = { windows: WINDOWS.filter((w) => w.role !== 'stimulus') };
  const res = analyzeRun(noStim, frames);
  assert.equal(res.mode, 'none');
  assert.equal(res.candidates.length, 0);
  assert.match(res.note, /no stimulus/);
});
