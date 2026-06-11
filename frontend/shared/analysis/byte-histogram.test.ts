// Unit tests for the PASSIVE PER-BYTE VALUE HISTOGRAM analyzer (analysis/byte-histogram.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the scorer /
// tagger / bit-activity tests). Deterministic — the cases are constructed.
//
// The analyzer answers "HOW is each byte's value distributed?": per id, per byte
// index, a 256-bin value count plus distinct/min/max. The tests pin the brief's
// cases:
//   #1 a SINGLE-VALUED byte → 1 distinct value (constant); a 2-value FLAG byte →
//      2 distinct values, with min/max bracketing the two states.
//   #2 a WIDE ANALOG spread → many distinct values, with correct min/max over
//      the swept range, and the counts summing to the sample count.
//   #3 a SHORT-DLC byte is counted only where present (never zero-filled), so a
//      byte that appears on only some frames has fewer samples than the id's
//      frame count, and a never-carried byte is simply absent.
//   #4 allow-list, minFrames floor, richest-first ordering, defaults & purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  byteHistogram,
  BYTE_HISTOGRAM_DEFAULTS,
  BYTE_VALUE_BINS,
  type HistogramFrame,
} from "./byte-histogram.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  periodUs: number,
  count: number,
  mkData: (n: number) => number[],
): HistogramFrame[] {
  const out: HistogramFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * periodUs, data: mkData(n) });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a single-valued byte → 1 distinct; a 2-value flag byte → 2 distinct
 * ──────────────────────────────────────────────────────────────────────── */

