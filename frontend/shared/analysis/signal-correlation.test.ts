// Unit tests for the PASSIVE CORRELATION-AGAINST-A-KNOWN-SIGNAL analyzer
// (analysis/signal-correlation.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run with
// `node --test --experimental-strip-types` (same tooling as the scorer / tagger /
// bit-activity / byte-histogram / signal-discovery / co-occurrence tests).
// Deterministic — the cases are constructed.
//
// The analyzer answers "which locus TRACKS a reference series I already have?"
// via Spearman rank correlation. The tests pin the brief's cases:
//   #1 a locus whose value MONOTONICALLY tracks the reference ranks #1 with ρ≈1;
//      an unrelated noisy byte does not; sign of ρ is reported (inverse ⇒ ρ<0).
//   #2 the GEAR use case: gear = floor(speed/threshold) tracks a SPEED reference
//      monotonically (|ρ|≈1) even though it's a coarse step function.
//   #3 resampling across DIFFERENT cadences (reference faster than candidate) via
//      zero-order hold still recovers the relationship.
//   #4 tagger exclusion (a counter byte is skipped), allow-list, minPairs floor,
//      near-constant rejection, purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signalCorrelation,
  SIGNAL_CORRELATION_DEFAULTS,
  type CorrelationFrame,
  type ReferenceSample,
} from "./signal-correlation.ts";
import { tagFrames, excludedBytes, type RawFrame } from "./tagger.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  periodUs: number,
  count: number,
  mkData: (n: number) => number[],
): CorrelationFrame[] {
  const out: CorrelationFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * periodUs, data: mkData(n) });
  return out;
}

/** Deterministic PRNG (mulberry32) — same family as the other analysis tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a locus that tracks the reference ranks #1; sign is reported
 * ──────────────────────────────────────────────────────────────────────── */

test("1) the locus whose value tracks the reference ranks #1 (ρ≈+1); inverse byte is ρ<0; noise is rejected", () => {
  const CAND_ID = 0x280;
  const N = 60;
  // Reference: a smooth rising ramp (e.g. rpm) sampled at the SAME cadence/instants
  // as the candidate id, so we test the metric cleanly before adding cadence skew.
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: 800 + n * 30 });

  // Candidate id payload:
  //   byte0 = a value that RISES with the reference (a monotone but nonlinear map:
  //           floor(sqrt(n)*K)) → high +ρ even though not linear (Spearman, not Pearson).
  //   byte1 = a value that FALLS as the reference rises (inverse) → ρ ≈ -1.
  //   byte2 = pseudo-random noise → |ρ| ≈ 0, rejected.
  const rng = mulberry32(7);
  const frames = periodic(CAND_ID, 10 * MS, N, (n) => {
    const rise = Math.min(255, Math.floor(Math.sqrt(n) * 28)); // monotone ↑
    const fall = 255 - Math.min(255, n * 4); // monotone ↓ (inverse)
    const noise = Math.floor(rng() * 256);
    return [rise, fall, noise, 0x00];
  });

  const res = signalCorrelation(frames, ref);
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");

  const top = res.candidates[0];
  assert.equal(top.id, CAND_ID, "#1 candidate is on the candidate id");
  assert.ok(top.absRho > 0.95, `the strongest candidate tracks the reference (|ρ|≈1, got ${top.rho.toFixed(3)})`);
  assert.equal(top.absRho, Math.abs(top.rho), "absRho is |rho|");

  // An 8-bit read of byte0 — the value that monotonically rises with the reference
  // — must be present with a strong POSITIVE ρ (Spearman handles the nonlinearity).
  const byte0 = res.candidates.find((c) => c.byteIndex === 0 && c.width === 8);
  assert.ok(byte0, "the rising byte0 surfaced as an 8-bit candidate");
  assert.ok(byte0!.rho > 0.95, `byte0 tracks the reference with ρ≈+1 (got ${byte0!.rho.toFixed(3)})`);

  // The inverse byte (byte1) is present as a strong NEGATIVE correlation.
  const inverse = res.candidates.find((c) => c.byteIndex === 1 && c.width === 8);
  assert.ok(inverse, "the inverse byte surfaced as a candidate");
  assert.ok(inverse!.rho < -0.95, `byte1 is inversely related (ρ≈-1, got ${inverse!.rho.toFixed(3)})`);

  // The noise byte (byte2) must NOT pass the |ρ| floor as an 8-bit candidate.
  const noise8 = res.candidates.find((c) => c.byteIndex === 2 && c.width === 8);
  assert.equal(noise8, undefined, "the pseudo-random byte is rejected (|ρ| below floor)");
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — the GEAR use case: gear = step(speed) tracks a SPEED reference
 * ──────────────────────────────────────────────────────────────────────── */

