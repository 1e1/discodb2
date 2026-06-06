// Unit tests for the COLUMNAR packed-frames substrate (analysis/packed.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the rest of
// shared/analysis). Deterministic — the cases are constructed.
//
// Pins: framesToPacked column layout + byte clamping + 8-byte truncation + flag
// packing; byteAt/payloadLen accessors; and groupByIdPacked's arrival-order,
// first-appearance-id grouping with the allow-list.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  framesToPacked,
  byteAt,
  payloadLen,
  isExtended,
  isError,
  isRtr,
  groupByIdPacked,
  PACKED_STRIDE,
  type PackableFrame,
} from "./packed.ts";

test("framesToPacked: columns, dlc, byte clamp, padding, flags", () => {
  const frames: PackableFrame[] = [
    { id: 0x100, tUs: 10, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    { id: 0x200, tUs: 20, data: [0xaa, 0xbb], isExtended: true, isRtr: true },
    { id: 0x100, tUs: 30, data: [256 + 7, -1], isError: true }, // wraps to 7, 255
  ];
  const p = framesToPacked(frames);
  assert.equal(p.count, 3);
  assert.deepEqual(Array.from(p.tUs), [10, 20, 30]);
  assert.deepEqual(Array.from(p.id), [0x100, 0x200, 0x100]);
  assert.deepEqual(Array.from(p.dlc), [8, 2, 2]);
  assert.equal(p.data.length, 3 * PACKED_STRIDE);

  // Frame 0 payload + frame 1 (short, zero-padded beyond dlc).
  assert.equal(byteAt(p, 0, 0), 1);
  assert.equal(byteAt(p, 0, 7), 8);
  assert.equal(byteAt(p, 1, 0), 0xaa);
  assert.equal(byteAt(p, 1, 2), 0); // beyond dlc → zero
  assert.equal(payloadLen(p, 1), 2);

  // Byte clamping: 263 → 7, -1 → 255.
  assert.equal(byteAt(p, 2, 0), 7);
  assert.equal(byteAt(p, 2, 1), 255);

  // Flag packing (bit0 ext, bit1 err, bit2 rtr).
  assert.equal(isExtended(p, 1) && isRtr(p, 1) && !isError(p, 1), true);
  assert.equal(isError(p, 2) && !isExtended(p, 2) && !isRtr(p, 2), true);
});

test("framesToPacked: payloads longer than 8 bytes are truncated to the stride", () => {
  const p = framesToPacked([{ id: 1, data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }]);
  assert.equal(payloadLen(p, 0), 8);
  assert.equal(byteAt(p, 0, 7), 7);
});

test("framesToPacked: tUs/flags default to 0/false when omitted", () => {
  const p = framesToPacked([{ id: 1, data: [5] }]);
  assert.equal(p.tUs[0], 0);
  assert.equal(p.flags[0], 0);
});

test("groupByIdPacked: arrival order within id, first-appearance id order", () => {
  const p = framesToPacked([
    { id: 0x300, data: [1] },
    { id: 0x100, data: [2] },
    { id: 0x300, data: [3] },
    { id: 0x100, data: [4] },
  ]);
  const byId = groupByIdPacked(p);
  assert.deepEqual([...byId.keys()], [0x300, 0x100]); // first-appearance order
  assert.deepEqual(byId.get(0x300), [0, 2]); // arrival order within id
  assert.deepEqual(byId.get(0x100), [1, 3]);
});

test("groupByIdPacked: allow-list filters ids (empty/undefined = all)", () => {
  const p = framesToPacked([
    { id: 1, data: [1] },
    { id: 2, data: [2] },
    { id: 3, data: [3] },
  ]);
  assert.deepEqual([...groupByIdPacked(p, [2]).keys()], [2]);
  assert.deepEqual([...groupByIdPacked(p, []).keys()], [1, 2, 3]);
  assert.deepEqual([...groupByIdPacked(p, undefined).keys()], [1, 2, 3]);
});
