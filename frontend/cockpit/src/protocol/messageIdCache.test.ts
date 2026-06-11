/**
 * Tests for createMessageIdResolver — the memoized Message-ID detection cache.
 *
 * The detection (Auto id-profile + dependence test) is expensive but its result
 * is stable, so the resolver caches it per id and only re-detects on a material
 * change. These tests pin the cache hit/miss policy by reference identity
 * (effectiveMessageId allocates a fresh object, so a new reference == a recompute).
 * Run with vitest (`npm run test`).
 */

import { describe, test, expect } from 'vitest';
import type { FrameView } from '../state/ringBuffer';
import { createMessageIdResolver } from './messageIdCache';

const US = 1e6;

function frame(tSec: number, bytes: number[]): FrameView {
  return {
    tUs: tSec * US,
    id: 0x100,
    isExtended: false,
    isError: false,
    isRtr: false,
    dlc: bytes.length,
    data: Uint8Array.from(bytes),
  };
}

/** A real-multiplexor stream: byte0 = key (n%4), byte1 = key*0x10 (depends on it). */
function stream(count: number): FrameView[] {
  const out: FrameView[] = [];
  for (let n = 0; n < count; n++) out.push(frame(n, [n % 4, (n % 4) * 0x10]));
  return out;
}

const sel = { id: 0x100, isExtended: false };

describe('createMessageIdResolver — memoized Message-ID detection', () => {
  test('returns the SAME result (cached) for repeated identical calls', () => {
    const resolve = createMessageIdResolver();
    const frames = stream(30);
    const a = resolve(sel, frames, undefined, 30 * US);
    const b = resolve(sel, frames, undefined, 30 * US);
    expect(b).toBe(a); // same reference → detection not re-run
  });

  test('re-detects when the frame count grows materially', () => {
    const resolve = createMessageIdResolver();
    const a = resolve(sel, stream(30), undefined, 30 * US);
    const c = resolve(sel, stream(60), undefined, 31 * US); // +100% > 25% growth
    expect(c).not.toBe(a);
  });

  test('re-detects when the selected id changes', () => {
    const resolve = createMessageIdResolver();
    const frames = stream(30);
    const a = resolve(sel, frames, undefined, 30 * US);
    const other = resolve({ id: 0x200, isExtended: false }, frames, undefined, 30 * US);
    expect(other).not.toBe(a);
  });

  test('re-detects after the staleness age elapses, even without growth', () => {
    const resolve = createMessageIdResolver();
    const frames = stream(30);
    const a = resolve(sel, frames, undefined, 30 * US);
    const later = resolve(sel, frames, undefined, 36 * US); // +6s > 5s backstop
    expect(later).not.toBe(a);
  });

  test('returns null when nothing is selected', () => {
    const resolve = createMessageIdResolver();
    expect(resolve(null, [], undefined, 0)).toBeNull();
  });
});