test("2) GEAR use case — a coarse step function of speed monotonically tracks the speed reference (|ρ|≈1)", () => {
  const GEAR_ID = 0x5a0;
  const N = 80;
  // Reference = SPEED rising then steady (a realistic accelerate-and-hold). Gear is
  // a step function of speed: 1st..5th as speed crosses thresholds — monotone in
  // speed, so Spearman ρ is near 1 even though the relationship is a staircase.
  const speeds: number[] = [];
  for (let n = 0; n < N; n++) speeds.push(Math.min(120, n * 1.6)); // km/h-ish ramp
  const ref: ReferenceSample[] = speeds.map((v, n) => ({ tUs: n * 20 * MS, value: v }));

  const gearOf = (speed: number): number =>
    speed < 15 ? 1 : speed < 35 ? 2 : speed < 60 ? 3 : speed < 90 ? 4 : 5;

  // The gear lives in byte3; other bytes are constant or a slow unrelated toggle.
  const frames = periodic(GEAR_ID, 20 * MS, N, (n) => {
    const gear = gearOf(speeds[n]);
    return [0x10, 0x00, n % 11 === 0 ? 1 : 0, gear];
  });

  const res = signalCorrelation(frames, ref);
  const gear = res.candidates.find((c) => c.byteIndex === 3 && c.width === 8);
  assert.ok(gear, "the gear byte surfaced");
  assert.ok(gear!.rho > 0.95, `gear tracks speed monotonically (ρ≈1, got ${gear!.rho.toFixed(3)})`);
  assert.ok(gear!.distinct >= 4, "the gear visited several distinct gears in the window");
  // The gear (a perfect monotone of the reference) should be the strongest candidate.
  assert.equal(res.candidates[0].byteIndex, 3, "the gear byte ranks #1");
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — resampling across DIFFERENT cadences (zero-order hold)
 * ──────────────────────────────────────────────────────────────────────── */

test("3) reference faster than the candidate id — zero-order-hold alignment recovers the relationship", () => {
  const CAND_ID = 0x300;
  // Candidate ticks every 50 ms; reference ticks every 10 ms (5× faster), and over
  // a different total span. Both follow the same underlying rising trend, so after
  // holding the candidate's last value over each reference instant, ρ ≈ 1.
  const candN = 40;
  const frames = periodic(CAND_ID, 50 * MS, candN, (n) => {
    const v = Math.min(255, Math.floor(n * 6)); // rising 8-bit value
    return [v, 0x00];
  });

  // Reference: 5× faster, value = a rising ramp on the same clock. Start it slightly
  // AFTER the candidate's first sample so early ref points have a held value.
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < candN * 5; n++) {
    const tUs = 25 * MS + n * 10 * MS; // offset half a candidate period
    ref.push({ tUs, value: 1000 + tUs / MS }); // monotone rising with time
  }

  const res = signalCorrelation(frames, ref);
  const top = res.candidates[0];
  assert.equal(top.id, CAND_ID);
  assert.equal(top.byteIndex, 0);
  assert.ok(top.rho > 0.95, `held alignment recovers the rising relationship (ρ≈1, got ${top.rho.toFixed(3)})`);
  assert.ok(top.pairs >= SIGNAL_CORRELATION_DEFAULTS.minPairs, "enough aligned pairs were formed");
  // Aligned pairs ≈ all reference samples that had a held candidate value (most of them).
  assert.ok(top.pairs > candN, "the faster reference contributed more pairs than the candidate has samples");
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — exclusion, allow-list, floors, near-constant rejection, purity
 * ──────────────────────────────────────────────────────────────────────── */

test("4) a tagged counter byte is excluded even though it correlates with a rising reference", () => {
  const ID = 0x111;
  const N = 60;
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: n }); // rising

  // byte0 = a free-running +1 counter (rises, so it WOULD correlate with the ramp),
  // byte1 = a genuine value that monotonically tracks the reference but with a
  //         VARYING step (floor(sqrt·K)) so the tagger does NOT mistake it for a
  //         constant-step counter. The tagger flags byte0; the analyzer must skip
  //         it and keep byte1. byte2 constant so a 16-bit read of byte1+byte2 = byte1.
  const trackOf = (n: number) => Math.min(255, Math.floor(Math.sqrt(n) * 30)); // monotone, non-constant step
  const frames = periodic(ID, 10 * MS, N, (n) => [n & 0xff, trackOf(n), 0x00]);

  const tags = tagFrames(frames as RawFrame[]);
  const excluded = excludedBytes(tags);
  assert.ok(excluded.has(`${ID}:0`), "the tagger flagged the +1 counter byte0");
  assert.ok(!excluded.has(`${ID}:1`), "the genuine tracking byte1 was NOT flagged as a counter");

  const res = signalCorrelation(frames, ref, undefined, excluded);
  assert.ok(res.excludedCount > 0, "candidates overlapping the counter were excluded");
  assert.equal(res.candidates.find((c) => c.byteIndex === 0), undefined, "the counter byte0 produced no candidate");
  const real = res.candidates.find((c) => c.byteIndex === 1 && c.width === 8);
  assert.ok(real && real.rho > 0.95, "the genuine tracking byte1 survived with ρ≈1");
});

test("4b) allow-list narrows to chosen ids; other ids are ignored", () => {
  const KEEP = 0x200;
  const DROP = 0x201;
  const N = 50;
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: n });

  const a = periodic(KEEP, 10 * MS, N, (n) => [Math.min(255, n * 4) & 0xff]);
  const b = periodic(DROP, 10 * MS, N, (n) => [Math.min(255, n * 4) & 0xff]);
  // Interleave the two ids by tUs.
  const frames = [...a, ...b].sort((x, y) => x.tUs - y.tUs);

  const res = signalCorrelation(frames, ref, [KEEP]);
  assert.ok(res.candidates.length >= 1, "the allowed id produced candidates");
  assert.ok(res.candidates.every((c) => c.id === KEEP), "only the allowed id appears");
  assert.equal(res.idCount, 1, "one contributing id");
});

