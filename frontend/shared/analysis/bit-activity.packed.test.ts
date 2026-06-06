// Equivalence test: bitActivityPacked (columnar, DESIGN §6.1.4 step 3b) must
// produce BIT-IDENTICAL output to the frame-based bitActivity on the same data.
// node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bitActivity, bitActivityPacked, type ScanFrame } from "./bit-activity.ts";
import { framesToPacked } from "./packed.ts";

function assertEquiv(frames: ScanFrame[], allow?: number[], config?: Parameters<typeof bitActivity>[2]): void {
  const frame = bitActivity(frames, allow, config);
  const packed = bitActivityPacked(framesToPacked(frames), allow, config);
  assert.deepEqual(packed, frame);
}

const f = (id: number, data: number[], tUs = 0): ScanFrame => ({ id, tUs, data });

test("equivalence: constant, toggling, and counting bits across mixed ids", () => {
  const frames: ScanFrame[] = [];
  for (let i = 0; i < 40; i++) {
    frames.push(f(0x100, [0xff, i & 1 ? 0x00 : 0xff, i & 0xff, 0x55])); // const, toggle, counter, const
    frames.push(f(0x200, [(i << 1) & 0xff, (i >> 1) & 0xff]));
  }
  assertEquiv(frames);
});

test("equivalence: short-DLC pairs (a bit only judged when both frames carry it)", () => {
  const frames: ScanFrame[] = [
    f(0x300, [0b0001, 0b1010]),
    f(0x300, [0b0011]), // byte 1 absent → its bits skip this pair
    f(0x300, [0b0111, 0b0010]),
    f(0x300, [0b1111, 0b0110, 0b1000]),
  ];
  assertEquiv(frames);
});

test("equivalence: allow-list, minFrames floor, maxBits override, ordering", () => {
  const frames: ScanFrame[] = [];
  for (let i = 0; i < 25; i++) {
    frames.push(f(0x100, [i & 0xff, (i * 3) & 0xff]));
    frames.push(f(0x200, [0xaa]));
  }
  frames.push(f(0x999, [1])); // single frame → minFrames drop
  assertEquiv(frames);
  assertEquiv(frames, [0x100]);
  assertEquiv(frames, [], { maxBits: 16, minFrames: 3 });
});

test("equivalence: empty input", () => {
  assertEquiv([]);
});
