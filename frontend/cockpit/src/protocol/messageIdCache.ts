/**
 * Memoized Message-ID detection — a per-id cache in front of {@link
 * effectiveMessageId}.
 *
 * WHY: the AUTO detector now runs the cumulative id-profile (byte+bit histograms
 * + counter/checksum tagging) AND a mutual-information dependence test over the
 * full buffered history. That is expensive, runs over potentially tens of
 * thousands of frames, and — critically — its RESULT IS STABLE: the discriminator
 * field of an id does not change frame-to-frame. Re-detecting on every ~10 Hz
 * snapshot tick (as MessageList recomputes) is pure waste.
 *
 * So we memoize the detection per (id, isExtended) and only RE-DETECT when:
 *   • the selection changed (different id), or
 *   • the FrameDef changed (a Forced/None decision depends on it), or
 *   • the id's frame count grew materially (≥ {@link REFRESH_GROWTH}) — Auto sharpens
 *     as more evidence arrives — or shrank (ring wrap / reconnect), or
 *   • {@link REFRESH_AGE_US} of backend time elapsed (a backstop so a slow trickle
 *     of new frames still refreshes eventually).
 *
 * The (cheap) per-message GROUPING still runs every tick over the current frames;
 * only the detection is cached. computeMessages takes the cached result via its
 * `precomputedEff` parameter.
 *
 * Each MessageList instance owns one resolver (a closure, no global state), so it
 * is naturally scoped to that view and trivially testable.
 */

import { effectiveMessageId, type EffectiveMessageId } from './messages';
import type { FrameView } from '../state/ringBuffer';
import type { FrameDef } from './datamodel';

/** Re-detect once the id's frame count has grown by this factor since the last run. */
const REFRESH_GROWTH = 1.25;
/** ...or this much backend time (µs) has elapsed — a backstop for slow streams. */
const REFRESH_AGE_US = 5e6;

interface Memo {
  key: string;
  def: FrameDef | undefined;
  eff: EffectiveMessageId;
  frames: number;
  tUs: number;
}

export type MessageIdResolver = (
  sel: { id: number; isExtended: boolean } | null,
  frames: FrameView[],
  def: FrameDef | undefined,
  nowTUs: number,
) => EffectiveMessageId | null;

/**
 * Create a resolver with its own memo slot. Returns the (possibly cached)
 * effective Message-ID for the selection, or null when nothing is selected.
 */
export function createMessageIdResolver(): MessageIdResolver {
  let memo: Memo | null = null;

  return (sel, frames, def, nowTUs) => {
    if (!sel) {
      memo = null;
      return null;
    }
    const key = `${sel.id}:${sel.isExtended}`;
    const n = frames.length;
    // Re-detect on a material change. The `memo === null` check stays in the `if`
    // (not a precomputed boolean) so TS can narrow `memo` to non-null afterwards.
    if (
      memo === null ||
      memo.key !== key ||
      memo.def !== def ||
      n < memo.frames || // shrank (ring wrapped / reconnected) → re-detect
      n >= memo.frames * REFRESH_GROWTH + 1 ||
      nowTUs - memo.tUs > REFRESH_AGE_US
    ) {
      memo = { key, def, eff: effectiveMessageId(frames, def), frames: n, tUs: nowTUs };
    }
    return memo.eff;
  };
}
