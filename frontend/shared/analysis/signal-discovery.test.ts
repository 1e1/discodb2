// Unit tests for the PASSIVE SIGNAL-DISCOVERY SWEEP analyzer (analysis/signal-discovery.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the scorer /
// tagger / bit-activity / byte-histogram tests). Deterministic — constructed cases.
//
// The analyzer sweeps candidate (byteIndex, width, byteOrder, signed, factor)
// interpretations of an id's payload and RANKS the ones that vary like a real
// analog signal (non-constant, bounded, SMOOTHLY varying), excluding tagger
// counter/checksum byte slots. The tests pin the brief's contract:
//   #1 a SMOOTH analog ramp is discovered and ranks ABOVE a JUMPY/noisy byte;
//      its locus (byteIndex/bitStart/width/order) and smoothness are correct.
//   #2 a CONSTANT byte and a near-flag (few distinct values) are rejected.
//   #3 LITTLE vs BIG endian: a 16-bit big-endian ramp is found under the big
//      convention with the right bitStart, and decodes the right magnitude.
//   #4 excluded counter/checksum byte slots are skipped (and counted); a signed
//      negative ramp is read as signed; allow-list, minFrames, ordering & purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signalDiscovery,
  SIGNAL_DISCOVERY_DEFAULTS,
  type SignalFrame,
} from "./signal-discovery.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  periodUs: number,
  count: number,
  mkData: (n: number) => number[],
): SignalFrame[] {
  const out: SignalFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * periodUs, data: mkData(n) });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a smooth analog ramp is discovered and outranks a jumpy byte
 * ──────────────────────────────────────────────────────────────────────── */

