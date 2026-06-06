// Unit tests for the PASSIVE CO-OCCURRENCE OF CHANGES analyzer (analysis/co-occurrence.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as the scorer /
// tagger / bit-activity / byte-histogram tests). Deterministic — the cases are
// constructed.
//
// The analyzer answers "which BYTES change TOGETHER?": per id, a byte×byte
// co-change matrix (Jaccard + conditional), plus "likely groups" (runs of
// adjacent high-co-change bytes ⇒ multi-byte values) and "hubs" (a byte that
// drives many others ⇒ multiplexor/checksum). The tests pin the brief's cases:
//   #1 a 16-bit value split across two ADJACENT bytes (they change together) →
//      Jaccard ≈ 1 between them, and a length-2 "likely group".
//   #2 a byte that co-changes with MANY others (a multiplexor/checksum) → flagged
//      as a hub with high out-degree; an independent byte is not.
//   #3 SHORT-DLC: a pair only counts toward (i,j) when both frames carry both
//      bytes — a byte that comes and goes never invents phantom co-changes.
//   #4 excludedBytes annotation, allow-list, minFrames floor, ordering, purity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coOccurrence,
  CO_OCCURRENCE_DEFAULTS,
  type CoOccurrenceFrame,
} from "./co-occurrence.ts";

const MS = 1000; // µs per ms.

/** Build a periodic stream for one id. `mkData(n)` returns the n-th payload. */
function periodic(
  id: number,
  periodUs: number,
  count: number,
  mkData: (n: number) => number[],
): CoOccurrenceFrame[] {
  const out: CoOccurrenceFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id, tUs: n * periodUs, data: mkData(n) });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 — a 16-bit value across two adjacent bytes ⇒ they change together
 * ──────────────────────────────────────────────────────────────────────── */