test("4c) too-few reference samples ⇒ empty result; near-constant candidate rejected", () => {
  const ID = 0x222;
  const N = 50;
  const frames = periodic(ID, 10 * MS, N, (n) => [Math.min(255, n * 4) & 0xff, 0x42]);

  // Reference shorter than minPairs → no correlation possible.
  const tiny: ReferenceSample[] = [
    { tUs: 0, value: 1 },
    { tUs: 10 * MS, value: 2 },
  ];
  const empty = signalCorrelation(frames, tiny);
  assert.equal(empty.candidates.length, 0, "no candidates when the reference is too short");
  assert.equal(empty.referenceSamples, tiny.length, "the reference sample count is reported");

  // A full reference: byte1 is CONSTANT (0x42) → distinct < minDistinct → rejected.
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: n });
  const res = signalCorrelation(frames, ref);
  assert.equal(res.candidates.find((c) => c.byteIndex === 1), undefined, "the constant byte is rejected");
});

test("4d) purity — the analyzer mutates neither the frames nor the reference", () => {
  const ID = 0x333;
  const N = 40;
  const frames = periodic(ID, 10 * MS, N, (n) => [Math.min(255, n * 5) & 0xff, 0x00]);
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: n });

  const framesSnapshot = JSON.stringify(frames);
  const refSnapshot = JSON.stringify(ref);
  signalCorrelation(frames, ref);
  assert.equal(JSON.stringify(frames), framesSnapshot, "frames not mutated");
  assert.equal(JSON.stringify(ref), refSnapshot, "reference not mutated");
});

test("4e) an unsorted reference is sorted internally (still recovers ρ≈1)", () => {
  const ID = 0x444;
  const N = 50;
  const frames = periodic(ID, 10 * MS, N, (n) => [Math.min(255, n * 4) & 0xff]);
  const ref: ReferenceSample[] = [];
  for (let n = 0; n < N; n++) ref.push({ tUs: n * 10 * MS, value: n });
  // Shuffle the reference; the analyzer must sort by tUs before aligning.
  const shuffled = [...ref].reverse();
  const res = signalCorrelation(frames, shuffled);
  assert.ok(res.candidates.length >= 1 && res.candidates[0].rho > 0.95, "sorted-then-aligned recovers ρ≈1");
});
