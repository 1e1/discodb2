/**
 * Badge color palette + allocator (B1).
 *
 * Hue-only palette generated ONCE by the largest-gap bisection rule
 * (Start 160°, S 70%, L 62%) — see `tools/badge-color-preview.html` for the
 * generator and a live preview. Frozen here as the single source of truth.
 *
 * Every badge IDENTITY — frame badges ('ext' / 'rtr') today, message badges
 * (DIAG / MUX / …) later — draws a DISTINCT hue from this ONE shared palette.
 * Assignment is deterministic: an identity keeps its hue, and a NEW identity
 * takes the LEAST-USED hue (lowest index on ties), so the order in which
 * identities first appear fixes their colors and there is never any randomness.
 * Releasing an identity frees its hue again. With far fewer badge types than
 * palette entries each hue is used at most once (so "least-used" == "lowest
 * free index"); the least-used rule is just the graceful fallback if we ever
 * register more identities than hues.
 *
 * 16 hues is intentional: past ~16 evenly-spread hues the eye no longer tells
 * adjacent colors apart, so there is no point generating more.
 */

/**
 * Frozen max-gap hue sequence (integer degrees). DO NOT reorder — the order IS
 * the allocation order. Regenerate/extend via `tools/badge-color-preview.html`.
 */
export const BADGE_HUES: readonly number[] = [
  160, 340, 250, 70, 115, 205, 295, 25, 48, 93, 138, 183, 228, 273, 318, 3,
];

/** Fixed saturation / lightness for every badge hue (tuned for the dark theme). */
const SAT = 70;
const LIG = 62;

/**
 * Inline CSS for a badge at hue `h`: vivid text, a translucent border and a
 * faint background tint — identical to `tools/badge-color-preview.html`.
 */
export function badgeStyleForHue(h: number): string {
  return `color:hsl(${h} ${SAT}% ${LIG}%);border-color:hsl(${h} ${SAT}% ${LIG}% / 0.55);background:hsl(${h} ${SAT}% ${LIG}% / 0.14);`;
}

// ── deterministic allocator (least-used hue, lowest index on ties) ────────────
const useCount: number[] = BADGE_HUES.map(() => 0);
const assigned = new Map<string, number>();

/** Index of the least-used hue; on a tie the LOWEST index wins (deterministic). */
function leastUsedIndex(): number {
  let best = 0;
  for (let i = 1; i < useCount.length; i++) {
    if (useCount[i] < useCount[best]) best = i; // strict < ⇒ lowest index on ties
  }
  return best;
}

/** The palette INDEX assigned to `identity` (stable for the session). */
export function badgeIndex(identity: string): number {
  let idx = assigned.get(identity);
  if (idx === undefined) {
    idx = leastUsedIndex();
    assigned.set(identity, idx);
    useCount[idx] += 1;
  }
  return idx;
}

/** The hue (degrees) assigned to `identity`. */
export function badgeHue(identity: string): number {
  return BADGE_HUES[badgeIndex(identity)];
}

/** Inline badge CSS for `identity` (assigns a hue on first use). */
export function badgeStyle(identity: string): string {
  return badgeStyleForHue(badgeHue(identity));
}

/** Free `identity`'s hue so a future identity can reuse it. */
export function releaseBadge(identity: string): void {
  const idx = assigned.get(identity);
  if (idx !== undefined) {
    assigned.delete(identity);
    useCount[idx] = Math.max(0, useCount[idx] - 1);
  }
}

// Pre-register the stable frame-badge identities in a FIXED order so their
// colors never depend on render timing: 'ext' (extended 29-bit id) → hue[0]
// (160° teal), 'rtr' (remote request) → hue[1] (340° pink). Message badges
// register later and take the next least-used hues.
badgeIndex('ext');
badgeIndex('rtr');
