import { describe, it, expect } from 'vitest';
import { evalNamedFormula } from './formula';

describe('evalNamedFormula (derived signals over decoded values)', () => {
  it('evaluates an expression over named signal values', () => {
    const r = evalNamedFormula('engine_rpm / 1000', { engine_rpm: 3000 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3);
    expect(r.display).toBe('3');
  });

  it('combines several signals and appends a unit', () => {
    const r = evalNamedFormula('(wheel_FL + wheel_FR) / 2', { wheel_FL: 40, wheel_FR: 60 }, 'km/h');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(50);
    expect(r.display).toBe('50 km/h');
  });

  it('fails (not throws) on a reference to an unknown signal', () => {
    const r = evalNamedFormula('nonexistent * 2', { engine_rpm: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('empty expression is inert', () => {
    expect(evalNamedFormula('   ', { x: 1 }).ok).toBe(false);
  });
});
