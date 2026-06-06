// Unit tests for Brick 3 — the FLAG / BYTE-CHANGE SCORER (analysis/flag-scorer.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as
// event-scorer.test.ts / trend-scorer.test.ts / tagger.test.ts) — zero deps,
// deterministic mulberry32 PRNG.
//
// The scorer answers a DIFFERENT question from compareStates: not "which field
// shifted the most by magnitude" but "which DISCRETE byte(s) took a different-
// but-individually-stable value between two captured states", with changes
// confined to ≤2 bytes emphasized. The tests pin the brief's cases:
//   #1 a CLEAN single-byte flag toggling A↔B ranks #1; a counter byte that the
//      tagger excludes never surfaces; a within-state chatter byte self-rejects.
//   #2 a single-BIT flip within an otherwise-equal byte is reported per-bit
//      (bit + direction), not as a whole-byte change.
//   #3 a 2-byte exchange surfaces BOTH bytes and out-ranks a simultaneous many-
//      byte (mode-change) id thanks to the ≤2-byte de-rating.
//   #4 a no-change capture (identical A and B, and the empty [] capture) yields
//      NO candidates.
//   #5 a counter/checksum byte handed via the exclusion set is never proposed,
//      even when it differs A↔B.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreFlags,
  FLAG_SCORER_DEFAULTS,
  type TimedFrame,
} from "./flag-scorer.ts";
// Brick 0, reused exactly as the integration does: tag the stream, exclude the
// counter/checksum bytes, hand that Set to the scorer.
import { tagFrames, excludedBytes, type RawFrame } from "./tagger.ts";

// Deterministic PRNG (mulberry32) — the same one the other analysis tests use.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MS = 1000; // µs per ms — frames share the µs clock (irrelevant to ordering here).

/**
 * Build a periodic stream for one id over `[0, durUs)`. `mkData(n, tUs)` returns
 * the payload for the n-th frame. (Same helper shape as the other tests.)
 */
