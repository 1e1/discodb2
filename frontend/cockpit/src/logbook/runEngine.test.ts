/**
 * Tests for the LOGBOOK run engine (pure state machine). Driven by tick(nowTUs) +
 * confirm(nowTUs) on the µs clock — no real timers. Pins: timer phases
 * auto-advance; "on input" phases carry NO duration — they await from ENTRY and
 * advance on confirm; windows are stamped with the right role/rep (the input
 * window is the actual entry→confirm span); stop keeps the partial window.
 */

import { describe, test, expect } from 'vitest';
import { makeScenario } from '../protocol/datamodel';
import { createRunEngine } from './runEngine';

const S = 1e6;

function smallScenario() {
  const s = makeScenario('test');
  s.baseline.durationS = 2;
  s.noise.durationS = 3;
  s.wait.durationS = 1;
  s.loop.count = 2;
  s.loop.steps = [
    { type: 'stimulus', name: 'act', durationS: 3, advance: 'input' },
    { type: 'observe', name: 'obs', durationS: 2, advance: 'timer' },
  ];
  s.recover.durationS = 2;
  return s;
}

describe('Logbook run engine', () => {
  test('timer phases auto-advance; input phases await from ENTRY and advance on confirm; windows stamp correctly', () => {
    const e = createRunEngine(smallScenario());
    e.start(0);
    expect(e.state().status).toBe('running');
    expect(e.state().phase?.type).toBe('baseline');

    e.tick(2 * S); // baseline (2s) done → noise
    expect(e.state().phase?.type).toBe('noise');
    e.tick(5 * S); // noise (3s) done → wait
    expect(e.state().phase?.type).toBe('wait');
    e.tick(6 * S); // wait (1s) done → stimulus #1 (input) ENTERS — awaits immediately (no duration)
    expect(e.state().phase?.type).toBe('stimulus');
    expect(e.state().awaitingInput).toBe(true); // awaiting from entry — Next available now

    e.tick(8 * S); // an input phase does NOT auto-advance — still awaiting
    expect(e.state().awaitingInput).toBe(true);

    e.tick(14 * S); // still awaiting, even well past its nominal durationS
    expect(e.state().phase?.type).toBe('stimulus');
    expect(e.state().awaitingInput).toBe(true);

    e.confirm(14 * S); // operator Next → observe #1
    expect(e.state().phase?.type).toBe('observe');
    e.tick(16 * S); // observe (2s) → stimulus #2
    expect(e.state().phase?.type).toBe('stimulus');
    e.tick(19 * S); // stimulus #2 duration elapsed → awaiting
    expect(e.state().awaitingInput).toBe(true);
    e.confirm(19 * S); // → observe #2
    e.tick(21 * S); // observe #2 → recover
    expect(e.state().phase?.type).toBe('recover');
    e.tick(23 * S); // recover (2s) → done
    expect(e.state().status).toBe('done');

    const { windows, stimulusKind } = e.result();
    expect(windows.map((w) => w.role)).toEqual([
      'baseline', 'noise', 'wait', 'stimulus', 'observe', 'stimulus', 'observe', 'recover',
    ]);
    expect(windows.filter((w) => w.role === 'stimulus').map((w) => w.rep)).toEqual([1, 2]);
    // The stimulus #1 window is the ACTUAL executed span [entry, confirm] = [6s, 14s]
    // — the operator entered at 6 s and confirmed at 14 s (the whole await).
    const stim1 = windows.find((w) => w.role === 'stimulus' && w.rep === 1)!;
    expect(stim1.startTUs).toBe(6 * S);
    expect(stim1.endTUs).toBe(14 * S);
    expect(stimulusKind).toBe('event'); // expectedType 'auto' → event scoring
  });

  test('stop closes the current window and halts', () => {
    const e = createRunEngine(smallScenario());
    e.start(0);
    e.tick(1 * S); // mid-baseline
    e.stop(1 * S);
    expect(e.state().status).toBe('stopped');
    const { windows } = e.result();
    expect(windows).toEqual([{ role: 'baseline', startTUs: 0, endTUs: 1 * S, rep: 0 }]);
  });

  test('a long gap fast-forwards through several due timer phases in one tick', () => {
    const e = createRunEngine(smallScenario());
    e.start(0);
    e.tick(6 * S); // baseline(2)+noise(3)+wait(1) all due → lands on stimulus #1
    expect(e.state().phase?.type).toBe('stimulus');
    expect(e.state().windows.map((w) => w.role)).toEqual(['baseline', 'noise', 'wait']);
  });
});
