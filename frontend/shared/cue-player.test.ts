// Unit tests for the Wizard CUE SCHEDULE (cue-player.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as protocol.test.ts
// / analysis/*.test.ts) — zero deps.
//
// The load-bearing assertion is that the schedule's end time equals
// cueTotalMs(preset) from cue-config.ts: every connected device times its
// action/feedback window off that number, so a drift here desyncs the cue from
// the scoring guard. We pin it for BOTH shipped presets, plus the beep count,
// the high/low freqs & durations, the inter-beep gaps, and the 0-based onsets.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CUE_PRESETS, cueTotalMs, type CueMode, type CuePreset } from './cue-config.ts';
import { buildCueSchedule, type Beep } from './cue-player.ts';

const MODES: CueMode[] = ['during', 'after'];

// Split a schedule into its high lead-in beeps and the single low beep, while
// pinning that the low beep is exactly the last one and there is exactly one.
function partition(beeps: Beep[]): { highs: Beep[]; low: Beep } {
  const lows = beeps.filter((b) => b.kind === 'lo');
  assert.equal(lows.length, 1, 'exactly one low beep');
  const low = beeps[beeps.length - 1];
  assert.equal(low.kind, 'lo', 'the low beep is last in onset order');
  return { highs: beeps.filter((b) => b.kind === 'hi'), low };
}

for (const mode of MODES) {
  const preset: CuePreset = CUE_PRESETS[mode];

  test(`[${mode}] beep count is high.count + 1`, () => {
    const beeps = buildCueSchedule(preset);
    assert.equal(beeps.length, preset.high.count + 1);
  });

  test(`[${mode}] N high beeps then the low beep, in onset order`, () => {
    const beeps = buildCueSchedule(preset);
    const kinds = beeps.map((b) => b.kind);
    assert.deepEqual(kinds, [...Array(preset.high.count).fill('hi'), 'lo']);
    // onsets are non-decreasing and start at 0
    assert.equal(beeps[0].atMs, 0, 'first beep starts at 0');
    for (let i = 1; i < beeps.length; i++) {
      assert.ok(beeps[i].atMs > beeps[i - 1].atMs, `beep ${i} starts after beep ${i - 1}`);
    }
  });

  test(`[${mode}] high beeps carry the preset high freq & duration`, () => {
    const { highs } = partition(buildCueSchedule(preset));
    assert.equal(highs.length, preset.high.count);
    for (const h of highs) {
      assert.equal(h.freq, preset.high.hz, 'high freq matches preset');
      assert.equal(h.durMs, preset.high.durationMs, 'high duration matches preset');
    }
  });

  test(`[${mode}] low beep carries the preset low freq & duration`, () => {
    const { low } = partition(buildCueSchedule(preset));
    assert.equal(low.freq, preset.low.hz, 'low freq matches preset');
    assert.equal(low.durMs, preset.low.durationMs, 'low duration matches preset');
  });

  test(`[${mode}] gaps between onsets are durationMs + gapMs`, () => {
    const beeps = buildCueSchedule(preset);
    const step = preset.high.durationMs + preset.gapMs;
    // Each high beep is one (high.durationMs + gapMs) after the previous one,
    // and the low beep is one step after the LAST high beep's onset too.
    for (let i = 1; i < beeps.length; i++) {
      assert.equal(beeps[i].atMs - beeps[i - 1].atMs, step, `step before beep ${i}`);
    }
    // Spelled out from t=0 for clarity.
    for (let i = 0; i < beeps.length; i++) {
      assert.equal(beeps[i].atMs, i * step, `beep ${i} onset`);
    }
  });

  test(`[${mode}] schedule end time equals cueTotalMs(preset)`, () => {
    const beeps = buildCueSchedule(preset);
    const last = beeps[beeps.length - 1];
    assert.equal(last.atMs + last.durMs, cueTotalMs(preset));
  });

  test(`[${mode}] builder is pure: fresh array, no preset mutation`, () => {
    const before = structuredClone(preset);
    const a = buildCueSchedule(preset);
    const b = buildCueSchedule(preset);
    assert.notEqual(a, b, 'allocates a fresh array each call');
    assert.deepEqual(a, b, 'deterministic output');
    assert.deepEqual(preset, before, 'preset is not mutated');
  });
}

// Concrete pin so a refactor that "still passes the formula" but changes the
// shipped numbers is caught: during = 3*(90+233)+1000, after = 3*(90+233)+333.
test('concrete schedule totals match the shipped presets', () => {
  assert.equal(cueTotalMs(CUE_PRESETS.during), 1969);
  assert.equal(cueTotalMs(CUE_PRESETS.after), 1302);
  assert.deepEqual(
    buildCueSchedule(CUE_PRESETS.during).map((b) => b.atMs),
    [0, 323, 646, 969],
  );
  assert.deepEqual(
    buildCueSchedule(CUE_PRESETS.after).map((b) => b.atMs),
    [0, 323, 646, 969],
  );
});
