/**
 * Tests for the LOGBOOK data model (datamodel.ts: scenarios/findings).
 * Run with vitest. The scenario is the editable template; scenarioPhases unrolls
 * it for the run engine / timeline / copilot; ensureLogbook back-fills old projects.
 */

import { describe, test, expect } from 'vitest';
import {
  makeScenario,
  scenarioPhases,
  ensureLogbook,
  emptyProject,
  type Project,
} from './datamodel';

describe('Logbook data model', () => {
  test('makeScenario builds the fixed experiment skeleton', () => {
    const s = makeScenario('Find the headlight flash');
    expect(s.objective).toBe('Find the headlight flash');
    expect(s.done).toBe(false);
    expect(s.baseline.type).toBe('baseline');
    expect(s.noise.type).toBe('noise');
    expect(s.wait.type).toBe('wait');
    expect(s.recover.type).toBe('recover');
    expect(s.loop.count).toBe(3);
    expect(s.loop.steps.map((x) => x.type)).toEqual(['stimulus', 'observe']);
    expect(s.loop.steps[0].advance).toBe('input'); // stimulus = operator-confirmed
    expect(s.id.startsWith('scn_')).toBe(true);
  });

  test('scenarioPhases unrolls the loop with rep numbers; outer steps are rep 0', () => {
    const s = makeScenario('X');
    s.loop.count = 2;
    const ph = scenarioPhases(s);
    expect(ph.map((p) => p.type)).toEqual([
      'baseline', 'noise', 'wait', 'stimulus', 'observe', 'stimulus', 'observe', 'recover',
    ]);
    expect(ph.filter((p) => p.type === 'stimulus').map((p) => p.rep)).toEqual([1, 2]);
    expect(ph.filter((p) => p.type === 'observe').map((p) => p.rep)).toEqual([1, 2]);
    expect(ph[0].rep).toBe(0); // baseline
    expect(ph[ph.length - 1].rep).toBe(0); // recover
  });

  test('ensureLogbook back-fills empty arrays and is idempotent / preserving', () => {
    const old = { name: 'legacy', frames: [] } as Project; // no scenarios/findings
    ensureLogbook(old);
    expect(old.scenarios).toEqual([]);
    expect(old.findings).toEqual([]);

    old.scenarios!.push(makeScenario('a'));
    ensureLogbook(old); // must not clobber existing content
    expect(old.scenarios!.length).toBe(1);
  });

  test('emptyProject ships with the Logbook arrays', () => {
    const p = emptyProject('sharan');
    expect(p.scenarios).toEqual([]);
    expect(p.findings).toEqual([]);
  });
});
