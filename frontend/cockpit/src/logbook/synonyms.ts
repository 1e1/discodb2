/**
 * POSITIONAL synonyms — the "is this already decoded?" knowledge-base lookup.
 *
 * Given a candidate's locus (frameId + byteIndex + optional bit), find the project
 * signals whose bit range covers it. The project's FrameDefs ARE the cross-session
 * KB (often imported from a reference DBC, e.g. the Golf Mk4); a hit means the
 * operator already named this slot, so a new finding there is a synonym of a known
 * signal — surfaced as a hint, never auto-excluded.
 *
 * This is the DBC-positional counterpart to the BEHAVIORAL matcher
 * (shared/analysis/synonyms.ts `findSynonyms`, which correlates value series). One
 * is "same place as a known signal", the other is "moves like a known signal".
 *
 * The cockpit stores a signal's locus as a linear bit range `[bitStart, bitStart +
 * bitLength)` with bit = byteIndex*8 + bitInByte (the same convention the scorers'
 * candidates use), so a plain interval overlap on that axis is consistent.
 */

import type { Project } from '../protocol/datamodel';

/** The candidate's linear bit range: a single bit, or the spanned byte(s). */
function locusRange(byteIndex: number, bit: number | undefined, bitLength: number): [number, number] {
  if (bit != null) return [byteIndex * 8 + bit, byteIndex * 8 + bit + 1];
  return [byteIndex * 8, byteIndex * 8 + Math.max(1, bitLength)];
}

/**
 * Names of project signals on `frameId` whose bit range overlaps the candidate
 * locus (deduped, in declaration order). Empty when the slot is undecoded.
 */
export function knownSignalsAt(
  project: Project,
  frameId: number,
  byteIndex: number,
  bit?: number,
  bitLength = 8,
): string[] {
  const [lo, hi] = locusRange(byteIndex, bit, bitLength);
  const out: string[] = [];
  for (const f of project.frames) {
    if (f.id !== frameId) continue;
    for (const s of f.signals) {
      const sLo = s.bitStart;
      const sHi = s.bitStart + s.bitLength;
      if (lo < sHi && sLo < hi && !out.includes(s.name)) out.push(s.name);
    }
  }
  return out;
}
