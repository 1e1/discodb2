// Unit tests for the PASSIVE BIT-ACTIVITY HEATMAP analyzer (analysis/bit-activity.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the scorer /
// tagger tests). Deterministic — no PRNG needed; the cases are constructed.
//
// The analyzer answers "which bits MOVE?": per id, per global bit index, the
// toggle frequency = transitions / (frames-1). The tests pin the brief's cases:
//   #1 a CONSTANT bit → 0 activity (and is flagged constant); a bit that flips
//      EVERY frame → ~1.0 activity (and is NOT flagged constant).
//   #2 a COUNTER byte's bits are active, and the tagger flags that byte so the
//      UI can annotate it (the analyzer reports activity; the tagger labels it).
//   #3 a bit present in only SOME frames (short DLC) is handled without crashing
//      — judged only over pairs where both frames carry the byte.
//   #4 the allow-list, minFrames floor, busiest-first ordering, and purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bitActivity,
  BIT_ACTIVITY_DEFAULTS,
  type ScanFrame,
} from "./bit-activity.ts";
// Brick 0, reused exactly as the UI annotation does: tag the same stream, so
// the heatmap can mark a busy bit as "just a counter".
import { tagFrames, type RawFrame } from "./tagger.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  periodUs: number,
  count: number,
  mkData: (n: number) => number[],
): ScanFrame[] {
  const out: ScanFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * periodUs, data: mkData(n) });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a constant bit scores 0; a bit that flips every frame scores ~1.0
 * ──────────────────────────────────────────────────────────────────────── */

