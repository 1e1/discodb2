// Unit tests for the POSITIONAL synonym lookup (logbook/synonyms.ts) — does a
// candidate locus land on a signal the project already decodes?

import { describe, it, expect } from 'vitest';
import { knownSignalsAt } from './synonyms';
import { emptyProject, makeSignal, type Project } from '../protocol/datamodel';

function projectWith(...signals: ReturnType<typeof makeSignal>[]): Project {
  const p = emptyProject();
  p.frames = [{ id: 0x1f0, isExtended: false, name: 'F', signals }];
  return p;
}

describe('knownSignalsAt', () => {
  it('matches a single bit that falls inside a known signal range', () => {
    // a flag at byte 2 bit 3 → absolute bit 19; a signal covering bits 16..23 (byte 2).
    const p = projectWith(makeSignal(0x1f0, false, { name: 'Lights', bitStart: 16, bitLength: 8 }));
    expect(knownSignalsAt(p, 0x1f0, 2, 3)).toEqual(['Lights']);
  });

  it('does not match a bit outside every signal range', () => {
    const p = projectWith(makeSignal(0x1f0, false, { name: 'Lights', bitStart: 16, bitLength: 8 }));
    // byte 5 bit 0 → bit 40, no signal there.
    expect(knownSignalsAt(p, 0x1f0, 5, 0)).toEqual([]);
  });

  it('ignores signals on a different frame id', () => {
    const p = projectWith(makeSignal(0x1f0, false, { name: 'Lights', bitStart: 16, bitLength: 8 }));
    expect(knownSignalsAt(p, 0x200, 2, 3)).toEqual([]);
  });

  it('a whole-byte candidate overlaps any signal touching that byte', () => {
    const p = projectWith(
      makeSignal(0x1f0, false, { name: 'Speed', bitStart: 8, bitLength: 16 }), // bytes 1..2
      makeSignal(0x1f0, false, { name: 'Temp', bitStart: 40, bitLength: 8 }), // byte 5
    );
    // whole byte 2 (bits 16..23) overlaps Speed (8..23), not Temp.
    expect(knownSignalsAt(p, 0x1f0, 2)).toEqual(['Speed']);
  });

  it('dedupes when two signals share the locus', () => {
    const p = projectWith(
      makeSignal(0x1f0, false, { name: 'A', bitStart: 16, bitLength: 4 }),
      makeSignal(0x1f0, false, { name: 'B', bitStart: 16, bitLength: 8 }),
    );
    expect(knownSignalsAt(p, 0x1f0, 2, 1)).toEqual(['A', 'B']);
  });
});
