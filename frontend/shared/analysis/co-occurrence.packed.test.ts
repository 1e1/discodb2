// Equivalence test: coOccurrencePacked (columnar, DESIGN §6.1.4 step 3b) must
// produce BIT-IDENTICAL output to the frame-based coOccurrence on the same data —
// covering a tight multi-byte pair, a checksum hub, short DLC, and the excluded-
// bytes annotation. node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { coOccurrence, coOccurrencePacked, type CoOccurrenceFrame } from "./co-occurrence.ts";
import { framesToPacked } from "./packed.ts";

function assertEquiv(
  frames: CoOccurrenceFrame[],
  allow?: number[],
  excluded?: ReadonlyMap<number, ReadonlyArray<number>>,
  config?: Parameters<typeof coOccurrence>[3],
): void {
  const frame = coOccurrence(frames, allow, excluded, config);
  const packed = coOccurrencePacked(framesToPacked(frames), allow, excluded, config);
  assert.deepEqual(packed, frame);
}

const f = (id: number, data: number[], tUs = 0): CoOccurrenceFrame => ({ id, tUs, data });

test("equivalence: a 16-bit pair (bytes 0,1 move together) + an independent byte", () => {
  const frames: CoOccurrenceFrame[] = [];
  let v = 0;
  for (let i = 0; i < 60; i++) {
    v += 257; // both low+high byte of a 16-bit value change most steps
    frames.push(f(0x100, [v & 0xff, (v >> 8) & 0xff, i % 5 === 0 ? 1 : 0, 0x10]));
  }
  assertEquiv(frames);
});

test("equivalence: a checksum hub (byte changes whenever any other does)", () => {
  const frames: CoOccurrenceFrame[] = [];
  for (let i = 0; i < 80; i++) {
    const d = [i & 0xff, (i * 3) & 0xff, (i * 7) & 0xff, 0];
    d[3] = (d[0] ^ d[1] ^ d[2]) & 0xff; // hub: co-changes with all
    frames.push(f(0x200, d));
  }
  assertEquiv(frames);
});

test("equivalence: short DLC + excluded-bytes annotation + allow-list", () => {
  const frames: CoOccurrenceFrame[] = [];
  for (let i = 0; i < 50; i++) {
    frames.push(f(0x300, i % 2 === 0 ? [i & 0xff, (i * 2) & 0xff, (i * 4) & 0xff] : [i & 0xff, (i * 2) & 0xff]));
    frames.push(f(0x400, [(i * 5) & 0xff]));
  }
  const excluded = new Map<number, number[]>([[0x300, [2]]]);
  assertEquiv(frames, undefined, excluded);
  assertEquiv(frames, [0x300], excluded);
  assertEquiv(frames, [], excluded, { maxBytes: 4, groupJaccard: 0.5, hubMinDegree: 2 });
});

test("equivalence: empty input", () => {
  assertEquiv([]);
});