test("1) a constant bit → 0 activity (flagged constant); a per-frame flipping bit → ~1.0", () => {
  const id = 0x100;
  // byte0: bit0 flips every frame (n & 1), bit7 is constant 1, the rest are 0.
  // global bit0 = byte0 bit0 (flipping); global bit7 = byte0 bit7 (constant).
  const frames = periodic(id, 50 * MS, 40, (n) => [(n & 1) | 0x80]);

  const res = bitActivity(frames);
  assert.equal(res.idCount, 1, "one id profiled");
  assert.equal(res.framesAnalyzed, 40, "all 40 frames analyzed");

  const p = res.ids[0];
  assert.equal(p.id, id, "the id is profiled");

  // The flipping bit toggles on EVERY one of the 39 transitions → activity 1.0.
  assert.ok(Math.abs(p.activity[0] - 1) < 1e-9, `bit0 flips every frame (got ${p.activity[0]})`);
  assert.equal(p.constant[0], false, "the flipping bit is not constant");

  // The constant high bit never changes → activity 0, flagged constant.
  assert.equal(p.activity[7], 0, "bit7 never changes");
  assert.equal(p.constant[7], true, "bit7 is flagged constant");

  // A bit that is steadily 0 is also constant with 0 activity.
  assert.equal(p.activity[1], 0, "an always-0 bit has 0 activity");
  assert.equal(p.constant[1], true, "an always-0 bit is flagged constant");
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — a counter byte is active, and the tagger flags it for annotation
 * ──────────────────────────────────────────────────────────────────────── */

test("2) a counter byte's bits are active, and the tagger flags that byte (UI annotation)", () => {
  const id = 0x200;
  // byte1 = a rolling +1 counter mod 256; everything else constant. Its low
  // bit toggles every frame; higher bits toggle at halving rates.
  let counter = 0;
  const frames = periodic(id, 50 * MS, 100, () => {
    counter = (counter + 1) & 0xff;
    return [0x00, counter];
  });

  const res = bitActivity(frames);
  const p = res.ids[0];

  // byte1 → global bits 8..15. bit8 (byte1 bit0) flips every step → ~1.0.
  assert.ok(p.activity[8] > 0.95, `counter LSB toggles ~every frame (got ${p.activity[8]})`);
  // bit9 (byte1 bit1) flips at half the rate → ~0.5.
  assert.ok(p.activity[9] > 0.3 && p.activity[9] < 0.7, `counter bit1 toggles ~half (got ${p.activity[9]})`);
  // No counter bit is "constant".
  assert.equal(p.constant[8], false, "the counter LSB is not constant");

  // The tagger (Brick 0) flags byte1 as a counter, so the heatmap UI can mark
  // these busy-but-meaningless bits as noise.
  const tags = tagFrames(frames as RawFrame[]);
  const idTags = tags.get(id) ?? [];
  assert.ok(
    idTags.some((t) => t.kind === "counter" && t.byteIndex === 1),
    "the tagger flags byte1 as a counter so the UI can annotate it",
  );
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — a bit present in only SOME frames (short DLC) is handled, no crash
 * ──────────────────────────────────────────────────────────────────────── */

test("3) a bit present only on some frames (short DLC) is handled without crashing", () => {
  const id = 0x300;
  // The id alternates a 1-byte payload and a 3-byte payload. byte0 is always
  // present and its bit0 flips every frame; byte2 only exists on the long
  // frames, so its bits are judged across FEWER pairs (no long→long adjacency
  // here, so byte2 gets zero comparable pairs).
  const frames: ScanFrame[] = [];
  for (let n = 0; n < 20; n++) {
    frames.push({
      id,
      tUs: n * 50 * MS,
      data: n % 2 === 0 ? [n & 1] : [n & 1, 0xff, n & 1],
    });
  }

  // Must not throw on the ragged lengths.
  let res!: ReturnType<typeof bitActivity>;
  assert.doesNotThrow(() => {
    res = bitActivity(frames);
  });

  const p = res.ids[0];
  assert.equal(p.frames, 20, "all frames counted");
  assert.equal(p.maxByte, 3, "widest payload was 3 bytes");

  // byte0 bit0 is comparable on EVERY pair (always present) and flips each step.
  assert.equal(p.pairs[0], 19, "byte0 bit0 comparable across all 19 pairs");
  assert.ok(Math.abs(p.activity[0] - 1) < 1e-9, "byte0 bit0 flips every frame");

  // byte2 (global bits 16..23) is never present on two ADJACENT frames here
  // (long frames are never consecutive), so it has zero comparable pairs and a
  // defined 0 activity — not NaN, not a crash, and not flagged constant
  // (unknown, not proven constant).
  assert.equal(p.pairs[16], 0, "byte2 bit0 has no comparable pair (never two long frames in a row)");
  assert.equal(p.activity[16], 0, "no pairs → 0 activity (not NaN)");
  assert.equal(p.constant[16], false, "a never-compared bit is unknown, not flagged constant");
  for (const a of p.activity) assert.ok(Number.isFinite(a), "every activity value is finite");

  // Sanity: when long frames ARE adjacent, byte2 is comparable. Two long frames
  // back to back with byte2 differing → one transition over one pair → 1.0.
  const adj: ScanFrame[] = [
    { id: 0x301, tUs: 0, data: [0, 0, 0x00] },
    { id: 0x301, tUs: MS, data: [0, 0, 0x01] },
  ];
  const res2 = bitActivity(adj);
  const p2 = res2.ids[0];
  assert.equal(p2.pairs[16], 1, "one comparable pair for byte2 bit0");
  assert.equal(p2.activity[16], 1, "byte2 bit0 changed across that pair");
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — allow-list, minFrames floor, busiest-first ordering, defaults & purity
 * ──────────────────────────────────────────────────────────────────────── */

test("4) allow-list, minFrames floor, busiest-first ordering, defaults & purity", () => {
  assert.equal(BIT_ACTIVITY_DEFAULTS.maxBits, 64, "8 bytes × 8 bits");
  assert.equal(BIT_ACTIVITY_DEFAULTS.minFrames, 2, "need ≥1 transition to measure");

  // Three ids: a busy one (bit flips every frame), a calm one (all constant),
  // and a thin one (a single frame → below minFrames → dropped).
  const busy = periodic(0x10, 50 * MS, 30, (n) => [n & 1]);
  const calm = periodic(0x20, 50 * MS, 30, () => [0x00]);
  const thin: ScanFrame[] = [{ id: 0x30, tUs: 0, data: [0xff] }];
  const all = [...busy, ...calm, ...thin];

  const res = bitActivity(all);
  // Thin id dropped (1 frame < minFrames 2); busy + calm kept.
  assert.equal(res.idCount, 2, "the single-frame id is dropped below minFrames");
  assert.ok(!res.ids.some((p) => p.id === 0x30), "thin id absent");
  // Busiest first: the toggling id outranks the constant id.
  assert.equal(res.ids[0].id, 0x10, "the busy id sorts first");
  assert.equal(res.ids[1].id, 0x20, "the constant id sorts last");

  // Allow-list restricts to the calm id only.
  const only = bitActivity(all, [0x20]);
  assert.equal(only.idCount, 1, "allow-list keeps a single id");
  assert.equal(only.ids[0].id, 0x20, "allow-listed id is the calm one");

  // Custom maxBits sizes the per-bit arrays.
  const narrow = bitActivity(busy, undefined, { maxBits: 8 });
  assert.equal(narrow.maxBits, 8, "maxBits threaded through");
  assert.equal(narrow.ids[0].activity.length, 8, "activity sized to maxBits");

  // Purity: inputs are not mutated.
  const before = busy.map((f) => Array.from(f.data));
  bitActivity(busy);
  busy.forEach((f, i) => assert.deepEqual(f.data, before[i], "input payloads unchanged"));
});
