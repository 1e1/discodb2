// Equivalence test: signalCorrelationPacked (columnar, DESIGN §6.1.4 step 3b) must
// produce BIT-IDENTICAL output to the frame-based signalCorrelation on the same
// data — covering a positive tracker, an inverse tracker on a different cadence,
// short DLC, excluded slots, and the too-little-reference early-out.
// node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signalCorrelation,
  signalCorrelationPacked,
  type CorrelationFrame,
  type ReferenceSample,
} from "./signal-correlation.ts";
import { framesToPacked } from "./packed.ts";

function assertEquiv(
  frames: CorrelationFrame[],
  ref: ReferenceSample[],
  allow?: number[],
  excluded?: ReadonlySet<string>,
  config?: Parameters<typeof signalCorrelation>[4],
): void {
  const frame = signalCorrelation(frames, ref, allow, excluded, config);
  const packed = signalCorrelationPacked(framesToPacked(frames), ref, allow, excluded, config);
  assert.deepEqual(packed, frame);
}

const f = (id: number, tUs: number, data: number[]): CorrelationFrame => ({ id, tUs, data });

test("equivalence: a byte that tracks the reference, and one that tracks inversely", () => {
  const frames: CorrelationFrame[] = [];
  const ref: ReferenceSample[] = [];
  for (let i = 0; i < 60; i++) {
    const t = i * 1000;
    const rpm = 800 + i * 40;
    ref.push({ tUs: t, value: rpm });
    // byte0 rises with rpm; byte1 falls; byte2 is unrelated noise.
    frames.push(f(0x100, t + 100, [(i * 4) & 0xff, (250 - i * 4) & 0xff, (i * 97) & 0xff]));
  }
  assertEquiv(frames, ref);
});

test("equivalence: candidate on a different cadence (zero-order-hold alignment)", () => {
  const frames: CorrelationFrame[] = [];
  const ref: ReferenceSample[] = [];
  for (let i = 0; i < 40; i++) ref.push({ tUs: i * 2000, value: i * 10 });
  for (let i = 0; i < 90; i++) frames.push(f(0x200, i * 900, [(i * 3) & 0xff, (i >> 1) & 0xff]));
  assertEquiv(frames, ref);
});

test("equivalence: short DLC + excluded slot + allow-list + config override", () => {
  const frames: CorrelationFrame[] = [];
  const ref: ReferenceSample[] = [];
  for (let i = 0; i < 50; i++) {
    const t = i * 1000;
    ref.push({ tUs: t, value: i });
    const full = [(i * 5) & 0xff, (i * 2) & 0xff, i & 0xff];
    frames.push(f(0x300, t, i % 3 === 0 ? full : [full[0], full[1]]));
    frames.push(f(0x400, t + 10, [(i * 7) & 0xff]));
  }
  assertEquiv(frames, ref, undefined, new Set([`${0x300}:2`]));
  assertEquiv(frames, ref, [0x300]);
  assertEquiv(frames, ref, [], undefined, { minPairs: 5, minAbsRho: 0.3, maxCandidates: 4 });
});

test("equivalence: too little reference → empty (early-out)", () => {
  assertEquiv([f(0x100, 0, [1, 2])], [{ tUs: 0, value: 1 }]);
});
