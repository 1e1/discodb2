// discodb2 — equivalence pin for the WASM co-occurrence tally kernel (step 4, §6).
//
// The WASM kernel must produce the SAME analysis verdict as the pure-JS reference,
// or it is a regression disguised as a speedup. The kernel is pure integer, so we
// require BIT-IDENTITY (not a tolerance) for BOTH tiers vs JS — integer adds don't
// reorder-drift, even under SIMD. We assert at two levels:
//   1. the raw tally (jsCoocTally vs each wasm tier) is Int32-identical, and
//   2. the full coOccurrencePacked result (derived jaccard/conditional/groups/hubs
//      on top of the tally) is deep-equal with the kernel injected vs the JS default.
// We also confirm SIMD feature-detect and the no-WASM fallback path.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  coOccurrencePacked,
  jsCoocTally,
  setCoOccurrenceTallyKernel,
  type CoOccurrenceTallyKernel,
} from '@shared/analysis/co-occurrence.ts';
import { framesToPacked, groupByIdPacked, type PackableFrame } from '@shared/analysis/packed.ts';
import { instantiateCoocKernel, wasmSimdSupported } from './coocKernel';

const scalarBytes = readFileSync(new URL('./cooc.scalar.wasm', import.meta.url));
const simdBytes = readFileSync(new URL('./cooc.simd.wasm', import.meta.url));

let scalarKernel: CoOccurrenceTallyKernel;
let simdKernel: CoOccurrenceTallyKernel;

beforeAll(async () => {
  scalarKernel = await instantiateCoocKernel(scalarBytes);
  simdKernel = await instantiateCoocKernel(simdBytes);
});

afterEach(() => {
  setCoOccurrenceTallyKernel(null); // always restore the JS default between tests
});

/**
 * A structured synthetic bus exercising: a 16-bit LE counter pair (co-change),
 * a multiplexed signal, a checksum-like hub byte, constant bytes, SHORT DLC
 * (4-byte frames), and the SIMD 16-byte-load boundary at the final frame.
 */
function buildFrames(): PackableFrame[] {
  const frames: PackableFrame[] = [];
  let s = 0xdeadbeef >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 8) & 0xff;
  const ids = [0x101, 0x202, 0x303, 0x404, 0x505];
  for (let n = 0; n < 1500; n++) {
    const id = ids[n % ids.length];
    const c = (n / ids.length) | 0;
    // id 0x404 is SHORT (dlc 4); the rest are full 8.
    const short = id === 0x404;
    const mux = c & 0x03;
    const data = [
      mux,
      c & 0xff,
      (c >> 8) & 0xff,
      mux === 0 ? rnd() : (mux * 40) & 0xff,
      mux === 1 ? rnd() : 0x10,
      rnd(),
      0x55,
      0, // checksum filled below
    ];
    data[7] = (data[0] ^ data[1] ^ data[2] ^ data[3] ^ data[4] ^ data[5] ^ data[6]) & 0xff;
    frames.push({ id, tUs: n * 100, data: short ? data.slice(0, 4) : data });
  }
  return frames;
}

describe('WASM co-occurrence tally kernel', () => {
  it('SIMD feature-detect resolves (node supports simd128)', () => {
    expect(wasmSimdSupported()).toBe(true);
  });

  it('raw tally is bit-identical (JS vs scalar vs simd), per id incl. short DLC', () => {
    const packed = framesToPacked(buildFrames());
    const byId = groupByIdPacked(packed);
    let checkedShort = false;
    for (const [id, indicesArr] of byId) {
      // byteCount = min(maxByte, 8); 0x404 is dlc-4 so byteCount 4 (short path).
      let maxByte = 0;
      for (const i of indicesArr) if (packed.dlc[i] > maxByte) maxByte = packed.dlc[i];
      const byteCount = Math.min(maxByte, 8);
      if (id === 0x404) {
        expect(byteCount).toBe(4);
        checkedShort = true;
      }
      const indices = Int32Array.from(indicesArr);
      const js = jsCoocTally(packed.data, packed.dlc, indices, byteCount);
      const sc = scalarKernel(packed.data, packed.dlc, indices, byteCount);
      const si = simdKernel(packed.data, packed.dlc, indices, byteCount);
      expect(Array.from(sc.changed)).toEqual(Array.from(js.changed));
      expect(Array.from(sc.present)).toEqual(Array.from(js.present));
      expect(Array.from(sc.coChange)).toEqual(Array.from(js.coChange));
      expect(Array.from(sc.coPresent)).toEqual(Array.from(js.coPresent));
      expect(Array.from(si.changed)).toEqual(Array.from(js.changed));
      expect(Array.from(si.present)).toEqual(Array.from(js.present));
      expect(Array.from(si.coChange)).toEqual(Array.from(js.coChange));
      expect(Array.from(si.coPresent)).toEqual(Array.from(js.coPresent));
    }
    expect(checkedShort).toBe(true);
  });

  it('full coOccurrencePacked result is deep-equal: JS default vs scalar vs simd', () => {
    const packed = framesToPacked(buildFrames());
    const ref = coOccurrencePacked(packed);

    setCoOccurrenceTallyKernel(scalarKernel);
    const withScalar = coOccurrencePacked(packed);
    expect(withScalar).toEqual(ref);

    setCoOccurrenceTallyKernel(simdKernel);
    const withSimd = coOccurrencePacked(packed);
    expect(withSimd).toEqual(ref);

    // ranking/verdict surfaces (groups + hubs) are present and identical too.
    expect(withSimd.ids.map((x) => [x.id, x.groups, x.hubs]))
      .toEqual(ref.ids.map((x) => [x.id, x.groups, x.hubs]));
  });

  it('clearing the kernel restores the pure-JS path (fallback proof)', () => {
    const packed = framesToPacked(buildFrames());
    const ref = coOccurrencePacked(packed);
    setCoOccurrenceTallyKernel(scalarKernel);
    coOccurrencePacked(packed);
    setCoOccurrenceTallyKernel(null);
    expect(coOccurrencePacked(packed)).toEqual(ref);
  });

  it('handles the degenerate cases (single-frame id, all-equal payloads)', () => {
    const frames: PackableFrame[] = [
      { id: 0x700, tUs: 0, data: [1, 2, 3, 4, 5, 6, 7, 8] }, // lone frame → no pairs
      { id: 0x701, tUs: 1, data: [9, 9, 9, 9, 9, 9, 9, 9] },
      { id: 0x701, tUs: 2, data: [9, 9, 9, 9, 9, 9, 9, 9] }, // never changes
    ];
    const packed = framesToPacked(frames);
    const ref = coOccurrencePacked(packed);
    setCoOccurrenceTallyKernel(simdKernel);
    expect(coOccurrencePacked(packed)).toEqual(ref);
  });
});