test("1) two adjacent bytes of a 16-bit value co-change ⇒ Jaccard≈1 + a group", () => {
  const id = 0x280;
  // bytes 0..1 = a 16-bit counter split big-endian (hi, lo). It increments by 1
  // each frame, so the LOW byte (b1) changes every frame, and the HIGH byte (b0)
  // changes only on the 256-wrap. byte2 is an INDEPENDENT slow flag toggling on a
  // different cadence; byte3 is constant.
  const frames = periodic(id, 10 * MS, 80, (n) => {
    const v = 1000 + n; // 16-bit value
    return [(v >> 8) & 0xff, v & 0xff, (n % 7 === 0) ? 1 : 0, 0x55];
  });

  const res = coOccurrence(frames);
  assert.equal(res.idCount, 1, "one id profiled");
  const p = res.ids[0];
  assert.equal(p.id, id);
  assert.equal(p.byteCount, 4, "four byte slots (widest payload)");

  // The low byte changes every pair; the high byte changes only when the low
  // byte wraps — and EVERY high-byte change co-occurs with a low-byte change.
  // So P(b0 changes | b1 changed) is small, but P(b1 changes | b0 changed) = 1:
  // whenever the high byte moves, the low byte moved too.
  assert.equal(p.conditional[0][1], 1, "whenever the high byte changes, the low byte also changes");

  // Jaccard(b0,b1) is small here (the low byte changes far more often than the
  // high byte, so the union is dominated by low-only changes) — that's correct
  // for a fast-counting 16-bit field and is why grouping a slow-MSB counter is
  // hard. The grouping case is tested below with a value whose two halves move
  // at comparable rates.
  assert.ok(p.jaccard[0][1] > 0, "the two halves are coupled (positive Jaccard)");

  // Now a 16-bit value whose BOTH halves change on (almost) every frame: a
  // smoothly swept value crossing many 256-boundaries, e.g. step 257 so both
  // bytes advance every frame. They should land in one length-2 group.
  const swept = periodic(0x281, 10 * MS, 60, (n) => {
    const v = (n * 257) & 0xffff; // +1 to each byte every frame
    return [(v >> 8) & 0xff, v & 0xff];
  });
  const r2 = coOccurrence(swept);
  const q = r2.ids[0];
  assert.ok(q.jaccard[0][1] > 0.9, "both halves move every frame ⇒ Jaccard≈1");
  assert.equal(q.groups.length, 1, "one likely group");
  assert.deepEqual(
    { s: q.groups[0].startByte, e: q.groups[0].endByte, len: q.groups[0].length },
    { s: 0, e: 1, len: 2 },
    "the group spans the two adjacent halves",
  );
  assert.equal(q.groups[0].excluded, false, "not a tagged span");
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 — a byte that co-changes with MANY others ⇒ flagged as a hub
 * ──────────────────────────────────────────────────────────────────────── */

test("2) a byte co-changing with many others ⇒ a hub; independent bytes are not", () => {
  const id = 0x300;
  // bytes 0..2 each change on their own independent cadence. byte3 is a CHECKSUM-
  // like hub: it changes whenever ANY of bytes 0..2 changed (a multiplexor or a
  // checksum behaves this way). byte4 changes independently and rarely.
  const frames = periodic(id, 10 * MS, 120, (n) => {
    const a = n % 2;          // changes every frame
    const b = (n % 3 === 0) ? 1 : 0;
    const c = (n % 5 === 0) ? 1 : 0;
    const hub = (a + b * 2 + c * 4) & 0xff; // moves iff a, b, or c moved
    const indep = (n % 11 === 0) ? 1 : 0;
    return [a, b, c, hub, indep];
  });

  const res = coOccurrence(frames);
  const p = res.ids[0];

  // The hub (byte3) should be flagged: it strongly drives the other moving bytes.
  const hub = p.hubs.find((h) => h.byteIndex === 3);
  assert.ok(hub, "byte3 is flagged as a hub");
  assert.ok(hub!.degree >= CO_OCCURRENCE_DEFAULTS.hubMinDegree, "hub drives ≥ hubMinDegree bytes");

  // An independent byte (byte4) is NOT a hub.
  assert.ok(!p.hubs.some((h) => h.byteIndex === 4), "the independent byte is not a hub");

  // Conditional check on the hub's definition: whenever byte0 (which changes
  // every frame) changes, the hub also changes (the hub reflects byte0's bit).
  assert.equal(p.conditional[0][3], 1, "the hub changes whenever byte0 changes");
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 — short-DLC: a pair only counts (i,j) when both frames carry both bytes
 * ──────────────────────────────────────────────────────────────────────── */

test("3) short-DLC: a byte that comes and goes invents no phantom co-changes", () => {
  const id = 0x400;
  // byte0 toggles every frame and is ALWAYS present. byte2 exists only on the
  // long (odd-n) frames; when present it also toggles. Pairs alternate
  // short(1)→long(3)→short(1)…, so byte2 is carried by BOTH frames of a pair
  // NEVER (every pair has one short side) → no (0,2) co-change can be observed.
  const frames: CoOccurrenceFrame[] = [];
  for (let n = 0; n < 40; n++) {
    const b0 = n % 2;
    frames.push({
      id,
      tUs: n * 50 * MS,
      data: n % 2 === 0 ? [b0] : [b0, 0x00, n % 4 < 2 ? 1 : 0],
    });
  }

  let res!: ReturnType<typeof coOccurrence>;
  assert.doesNotThrow(() => {
    res = coOccurrence(frames);
  });
  const p = res.ids[0];
  assert.equal(p.maxByte, 3, "widest payload was 3 bytes");
  assert.equal(p.byteCount, 3, "three byte slots");

  // byte2 is never present on BOTH sides of any pair → its co-presence with any
  // byte is 0, and so are all its co-changes / ratios. No phantom coupling.
  assert.equal(p.coPresent[0][2], 0, "byte2 never co-present with byte0 in a pair");
  assert.equal(p.coChange[0][2], 0, "⇒ no co-change observed");
  assert.equal(p.jaccard[0][2], 0, "⇒ Jaccard 0 (not NaN)");
  assert.equal(p.conditional[0][2], 0, "⇒ conditional 0 (not NaN)");

  // byte0 itself was still measurable on every pair.
  assert.equal(p.present[0], 39, "byte0 present in all 39 pairs");
  assert.ok(p.changed[0] > 0, "byte0 changed (it toggles)");

  // A construction where byte2 IS co-present sometimes: two long frames in a row.
  const both: CoOccurrenceFrame[] = [
    { id: 0x401, tUs: 0, data: [0, 9, 0] },
    { id: 0x401, tUs: 10, data: [1, 9, 1] }, // both b0 and b2 change together
    { id: 0x401, tUs: 20, data: [0, 9, 0] }, // both change together again
    { id: 0x401, tUs: 30, data: [1, 9, 1] },
  ];
  const r2 = coOccurrence(both);
  const q = r2.ids[0];
  assert.equal(q.coPresent[0][2], 3, "all 3 pairs carry both bytes");
  assert.equal(q.coChange[0][2], 3, "they changed together on every pair");
  assert.equal(q.jaccard[0][2], 1, "Jaccard 1: they move as one");
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 — excludedBytes annotation, allow-list, minFrames, ordering, purity
 * ──────────────────────────────────────────────────────────────────────── */

test("4) excludedBytes annotation, allow-list, minFrames floor, ordering, purity", () => {
  assert.equal(CO_OCCURRENCE_DEFAULTS.maxBytes, 8, "classic CAN payload width");
  assert.equal(CO_OCCURRENCE_DEFAULTS.minFrames, 2, "need ≥2 frames for a pair");

  // A hub id where byte3 is the checksum the tagger flagged: the hub read-out
  // should carry excluded=true so the UI can name it a checksum, not a mux.
  const hubFrames = periodic(0x300, 10 * MS, 120, (n) => {
    const a = n % 2, b = (n % 3 === 0) ? 1 : 0, c = (n % 5 === 0) ? 1 : 0;
    return [a, b, c, (a + b * 2 + c * 4) & 0xff];
  });
  const excludedByIds = new Map<number, number[]>([[0x300, [3]]]);
  const res = coOccurrence(hubFrames, undefined, excludedByIds);
  const p = res.ids[0];
  assert.deepEqual(p.excludedBytes, [3], "the tagged byte is recorded");
  const hub = p.hubs.find((h) => h.byteIndex === 3);
  assert.ok(hub && hub.excluded, "the hub is annotated as excluded (checksum, not mux)");

  // minFrames floor: a single-frame id is dropped (no pair to measure).
  const thin: CoOccurrenceFrame[] = [{ id: 0x30, tUs: 0, data: [1, 2] }];
  const rich = periodic(0x281, 10 * MS, 40, (n) => {
    const v = (n * 257) & 0xffff;
    return [(v >> 8) & 0xff, v & 0xff];
  });
  const flat = periodic(0x20, 10 * MS, 40, () => [7, 7]); // never changes
  const all = [...rich, ...flat, ...thin];
  const r2 = coOccurrence(all);
  assert.equal(r2.idCount, 2, "the single-frame id is dropped below minFrames");
  assert.ok(!r2.ids.some((x) => x.id === 0x30), "thin id absent");
  // Most-structured first: the coupled 16-bit id outranks the never-changing id.
  assert.equal(r2.ids[0].id, 0x281, "the coupled id sorts first");
  assert.equal(r2.ids[1].id, 0x20, "the flat id sorts last");

  // Allow-list restricts to the flat id only.
  const only = coOccurrence(all, [0x20]);
  assert.equal(only.idCount, 1, "allow-list keeps a single id");
  assert.equal(only.ids[0].id, 0x20, "allow-listed id is the flat one");

  // Custom maxBytes clamps the matrix dimension.
  const wide = periodic(0x40, 10 * MS, 10, (n) => [n & 1, n & 1, n & 1, n & 1]);
  const narrow = coOccurrence(wide, undefined, undefined, { maxBytes: 2 });
  assert.equal(narrow.maxBytes, 2, "maxBytes threaded through");
  assert.equal(narrow.ids[0].byteCount, 2, "matrix dimension clamped to maxBytes");
  assert.equal(narrow.ids[0].jaccard.length, 2, "matrix is 2×2");

  // Purity: inputs are not mutated.
  const before = rich.map((f) => f.data.slice());
  coOccurrence(rich);
  rich.forEach((f, i) => assert.deepEqual(f.data, before[i], "input payloads unchanged"));
});