function periodic(
  id: number,
  periodUs: number,
  durUs: number,
  mkData: (n: number, tUs: number) => number[],
): TimedFrame[] {
  const out: TimedFrame[] = [];
  let n = 0;
  for (let tUs = 0; tUs < durUs; tUs += periodUs, n++) {
    out.push({ id, data: mkData(n, tUs), tUs });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a CLEAN single-byte flag toggling A↔B (alongside a counter + chatter)
 * ──────────────────────────────────────────────────────────────────────── */

const FLAG_ID = 0x5a0;
const FLAG_BYTE = 2;
const COUNTER_BYTE = 5;
const CHATTER_BYTE = 0;

test("1) a clean single-byte flag (OFF in A, ON in B) ranks #1; counter excluded, chatter rejected", () => {
  const r = rng(1);
  const periodMs = 50; // 20 Hz → 40 frames per 2 s window.
  const stateMs = 2000;

  // byte2 = the FLAG: a steady 0x00 in A (OFF), a steady 0x01 in B (ON).
  // byte5 = a rolling +1 counter (Brick-0 fodder); byte0 = chatter that churns
  // its whole range within EACH window (no dominant value → self-rejects).
  let counter = 0;
  const mkState = (flag: number): TimedFrame[] =>
    periodic(FLAG_ID, periodMs * MS, stateMs * MS, () => {
      counter = (counter + 1) & 0xff;
      const d = [Math.floor(r() * 256), 0, flag, 0, 0, counter];
      return d;
    });

  const a = mkState(0x00); // handbrake OFF
  const b = mkState(0x01); // handbrake ON

  // Brick 0 tags the rolling counter; feed its exclusions to the scorer.
  const excluded = excludedBytes(tagFrames([...a, ...b] as RawFrame[]));
  assert.ok(excluded.has(`${FLAG_ID}:${COUNTER_BYTE}`), "tagger excluded the rolling counter byte5");

  const res = scoreFlags(a, b, excluded);

  assert.equal(res.framesA, a.length, "framesA reported");
  assert.equal(res.framesB, b.length, "framesB reported");
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");

  // The flag byte is #1, reported as a single-bit flip (only bit0 differs).
  const top = res.candidates[0];
  assert.equal(top.id, FLAG_ID, "#1 is the flag id");
  assert.equal(top.byteIndex, FLAG_BYTE, "#1 is byte2");
  assert.equal(top.valueA, 0x00, "value held in A is 0x00");
  assert.equal(top.valueB, 0x01, "value held in B is 0x01");
  assert.equal(top.bit, 0, "the change is confined to bit0");
  assert.equal(top.direction, "0->1", "the bit goes high A→B");
  assert.equal(top.changedBytesForId, 1, "exactly one byte changed for this id");
  assert.ok(top.score > 0.9, `clean separation scores near 1 (got ${top.score.toFixed(3)})`);

  // The counter never surfaces (tagger exclusion flowed through); the chatter is
  // rejected (no dominant value within a window) → neither byte5 nor byte0 ranks.
  assert.ok(
    !res.candidates.some((c) => c.byteIndex === COUNTER_BYTE),
    "the excluded counter byte is never a candidate",
  );
  assert.ok(
    !res.candidates.some((c) => c.byteIndex === CHATTER_BYTE),
    "the within-window chatter byte is rejected (no stable value)",
  );
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — a single-BIT flip within an otherwise-equal byte is reported per-bit
 * ──────────────────────────────────────────────────────────────────────── */

test("2) a single-bit flip inside a byte is located to that bit (not the whole byte)", () => {
  const id = 0x30b;
  const periodMs = 50;
  const stateMs = 2000;

  // byte1 holds 0xA0 in A and 0xA8 in B — i.e. ONLY bit3 toggles (0xA0 ^ 0xA8 =
  // 0x08). The scorer must narrow the locus to bit3, direction 0->1.
  const a = periodic(id, periodMs * MS, stateMs * MS, () => [0, 0xa0]);
  const b = periodic(id, periodMs * MS, stateMs * MS, () => [0, 0xa8]);

  const res = scoreFlags(a, b);

  const top = res.candidates.find((c) => c.id === id && c.byteIndex === 1);
  assert.ok(top, "the changed byte1 is a candidate");
  assert.equal(top!.valueA, 0xa0, "A value 0xA0");
  assert.equal(top!.valueB, 0xa8, "B value 0xA8");
  assert.equal(top!.bit, 3, "exactly bit3 flipped (0xA0 ^ 0xA8 = 0x08)");
  assert.equal(top!.direction, "0->1", "bit3 goes high A→B");

  // A byte whose change spans MORE than one bit must report the whole byte
  // (bit === null). 0x00 → 0x03 flips two bits.
  const a2 = periodic(0x444, periodMs * MS, stateMs * MS, () => [0x00]);
  const b2 = periodic(0x444, periodMs * MS, stateMs * MS, () => [0x03]);
  const multi = scoreFlags(a2, b2).candidates.find((c) => c.id === 0x444 && c.byteIndex === 0);
  assert.ok(multi, "the multi-bit changed byte is a candidate");
  assert.equal(multi!.bit, null, "a 2-bit change reports the whole byte, not a single bit");
  assert.equal(multi!.direction, null, "no single-bit direction for a whole-byte change");
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — a 2-byte exchange surfaces both bytes & out-ranks a many-byte change
 * ──────────────────────────────────────────────────────────────────────── */

test("3) a 2-byte exchange surfaces both bytes and out-ranks a simultaneous many-byte (mode) change", () => {
  const periodMs = 50;
  const stateMs = 2000;

  // id 0x200: a clean TWO-byte exchange — byte0 and byte3 each take a new steady
  // value A→B (a small flag exchange). Both must surface, un-penalized (changed
  // count = 2 ≤ maxChangedBytes).
  const exA = periodic(0x200, periodMs * MS, stateMs * MS, () => [0x10, 0, 0, 0x20]);
  const exB = periodic(0x200, periodMs * MS, stateMs * MS, () => [0x11, 0, 0, 0x21]);

  // id 0x201: a MODE change — FIVE bytes all take a new steady value at once.
  // Each byte is individually a clean separation, but the ≤2-byte de-rating must
  // push them BELOW the genuine 2-byte exchange above.
  const modeA = periodic(0x201, periodMs * MS, stateMs * MS, () => [0x01, 0x02, 0x03, 0x04, 0x05]);
  const modeB = periodic(0x201, periodMs * MS, stateMs * MS, () => [0x11, 0x12, 0x13, 0x14, 0x15]);

  const res = scoreFlags([...exA, ...modeA], [...exB, ...modeB]);

  // Both bytes of the exchange surface, each tagged "2-byte change".
  const ex0 = res.candidates.find((c) => c.id === 0x200 && c.byteIndex === 0);
  const ex3 = res.candidates.find((c) => c.id === 0x200 && c.byteIndex === 3);
  assert.ok(ex0 && ex3, "both bytes of the 2-byte exchange surface");
  assert.equal(ex0!.changedBytesForId, 2, "exchange id has exactly 2 changed bytes");
  assert.equal(ex3!.changedBytesForId, 2, "exchange id has exactly 2 changed bytes");

  // The mode-change id reports 5 changed bytes and is de-rated.
  const modeCand = res.candidates.find((c) => c.id === 0x201);
  assert.ok(modeCand, "the mode-change id still produces candidates (de-rated, not dropped)");
  assert.equal(modeCand!.changedBytesForId, 5, "mode-change id has 5 changed bytes");

  // ≤2-byte emphasis: the 2-byte exchange out-ranks the 5-byte mode change.
  assert.ok(
    Math.min(ex0!.score, ex3!.score) > modeCand!.score,
    `the ≤2-byte exchange (scores ${ex0!.score.toFixed(3)}/${ex3!.score.toFixed(3)}) ` +
      `out-ranks the 5-byte mode change (${modeCand!.score.toFixed(3)})`,
  );
  // Concretely: the two exchange bytes are the top two candidates overall.
  assert.deepEqual(
    [res.candidates[0].id, res.candidates[1].id],
    [0x200, 0x200],
    "the two exchange bytes are the top two candidates",
  );
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — a no-change capture yields no candidates (identical A/B, and empty [])
 * ──────────────────────────────────────────────────────────────────────── */

test("4) a no-change capture yields NO candidates (identical states, and the empty capture)", () => {
  const periodMs = 50;
  const stateMs = 2000;

  // Identical steady payloads in both states → nothing changed → no candidates.
  const same = (): number[] => [0x00, 0xff, 0x3c, 0x00];
  const a = periodic(0x123, periodMs * MS, stateMs * MS, same);
  const b = periodic(0x123, periodMs * MS, stateMs * MS, same);
  const noChange = scoreFlags(a, b);
  assert.deepEqual(noChange.candidates, [], "identical A and B → no changed bytes");

  // Empty captures (the operator never held a state) → no candidates, no throw.
  const emptyBoth = scoreFlags([], []);
  assert.deepEqual(emptyBoth.candidates, [], "empty A and B → no candidates");
  assert.equal(emptyBoth.framesA, 0, "framesA = 0");
  assert.equal(emptyBoth.framesB, 0, "framesB = 0");

  // One side empty → the id is absent from that state, so nothing to compare.
  const emptyB = scoreFlags(a, []);
  assert.deepEqual(emptyB.candidates, [], "B empty → no comparison possible");
});

/* ────────────────────────────────────────────────────────────────────────
 * #5 — a counter/checksum byte is never proposed (exclusion honoured)
 * ──────────────────────────────────────────────────────────────────────── */

test("5) a counter/checksum byte is NOT proposed even when it differs A↔B (tagger exclusion)", () => {
  const periodMs = 50;
  const stateMs = 2000;
  const id = 0x480;

  // byte0 = a genuine flag (0x00 → 0x01). byte1 = a rolling +1 counter that of
  // course holds different values across the two windows, but is NOT signal.
  // byte2 = an XOR-prefix CHECKSUM over bytes 0..1 (the sim's scheme): it
  // tracks the counter (and the flag), so it would look like a perfect follower
  // — the tagger must exclude it, and the scorer must never propose it.
  let counter = 0;
  const mkState = (flag: number): TimedFrame[] =>
    periodic(id, periodMs * MS, stateMs * MS, () => {
      counter = (counter + 1) & 0xff;
      const b0 = flag;
      const b1 = counter;
      const checksum = (b0 ^ b1) & 0xff; // xor-prefix over [b0, b1].
      return [b0, b1, checksum];
    });

  const a = mkState(0x00);
  const b = mkState(0x01);

  // Tag over BOTH states' frames (as the integration does), then exclude.
  const tags = tagFrames([...a, ...b] as RawFrame[]);
  const excluded = excludedBytes(tags);
  assert.ok(excluded.has(`${id}:1`), "the rolling counter byte1 is excluded");
  assert.ok(excluded.has(`${id}:2`), "the checksum byte2 is excluded");

  const res = scoreFlags(a, b, excluded);

  // Only the genuine flag byte0 surfaces; the counter and checksum never do,
  // despite both differing between the windows.
  assert.ok(res.candidates.some((c) => c.byteIndex === 0), "the genuine flag byte0 surfaces");
  assert.ok(!res.candidates.some((c) => c.byteIndex === 1), "the counter byte1 is never proposed");
  assert.ok(!res.candidates.some((c) => c.byteIndex === 2), "the checksum byte2 is never proposed");
});

/* ────────────────────────────────────────────────────────────────────────
 * #6 — config defaults + purity / determinism (the file's headline guarantees)
 * ──────────────────────────────────────────────────────────────────────── */

test("6) config defaults are sane; output is deterministic & inputs are not mutated", () => {
  assert.equal(FLAG_SCORER_DEFAULTS.maxChangedBytes, 2, "≤2-byte emphasis threshold is 2");
  assert.equal(FLAG_SCORER_DEFAULTS.flagStability, 0.8, "stability floor mirrors the event scorer");

  const periodMs = 50;
  const stateMs = 2000;
  const a = periodic(0x5a0, periodMs * MS, stateMs * MS, () => [0x00, 0x00]);
  const b = periodic(0x5a0, periodMs * MS, stateMs * MS, () => [0x01, 0x00]);

  const lenA = a.length;
  const firstData = a[0].data;
  const firstCopy = firstData.slice();

  // Deterministic: reversing the per-state frame order yields identical ordering.
  const r1 = scoreFlags(a, b);
  const r2 = scoreFlags([...a].reverse(), [...b].reverse());
  assert.deepEqual(
    r1.candidates.map((c) => `${c.id}:${c.byteIndex}:${c.bit}`),
    r2.candidates.map((c) => `${c.id}:${c.byteIndex}:${c.bit}`),
    "candidate ordering is independent of input frame order",
  );

  // Immutable: the inputs were not touched.
  assert.equal(a.length, lenA, "frames array not mutated");
  assert.equal(a[0].data, firstData, "frame payload identity preserved");
  assert.deepEqual(a[0].data, firstCopy, "frame payload contents unchanged");
});
