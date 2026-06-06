// Equivalence test: byteHistogramPacked (columnar, DESIGN §6.1.4 step 3b) must
// produce BIT-IDENTICAL output to the frame-based byteHistogram on the same data.
// This is the safety net for the packed migration — the worker scans use the
// packed path, the pure tests above use the frame path; they must never diverge.
//
// node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { byteHistogram, byteHistogramPacked, type HistogramFrame } from "./byte-histogram.ts";
import { framesToPacked } from "./packed.ts";

/** Assert the packed path equals the frame path on `frames` (+ optional args). */
function assertEquiv(frames: HistogramFrame[], allow?: number[], config?: Parameters<typeof byteHistogram>[2]): void {
  const frame = byteHistogram(frames, allow, config);
  const packed = byteHistogramPacked(framesToPacked(frames), allow, config);
  assert.deepEqual(packed, frame);
}

const f = (id: number, data: number[], tUs = 0): HistogramFrame => ({ id, tUs, data });

test("equivalence: mixed ids, enum + analog bytes", () => {
  const frames: HistogramFrame[] = [];
  for (let i = 0; i < 50; i++) {
    frames.push(f(0x100, [i & 1, i % 4, i & 0xff, (i * 7) & 0xff])); // flag, enum, counter, analog-ish
    frames.push(f(0x200, [0x10, (i * 3) & 0xff]));
  }
  assertEquiv(frames);
});

test("equivalence: short-DLC bytes (present on only some frames)", () => {
  const frames: HistogramFrame[] = [
    f(0x300, [1, 2]),
    f(0x300, [3, 4, 5, 6]), // bytes 2,3 only here
    f(0x300, [7, 8, 9]),
    f(0x300, [10, 11]),
  ];
  assertEquiv(frames);
});

test("equivalence: allow-list, minFrames floor, ordering", () => {
  const frames: HistogramFrame[] = [];
  for (let i = 0; i < 20; i++) {
    frames.push(f(0x100, [i & 0xff, (i * 5) & 0xff]));
    frames.push(f(0x200, [(i * 2) & 0xff]));
  }
  frames.push(f(0x999, [42])); // single frame → dropped by minFrames
  assertEquiv(frames);
  assertEquiv(frames, [0x200]);
  assertEquiv(frames, [], { maxBytes: 4, minFrames: 3 });
});

test("equivalence: empty input", () => {
  assertEquiv([]);
});
