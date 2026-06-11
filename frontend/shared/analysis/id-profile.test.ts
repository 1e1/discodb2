// Unit tests for the CUMULATIVE PER-ID PROFILE analyzer (analysis/id-profile.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the histogram /
// bit-activity / tagger tests). Deterministic — the cases are constructed.
//
// The analyzer composes byte-histogram + bit-activity + tagger into one per-id
// picture and derives the CONSTANT-EXCLUSION. The tests pin:
//   #1 a constant byte (incl. always-0 padding AND a constant non-zero byte) is
//      flagged constant / excluded from candidates; a low-cardinality varying
//      byte is a candidate.
//   #2 a counter byte is flagged counterOrChecksum and is NOT a candidate even
//      though it varies a lot.
//   #3 BIT grain: a byte that only moves its low bits → those bits non-constant,
//      the rest constant (the sub-byte discriminator view).
//   #4 minFrames floor drops thin ids; allow-list filters; richest-first order;
//      defaults & purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  idProfile,
  ID_PROFILE_DEFAULTS,
  type ProfileFrame,
} from "./id-profile.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  count: number,
  mkData: (n: number) => number[],
): ProfileFrame[] {
  const out: ProfileFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * 10 * MS, data: mkData(n) });
  return out;
}

/** Find the profile for one id in the result (throws if absent). */
function profileFor(frames: ProfileFrame[], id: number, allow?: number[]) {
  const res = idProfile(frames, allow);
  const p = res.ids.find((x) => x.id === id);
  assert.ok(p, `expected a profile for id ${id}`);
  return p!;
}

test("#1 constant bytes (zero and non-zero) are excluded; a varying low-card byte is a candidate", () => {
  // byte0 = always 0x00 (padding-like), byte1 = cycles 0,1,2,3 (varies, low card),
  // byte2 = always 0xAA (constant non-zero).
  const frames = periodic(0x100, 8, (n) => [0x00, n % 4, 0xaa]);
  const p = profileFor(frames, 0x100);

  // byte0: constant zero
  assert.equal(p.bytes[0].constant, true);
  assert.equal(p.bytes[0].candidate, false);
  assert.equal(p.bytes[0].distinct, 1);

  // byte1: varies, 4 distinct, not a counter/checksum → candidate
  assert.equal(p.bytes[1].constant, false);
  assert.equal(p.bytes[1].counterOrChecksum, false);
  assert.equal(p.bytes[1].candidate, true);
  assert.equal(p.bytes[1].distinct, 4);
  assert.equal(p.bytes[1].min, 0);
  assert.equal(p.bytes[1].max, 3);

  // byte2: constant non-zero (the "ignore me" rule is constancy, not == 0)
  assert.equal(p.bytes[2].constant, true);
  assert.equal(p.bytes[2].candidate, false);

  // The derived masks
  assert.deepEqual(p.constantBytes, [0, 2]);
  assert.deepEqual(p.candidateBytes, [1]);
});

test("#2 a counter byte is tagged counterOrChecksum and is never a candidate", () => {
  // byte0 = full-byte counter that wraps once (≥16 transitions, constant step 1),
  // byte1 = constant. The counter varies a lot but must be excluded.
  const frames = periodic(0x200, 260, (n) => [n & 0xff, 0x00]);
  const p = profileFor(frames, 0x200);

  assert.equal(p.bytes[0].counterOrChecksum, true);
  assert.equal(p.bytes[0].candidate, false, "a counter is structure, never a discriminator");
  assert.ok(p.bytes[0].distinct > 100, "the counter really does vary");

  assert.equal(p.bytes[1].constant, true);

  // Both the counter and the constant byte are excluded → nothing to deduce here.
  assert.deepEqual(p.candidateBytes, []);
});

test("#3 bit grain: only the low bits of a byte move; the rest are constant", () => {
  // Single byte cycling 0,1,2,3 → bit0/bit1 toggle, bits 2..7 stay 0.
  const frames = periodic(0x300, 8, (n) => [n % 4]);
  const p = profileFor(frames, 0x300);

  // bits are global-indexed: byte0 → bitIndex 0..7, LSB first.
  assert.equal(p.bits.length, 8);
  assert.equal(p.bits[0].constant, false, "bit0 toggles");
  assert.equal(p.bits[1].constant, false, "bit1 toggles");
  for (let b = 2; b < 8; b++) {
    assert.equal(p.bits[b].constant, true, `bit${b} never moves`);
    assert.equal(p.bits[b].activity, 0);
  }
  assert.ok(p.bits[0].activity > 0, "bit0 has non-zero toggle activity");
  assert.equal(p.bits[0].byteIndex, 0);
});

test("#4 minFrames floor, allow-list, richest-first order, defaults & purity", () => {
  // Defaults are sane.
  assert.equal(ID_PROFILE_DEFAULTS.maxBytes, 8);
  assert.equal(ID_PROFILE_DEFAULTS.minFrames, 2);

  // id 0x10 is rich (two candidate bytes), id 0x20 is thinner (one candidate),
  // id 0x30 has a single frame → dropped by the minFrames floor.
  const rich = periodic(0x10, 12, (n) => [n % 3, n % 5, 0x00]);
  const thin = periodic(0x20, 12, (n) => [0x00, n % 2]);
  const tiny: ProfileFrame[] = [{ id: 0x30, tUs: 0, data: [1, 2, 3] }];
  const frames = [...rich, ...thin, ...tiny];

  const res = idProfile(frames);
  // minFrames floor drops the 1-frame id.
  assert.equal(res.ids.find((p) => p.id === 0x30), undefined);
  assert.equal(res.idCount, 2);
  assert.equal(res.framesAnalyzed, 24);

  // Richest-first: 0x10 (2 candidates) before 0x20 (1 candidate).
  assert.equal(res.ids[0].id, 0x10);
  assert.deepEqual(res.ids[0].candidateBytes, [0, 1]);
  assert.deepEqual(res.ids[1].candidateBytes, [1]);

  // Allow-list restricts the scan.
  const only = idProfile(frames, [0x20]);
  assert.equal(only.idCount, 1);
  assert.equal(only.ids[0].id, 0x20);

  // Purity: neither frames nor a passed config are mutated.
  const snapshot = JSON.stringify(frames);
  const cfg = { maxBytes: 8, minFrames: 2 };
  const cfgSnapshot = JSON.stringify(cfg);
  idProfile(frames, undefined, cfg);
  assert.equal(JSON.stringify(frames), snapshot, "input frames must not be mutated");
  assert.equal(JSON.stringify(cfg), cfgSnapshot, "config must not be mutated");
});

test("Uint8Array payloads ≡ number[] payloads (the zero-copy boxing invariant)", () => {
  // The cockpit passes the ring's Uint8Array payloads straight through (no
  // Array.from boxing); plain number[] is the test/decoder shape. For the same
  // bytes the profile MUST be identical — this is what makes the zero-copy safe.
  const mk = (n: number) => [n % 4, n % 16, (n * 7) & 0xff, 0x00, n % 3];
  const asNum: ProfileFrame[] = [];
  const asU8: ProfileFrame[] = [];
  for (let n = 0; n < 200; n++) {
    const d = mk(n);
    asNum.push({ id: 0x1a, tUs: n * 1000, data: d });
    asU8.push({ id: 0x1a, tUs: n * 1000, data: Uint8Array.from(d) });
  }
  assert.deepEqual(idProfile(asU8), idProfile(asNum), "Uint8Array and number[] profiles must match");
});
