// Equivalence test: tagFramesPacked (columnar, DESIGN §6.1.4 step 3b) must produce
// IDENTICAL tags to the frame-based tagFrames on the same data — covering counters
// (byte + nibble), every checksum scheme, short DLC, and the maxFrames tail window.
// node:test, run with `node --test --experimental-strip-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { tagFrames, tagFramesPacked, type RawFrame } from "./tagger.ts";
import { framesToPacked } from "./packed.ts";

function assertEquiv(frames: RawFrame[], config?: Parameters<typeof tagFrames>[1]): void {
  const frame = tagFrames(frames, config);
  const packed = tagFramesPacked(framesToPacked(frames), config);
  // Maps compare by entries; deepEqual handles Map structurally in node:assert.
  assert.deepEqual(packed, frame);
}

test("equivalence: byte counter + xor-prefix checksum (the sim's layout)", () => {
  const frames: RawFrame[] = [];
  for (let i = 0; i < 64; i++) {
    const d = [i & 0xff, (i * 2) & 0xff, 0x10, 0x20, 0xaa, 0x55, i & 0x0f, 0];
    d[7] = d[0] ^ d[1] ^ d[2] ^ d[3] ^ d[4] ^ d[5] ^ d[6]; // xor-prefix checksum
    frames.push({ id: 0x1a0, data: d });
  }
  assertEquiv(frames);
});

test("equivalence: nibble counter + sum-all checksum + a steady id", () => {
  const frames: RawFrame[] = [];
  for (let i = 0; i < 80; i++) {
    const d = [(i * 3) & 0xff, 0x00, (i & 0x0f), 0];
    d[3] = (d[0] + d[1] + d[2]) & 0xff; // sum-all checksum at the trailing byte
    frames.push({ id: 0x200, data: d });
    frames.push({ id: 0x300, data: [0x42, 0x42] }); // constant id → no tags
  }
  assertEquiv(frames);
});

test("equivalence: crc8 prefix checksum", () => {
  const crc8 = (bytes: number[]): number => {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b & 0xff;
      for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
    }
    return crc & 0xff;
  };
  const frames: RawFrame[] = [];
  for (let i = 0; i < 50; i++) {
    const head = [i & 0xff, (i * 7) & 0xff, (i * 13) & 0xff];
    frames.push({ id: 0x2f0, data: [...head, crc8(head)] });
  }
  assertEquiv(frames);
});

test("equivalence: short DLC (a byte present on only some frames)", () => {
  const frames: RawFrame[] = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ id: 0x400, data: i % 3 === 0 ? [i & 0xff, (i * 5) & 0xff] : [i & 0xff] });
  }
  assertEquiv(frames);
});

test("equivalence: maxFrames tail window is applied identically", () => {
  const frames: RawFrame[] = [];
  for (let i = 0; i < 200; i++) frames.push({ id: 0x500, data: [i & 0xff, (i * 9) & 0xff] });
  assertEquiv(frames, { maxFrames: 64 });
  assertEquiv(frames, { maxFrames: 0 }); // 0 = no cap
});

test("equivalence: empty input", () => {
  assertEquiv([]);
});