test("1) a smooth analog ramp is discovered and outranks a jumpy/noisy byte", () => {
  const id = 0x280;
  // byte0: a SMOOTH ramp 0,2,4,...  (small steps relative to its 0..198 range).
  // byte1: a JUMPY pseudo-noise byte (big steps every frame) — not analog.
  const noise = [0, 200, 13, 240, 47, 199, 5, 250, 90, 160];
  const frames = periodic(id, 20 * MS, 100, (n) => [(n * 2) & 0xff, noise[n % noise.length]]);

  const res = signalDiscovery(frames);
  assert.ok(res.candidates.length > 0, "found at least one plausible candidate");

  // The top candidate must be the smooth ramp at byte0, width 8, little.
  const top = res.candidates[0];
  assert.equal(top.id, id, "top candidate is the ramp's id");
  assert.equal(top.byteIndex, 0, "top candidate is byte0");
  assert.equal(top.width, 8, "an 8-bit width fits the ramp");
  assert.equal(top.byteOrder, "little", "width-8 is reported as little (byte-aligned)");
  assert.equal(top.bitStart, 0, "byte0 little ⇒ bitStart 0");
  assert.ok(top.smoothness > 0.9, "the ramp is very smooth");

  // The jumpy byte1, IF it survives at all, must rank strictly below the ramp.
  const jumpy = res.candidates.find((c) => c.byteIndex === 1 && c.width === 8 && !c.signed);
  if (jumpy) {
    assert.ok(jumpy.smoothness < top.smoothness, "the jumpy byte is less smooth than the ramp");
    assert.ok(jumpy.score < top.score, "the jumpy byte ranks below the ramp");
  }
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — constants and near-flags are rejected
 * ──────────────────────────────────────────────────────────────────────── */

test("2) a constant byte and a 2-state flag byte are rejected (not analog)", () => {
  const id = 0x100;
  // byte0: constant 0x42; byte1: a 2-value flag toggling 0/1. Neither is an analog
  // signal: a constant has zero range, a flag has too few distinct values.
  const frames = periodic(id, 50 * MS, 40, () => [0x42, 0]).map((f, n) => ({
    ...f,
    data: [0x42, n & 1],
  }));

  const res = signalDiscovery(frames);
  // No width-8 candidate should be emitted for byte0 (constant) or byte1 (flag).
  const b0 = res.candidates.find((c) => c.byteIndex === 0 && c.width === 8);
  const b1 = res.candidates.find((c) => c.byteIndex === 1 && c.width === 8);
  assert.equal(b0, undefined, "the constant byte is rejected");
  assert.equal(b1, undefined, "the 2-state flag byte is rejected (too few distinct values)");
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — little vs big endian: a 16-bit big-endian ramp is found correctly
 * ──────────────────────────────────────────────────────────────────────── */

test("3) a 16-bit big-endian ramp is discovered under the big convention", () => {
  const id = 0x3a0;
  // A 16-bit value that ramps 1000,1010,1020,... laid out BIG-ENDIAN across
  // bytes 0..1 (byte0 = high byte, byte1 = low byte). Smooth (+10 per frame over a
  // ~3000-wide range). 200 frames so the value climbs through many distinct values.
  const frames = periodic(id, 10 * MS, 200, (n) => {
    const v = (1000 + n * 10) & 0xffff;
    return [(v >> 8) & 0xff, v & 0xff];
  });

  const res = signalDiscovery(frames);
  // The strongest candidate should be the 16-bit BIG reading at byte0.
  const big16 = res.candidates.find(
    (c) => c.byteIndex === 0 && c.width === 16 && c.byteOrder === "big" && !c.signed,
  );
  assert.ok(big16, "a 16-bit big-endian candidate was discovered");
  // big "sawtooth" MSB for a byte-aligned field lives in byte0 local bit 7.
  assert.equal(big16!.bitStart, 7, "big-endian byte0 ⇒ bitStart = 7 (Motorola MSB)");
  assert.ok(big16!.smoothness > 0.9, "the 16-bit ramp is very smooth");
  // Decoded magnitude: min ≈ 1000*factor, max ≈ (1000+199*10)*factor = 2990*factor.
  // factor is display-only; the RAW range is 1990. With factor sweep, max>min.
  assert.ok(big16!.max > big16!.min, "the big-endian value spans a real range");

  // The 16-bit LITTLE reading of the same bytes is NOT a smooth ramp (low byte
  // wraps every 25-ish frames while the high byte jumps), so big must outrank it.
  const little16 = res.candidates.find(
    (c) => c.byteIndex === 0 && c.width === 16 && c.byteOrder === "little" && !c.signed,
  );
  if (little16) {
    assert.ok(big16!.score >= little16.score, "big-endian reading outranks the little-endian one");
  }
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — exclusions, signedness, allow-list, minFrames, ordering, defaults, purity
 * ──────────────────────────────────────────────────────────────────────── */

test("4) excluded slots, signedness, allow-list, minFrames floor, defaults & purity", () => {
  assert.equal(SIGNAL_DISCOVERY_DEFAULTS.maxBytes, 8, "classic CAN payload width");
  assert.deepEqual(SIGNAL_DISCOVERY_DEFAULTS.widths, [8, 16], "widths swept by default");
  assert.deepEqual(SIGNAL_DISCOVERY_DEFAULTS.byteOrders, ["little", "big"], "both byte orders");

  // ── excluded byte slots are skipped and counted ─────────────────────────────
  const id = 0x4a0;
  // byte0 smooth ramp; byte1 ALSO a smooth ramp but we EXCLUDE it (pretend the
  // tagger flagged it a counter). Only byte0 should be discovered.
  const frames = periodic(id, 20 * MS, 100, (n) => [(n * 2) & 0xff, (n * 3) & 0xff]);
  const res = signalDiscovery(frames, undefined, new Set([`${id}:1`]));
  assert.ok(res.candidates.some((c) => c.byteIndex === 0), "byte0 discovered");
  assert.ok(!res.candidates.some((c) => c.byteIndex === 1), "excluded byte1 skipped");
  assert.ok(res.excludedCount > 0, "the excluded slot is counted");

  // ── signedness: a value that ramps DOWN through the signed wrap reads negative ─
  const sid = 0x5b0;
  // byte0 holds 250,248,...,2 (a smooth fall). Read SIGNED, the high values are
  // negative (250 → -6). The signed reading should be discovered and smooth.
  const sframes = periodic(sid, 20 * MS, 100, (n) => [(250 - n * 2) & 0xff]);
  const sres = signalDiscovery(sframes);
  const signedCand = sres.candidates.find((c) => c.id === sid && c.signed && c.width === 8);
  assert.ok(signedCand, "a signed reading is among the candidates");
  assert.ok(signedCand!.min < 0, "the signed reading goes negative");

  // ── allow-list restricts the ids scanned ───────────────────────────────────
  const a = periodic(0x10, 20 * MS, 100, (n) => [(n * 2) & 0xff]);
  const b = periodic(0x20, 20 * MS, 100, (n) => [(n * 2) & 0xff]);
  const only = signalDiscovery([...a, ...b], [0x20]);
  assert.ok(only.candidates.every((c) => c.id === 0x20), "allow-list keeps a single id");

  // ── minFrames floor: an id with too few frames is dropped ───────────────────
  const thin = periodic(0x30, 20 * MS, 5, (n) => [(n * 2) & 0xff]);
  const thinRes = signalDiscovery(thin);
  assert.equal(thinRes.candidates.length, 0, "an id below minFrames yields no candidates");

  // ── ordering: candidates are sorted by descending score ─────────────────────
  for (let i = 1; i < res.candidates.length; i++) {
    assert.ok(res.candidates[i - 1].score >= res.candidates[i].score, "sorted best-first");
  }

  // ── purity: inputs are not mutated ──────────────────────────────────────────
  const before = frames.map((f) => f.data.slice());
  signalDiscovery(frames);
  frames.forEach((f, i) => assert.deepEqual(f.data, before[i], "input payloads unchanged"));
});
