// Equivalence test: signalDiscoveryPacked (columnar, DESIGN §6.1.4 step 3b) must
// produce BIT-IDENTICAL output to the frame-based signalDiscovery on the same data
// — covering a smooth little-endian ramp, a big-endian 16-bit signal, signed
// values, the excluded-slot skip, short DLC, and config overrides.
// node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { signalDiscovery, signalDiscoveryPacked, type SignalFrame } from "./signal-discovery.ts";
import { framesToPacked } from "./packed.ts";

function assertEquiv(
  frames: SignalFrame[],
  allow?: number[],
  excluded?: ReadonlySet<string>,
  config?: Parameters<typeof signalDiscovery>[3],
): void {
  const frame = signalDiscovery(frames, allow, excluded, config);
  const packed = signalDiscoveryPacked(framesToPacked(frames), allow, excluded, config);
  assert.deepEqual(packed, frame);
}

const f = (id: number, data: number[], tUs = 0): SignalFrame => ({ id, tUs, data });

test("equivalence: smooth 16-bit LE ramp + a 16-bit BE ramp + a noisy byte", () => {
  const frames: SignalFrame[] = [];
  for (let i = 0; i < 60; i++) {
    const le = (1000 + i * 37) & 0xffff;
    const be = (200 + i * 11) & 0xffff;
    frames.push(
      f(0x100, [le & 0xff, (le >> 8) & 0xff, (be >> 8) & 0xff, be & 0xff, (i * 131) & 0xff]),
    );
  }
  assertEquiv(frames);
});

test("equivalence: signed descending ramp", () => {
  const frames: SignalFrame[] = [];
  for (let i = 0; i < 50; i++) {
    const v = (-i * 50) & 0xffff; // two's-complement-ish negative ramp
    frames.push(f(0x200, [v & 0xff, (v >> 8) & 0xff]));
  }
  assertEquiv(frames);
});

test("equivalence: excluded slot skip + allow-list + short DLC", () => {
  const frames: SignalFrame[] = [];
  for (let i = 0; i < 40; i++) {
    const v = (500 + i * 23) & 0xffff;
    const base = [v & 0xff, (v >> 8) & 0xff, i & 0xff];
    frames.push(f(0x300, i % 4 === 0 ? base : [base[0], base[1]])); // byte 2 short-DLC
    frames.push(f(0x400, [(i * 17) & 0xff, (i * 19) & 0xff]));
  }
  assertEquiv(frames, undefined, new Set(["0x300:2".replace("0x300", String(0x300))]));
  assertEquiv(frames, [0x300]);
  assertEquiv(frames, [], undefined, { widths: [8, 16], minFrames: 8, maxCandidates: 5 });
});

test("equivalence: empty input", () => {
  assertEquiv([]);
});