test("1) a constant byte → 1 distinct value; a 2-value flag byte → 2 distinct", () => {
  const id = 0x100;
  // byte0: a flag that toggles between 0x00 and 0x01 each frame (an enum/flag).
  // byte1: constant 0x42 (a fixed marker byte).
  const frames = periodic(id, 50 * MS, 40, (n) => [n & 1, 0x42]);

  const res = byteHistogram(frames);
  assert.equal(res.idCount, 1, "one id profiled");
  assert.equal(res.framesAnalyzed, 40, "all 40 frames analyzed");

  const p = res.ids[0];
  assert.equal(p.id, id, "the id is profiled");
  assert.equal(p.maxByte, 2, "widest payload was 2 bytes");
  assert.equal(p.bytes.length, 2, "one histogram per present byte");

  // byte0 — the flag: exactly two distinct values {0,1}, sampled on every frame.
  const b0 = p.bytes[0];
  assert.equal(b0.distinct, 2, "the flag byte takes 2 distinct values");
  assert.equal(b0.samples, 40, "the flag byte is present on every frame");
  assert.equal(b0.min, 0, "flag min value 0");
  assert.equal(b0.max, 1, "flag max value 1");
  assert.equal(b0.counts[0], 20, "value 0 occurred on the 20 even frames");
  assert.equal(b0.counts[1], 20, "value 1 occurred on the 20 odd frames");

  // byte1 — constant: exactly one distinct value, min === max === that value.
  const b1 = p.bytes[1];
  assert.equal(b1.distinct, 1, "the constant byte takes a single value");
  assert.equal(b1.min, 0x42, "constant min is the held value");
  assert.equal(b1.max, 0x42, "constant max is the held value");
  assert.equal(b1.counts[0x42], 40, "the held value occurred on every frame");
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — a wide analog spread → many distinct values, correct min/max
 * ──────────────────────────────────────────────────────────────────────── */

test("2) a wide analog spread → many distinct values + correct min/max", () => {
  const id = 0x280;
  // byte0 sweeps 10, 12, 14, ... a smooth analog ramp over 100 frames: 100
  // distinct even values from 10 up to 10 + 2*99 = 208. byte1 is constant 0.
  const frames = periodic(id, 10 * MS, 100, (n) => [(10 + n * 2) & 0xff, 0x00]);

  const res = byteHistogram(frames);
  const p = res.ids[0];
  const analog = p.bytes[0];

  // A continuous spread: many distinct values (one per frame here).
  assert.equal(analog.distinct, 100, "the analog byte spreads over many distinct values");
  assert.equal(analog.samples, 100, "sampled on every frame");
  assert.equal(analog.min, 10, "min of the swept range");
  assert.equal(analog.max, 208, "max of the swept range");

  // The 256-bin counts sum to the sample count, with each visited value once.
  assert.equal(analog.counts.length, BYTE_VALUE_BINS, "256 bins");
  const total = analog.counts.reduce((s, c) => s + c, 0);
  assert.equal(total, 100, "counts sum to the sample count");
  assert.equal(analog.counts[10], 1, "the min value occurred once");
  assert.equal(analog.counts[208], 1, "the max value occurred once");
  assert.equal(analog.counts[11], 0, "an unvisited (odd) value has zero count");

  // The analog byte is far richer than the constant companion byte → it drives
  // the id's richest-first ranking peak.
  assert.equal(p.bytes[1].distinct, 1, "the companion byte is constant");
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — a short-DLC byte is counted only where present (not zero-filled)
 * ──────────────────────────────────────────────────────────────────────── */

test("3) a short-DLC byte is counted only where present (no zero-fill)", () => {
  const id = 0x300;
  // The id alternates a 1-byte payload and a 3-byte payload. byte0 is always
  // present; byte2 exists only on the long (odd-n) frames, where it carries n.
  const frames: HistogramFrame[] = [];
  for (let n = 0; n < 20; n++) {
    frames.push({
      id,
      tUs: n * 50 * MS,
      data: n % 2 === 0 ? [n & 0xff] : [n & 0xff, 0xff, n & 0xff],
    });
  }

  // Must not throw on ragged lengths.
  let res!: ReturnType<typeof byteHistogram>;
  assert.doesNotThrow(() => {
    res = byteHistogram(frames);
  });

  const p = res.ids[0];
  assert.equal(p.frames, 20, "all frames counted");
  assert.equal(p.maxByte, 3, "widest payload was 3 bytes");
  assert.equal(p.bytes.length, 3, "histograms for bytes 0..2 (the widest seen)");

  // byte0 is present on all 20 frames.
  assert.equal(p.bytes[0].samples, 20, "byte0 present on every frame");

  // byte2 exists only on the 10 long (odd-n) frames — it is counted there and
  // NOWHERE else: a missing byte is not a value-0 sample.
  const b2 = p.bytes[2];
  assert.equal(b2.samples, 10, "byte2 sampled only on the long frames");
  assert.equal(b2.counts[0], 0, "the absent frames did NOT add phantom value-0 samples");
  // The long frames carried n ∈ {1,3,5,...,19} → 10 distinct odd values.
  assert.equal(b2.distinct, 10, "byte2 took the 10 distinct odd values it actually carried");
  assert.equal(b2.min, 1, "byte2 min is the first long-frame value");
  assert.equal(b2.max, 19, "byte2 max is the last long-frame value");
  const total2 = b2.counts.reduce((s, c) => s + c, 0);
  assert.equal(total2, 10, "byte2 counts sum to its present-sample count");

  // A byte index this id never carried (byte3+) is simply absent.
  assert.equal(p.bytes[3], undefined, "an unseen byte index is not in the profile");
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — allow-list, minFrames floor, richest-first ordering, defaults & purity
 * ──────────────────────────────────────────────────────────────────────── */

test("4) allow-list, minFrames floor, richest-first ordering, defaults & purity", () => {
  assert.equal(BYTE_HISTOGRAM_DEFAULTS.maxBytes, 8, "classic CAN payload width");
  assert.equal(BYTE_HISTOGRAM_DEFAULTS.minFrames, 2, "need ≥2 frames for a distribution");
  assert.equal(BYTE_VALUE_BINS, 256, "a byte takes 256 possible values");

  // Three ids: a rich one (byte0 ramps over many values), a flat one (constant),
  // and a thin one (a single frame → below minFrames → dropped).
  const rich = periodic(0x10, 50 * MS, 30, (n) => [(n * 3) & 0xff]);
  const flat = periodic(0x20, 50 * MS, 30, () => [0x07]);
  const thin: HistogramFrame[] = [{ id: 0x30, tUs: 0, data: [0xff] }];
  const all = [...rich, ...flat, ...thin];

  const res = byteHistogram(all);
  // Thin id dropped (1 frame < minFrames 2); rich + flat kept.
  assert.equal(res.idCount, 2, "the single-frame id is dropped below minFrames");
  assert.ok(!res.ids.some((p) => p.id === 0x30), "thin id absent");
  // Richest first: the wide-spread id outranks the constant id.
  assert.equal(res.ids[0].id, 0x10, "the rich id sorts first");
  assert.equal(res.ids[1].id, 0x20, "the constant id sorts last");

  // Allow-list restricts to the flat id only.
  const only = byteHistogram(all, [0x20]);
  assert.equal(only.idCount, 1, "allow-list keeps a single id");
  assert.equal(only.ids[0].id, 0x20, "allow-listed id is the flat one");

  // Custom maxBytes clamps the number of byte slots profiled.
  const wide = periodic(0x40, 50 * MS, 10, () => [1, 2, 3, 4]);
  const narrow = byteHistogram(wide, undefined, { maxBytes: 2 });
  assert.equal(narrow.maxBytes, 2, "maxBytes threaded through");
  assert.equal(narrow.ids[0].bytes.length, 2, "byte slots clamped to maxBytes");

  // Purity: inputs are not mutated.
  const before = rich.map((f) => Array.from(f.data));
  byteHistogram(rich);
  rich.forEach((f, i) => assert.deepEqual(f.data, before[i], "input payloads unchanged"));
});
