// Empirical drive of the REAL run controller with fake timers + mocked deps
// (audio / analysis / store). Records the full published state sequence so we can
// catch the reported symptoms: REPETITIONS (a phase index moving backward / a cue
// firing twice / a double timer) and BLOCKAGES (a timer phase that never advances).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { get, writable } from 'svelte/store';

// ── mocks ──────────────────────────────────────────────────────────────────
const audioCalls: string[] = [];
vi.mock('./audio', () => ({
  createLogbookAudio: () => {
    const rec = (name: string) => () => audioCalls.push(name);
    return {
      countdown: rec('countdown'), transition: rec('transition'), complete: rec('complete'), awaitBeep: rec('awaitBeep'),
      connect: rec('connect'), disconnect: rec('disconnect'),
      leadIn: rec('leadIn'), go: rec('go'), setVoice: (v: unknown) => audioCalls.push(`setVoice:${v ?? 'null'}`),
      setMuted: () => {}, muted: () => false, dispose: () => {},
    };
  },
}));

const analyzeSpy = vi.fn().mockResolvedValue({ mode: 'event', candidates: [], framesAnalyzed: 0, note: '', hardened: true });
vi.mock('./analysis', () => ({ analyzeLogbookRun: (...a: unknown[]) => analyzeSpy(...a) }));

vi.mock('../state/store', () => ({
  maxTUs: writable(1_000_000), // a live, non-zero base clock
  project: writable({ frames: [], scenarios: [], findings: [] }),
  excludedSlots: () => [],
}));

import { createRunController, type RunUiState } from './runController';
import { makeScenario, type LogbookScenario } from '../protocol/datamodel';

// A short scenario so the sim is quick but keeps the full skeleton + a 2-rep loop.
function shortScenario(): LogbookScenario {
  const s = makeScenario('test');
  s.baseline.durationS = 2;
  s.noise.durationS = 2;
  s.wait.durationS = 1;
  s.recover.durationS = 2;
  s.loop.count = 2;
  s.loop.steps = [
    { type: 'stimulus', name: 'Action', durationS: 3, advance: 'input' },
    { type: 'observe', name: 'After', durationS: 2, advance: 'timer' },
  ];
  return s;
}

beforeEach(() => {
  audioCalls.length = 0;
  analyzeSpy.mockClear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('run controller drive', () => {
  test('advances each phase exactly once, waits at input phases, never regresses, completes', () => {
    const ctrl = createRunController();
    const seq: RunUiState[] = [];
    const unsub = ctrl.state.subscribe((s) => seq.push(structuredClone(s)));

    ctrl.arm(shortScenario());
    ctrl.start();

    // 3·2·1 lead-in (3 s of setInterval ticks) → run begins.
    vi.advanceTimersByTime(3000);
    expect(get(ctrl.state).status).toBe('running');

    // Drive the run: advance 100 ms at a time; auto-confirm input phases after a beat.
    const phaseOrder: { type: string; rep: number }[] = [];
    let guard = 0;
    while (guard++ < 2000) {
      const st = get(ctrl.state);
      if (st.status === 'done' || st.status === 'stopped') break;
      // record the current phase (deduped) BEFORE consuming an input phase
      if (st.phase) {
        const last = phaseOrder[phaseOrder.length - 1];
        if (!last || last.type !== st.phase.type || last.rep !== st.phase.rep) {
          phaseOrder.push({ type: st.phase.type, rep: st.phase.rep });
        }
      }
      if (st.awaitingInput) {
        ctrl.next(); // operator presses Next
        continue;
      }
      vi.advanceTimersByTime(100);
    }

    const final = get(ctrl.state);
    unsub();

    // 1) it COMPLETES (no blockage on a timer phase).
    expect(final.status).toBe('done');

    // 2) phase index never moves BACKWARD while running (no repetition/restart).
    let prevIdx = -1;
    for (const s of seq) {
      if (s.status !== 'running' || s.phaseIndex < 0) continue;
      expect(s.phaseIndex).toBeGreaterThanOrEqual(prevIdx);
      prevIdx = s.phaseIndex;
    }

    // 3) the executed phase order matches the unrolled skeleton (loop expanded ×2).
    expect(phaseOrder.map((p) => p.type)).toEqual([
      'baseline', 'noise', 'wait', 'stimulus', 'observe', 'stimulus', 'observe', 'recover',
    ]);

    // 4) exactly one CONNECT chirp (the first run sound; no double-start).
    expect(audioCalls.filter((c) => c === 'connect').length).toBe(1);

    // 5) the analysis ran exactly once, with the stamped windows.
    expect(analyzeSpy).toHaveBeenCalledTimes(1);

    // 6) a finished sequence announces itself with exactly one DISCONNECT chirp.
    expect(audioCalls.filter((c) => c === 'disconnect').length).toBe(1);
  });

  test('a STOPPED (aborted) run does NOT play the DISCONNECT chirp', () => {
    const ctrl = createRunController();
    ctrl.arm(shortScenario());
    ctrl.start();
    vi.advanceTimersByTime(3000); // lead-in → running
    vi.advanceTimersByTime(1000); // mid-baseline
    ctrl.stop();
    expect(get(ctrl.state).status).toBe('stopped');
    expect(audioCalls.filter((c) => c === 'disconnect').length).toBe(0);
  });

  test('a timer phase fast-forwarded by a long gap (tab throttle) still lands correctly, once', () => {
    const ctrl = createRunController();
    ctrl.arm(shortScenario());
    ctrl.start();
    vi.advanceTimersByTime(3000); // lead-in

    // Simulate a 10 s tab freeze during baseline: ONE big tick. The engine should
    // fast-forward through baseline→noise→wait and land on the first input phase.
    vi.advanceTimersByTime(10_000);
    const st = get(ctrl.state);
    expect(st.status).toBe('running');
    expect(st.awaitingInput).toBe(true);
    expect(st.phase?.type).toBe('stimulus');
    // no negative-index / done glitch from the multi-advance.
    expect(st.phaseIndex).toBeGreaterThan(0);
  });

  test('re-arming with an edited scenario runs the NEW durations, not a stale copy', () => {
    const ctrl = createRunController();
    const s1 = shortScenario(); // baseline 2 s
    ctrl.arm(s1);
    // Simulate an edit: mutateScenario swaps in a fresh object (here baseline 5 s).
    const s2 = structuredClone(s1);
    s2.baseline.durationS = 5;
    ctrl.arm(s2); // the component re-arms on edit (object identity changed)

    ctrl.start();
    vi.advanceTimersByTime(3000); // lead-in
    vi.advanceTimersByTime(3000); // +3 s into baseline
    // With the STALE 2 s baseline it would already be in 'noise'; with the edited
    // 5 s it must still be 'baseline'.
    expect(get(ctrl.state).phase?.type).toBe('baseline');
    vi.advanceTimersByTime(2500); // now past 5 s
    expect(get(ctrl.state).phase?.type).toBe('noise');
  });
});
