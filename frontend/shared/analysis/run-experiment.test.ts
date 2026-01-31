// Unit tests for the Wizard INTEGRATION GLUE — runExperiment (analysis/run-experiment.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as
// tagger.test.ts / event-scorer.test.ts / trend-scorer.test.ts / protocol.test.ts)
// — zero deps, deterministic mulberry32 PRNG.
//
// The load-bearing fixtures prove the glue WIRES THE BRICKS together end to end
// on realistic data, one per mode:
//   #1 EVENT fixture — a handbrake-style bit flipping in phase with good events,
//      ALONGSIDE a rolling counter byte and random chatter. runExperiment must
//      pick event mode, surface the bit #1 in the UNIFIED shape, and have the
//      tagger's exclusion of the counter flow through so it never surfaces.
//   #2 TREND fixture — a fuel-style ramp field ALONGSIDE a wrapping counter.
//      runExperiment must pick trend mode and surface the field #1, with the
//      counter tagged/excluded.
//   #9 2-POINT (compare) fixture — a fuel byte HIGH in captured state A
//      (near-full) and LOWER in state B (under half), ALONGSIDE a rolling counter
//      byte and a chatter byte that churns within each state. runExperiment must
//      pick compare mode, surface the fuel byte #1 with a positive signed delta,
//      tag/exclude the counter, and reject the chatter on intra-state spread.
// If any regresses, the Wizard's seam would emit noise/counters as candidates
// or lose the per-mode mapping.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runExperiment,
  type ExperimentWindow,
} from "./run-experiment.ts";
import type { TimedFrame } from "./event-scorer.ts";

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

const MS = 1000; // µs per ms — marks and frames share the µs clock.

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

/** Set/clear `bit` of `byteIndex` in `data` (grows the array with zeros). */
function withBit(data: number[], byteIndex: number, bit: number, on: boolean): number[] {
  const d = data.slice();
  while (d.length <= byteIndex) d.push(0);
  d[byteIndex] = on ? d[byteIndex] | (1 << bit) : d[byteIndex] & ~(1 << bit);
  return d;
}

/** Pack a 16-bit value big-endian into two bytes [hi, lo]. */
function be16(v: number): [number, number] {
  return [(v >> 8) & 0xff, v & 0xff];
}

/* ────────────────────────────────────────────────────────────────────────
 * Fixture #1 — EVENT mode (handbrake bit + rolling counter + chatter)
 * ──────────────────────────────────────────────────────────────────────── */

const HB_ID = 0x5a0;
const HB_BYTE = 2;
const HB_BIT = 0;
const HB_COUNTER_BYTE = 5;

test("1) EVENT fixture: event mode surfaces the handbrake bit #1 (unified shape) and excludes the counter", () => {
  const r = rng(1);
  const durMs = 12000;

  // Three evenly spaced GOOD cues; the bit rises ~120ms after each cue and is
  // HELD ~1.5s (operator keeps the handbrake up through the feedback window),
  // covering the action segment [cue+guard, cue+guard+actionWindow].
  const cues = [2000, 6000, 10000];
  const latencyMs = 120;
  const holdMs = 1500;
  const active = (tUs: number): boolean =>
    cues.some((c) => tUs >= (c + latencyMs) * MS && tUs < (c + latencyMs + holdMs) * MS);

  // id 0x5A0 @ 50ms: byte2 bit0 = handbrake (flips with the action), byte5 = a
  // rolling +1 counter (Brick-0 fodder), byte0 = random chatter byte.
  let counter = 0;
  const hb = periodic(HB_ID, 50 * MS, durMs * MS, (_n, tUs) => {
    counter = (counter + 1) & 0xff;
    let d = [Math.floor(r() * 256), 0, 0, 0, 0, counter];
    d = withBit(d, HB_BYTE, HB_BIT, active(tUs)); // the signal
    return d;
  });

  // A second, unrelated id of pure chatter — must never out-rank the signal.
  const chatter = periodic(0x100, 80 * MS, durMs * MS, () => [
    Math.floor(r() * 256),
    Math.floor(r() * 256),
  ]);

  const frames: TimedFrame[] = [...hb, ...chatter].sort((a, b) => a.tUs - b.tUs);

  const win: ExperimentWindow = {
    frames,
    marks: {
      events: cues.map((c) => ({ at: c * MS, quality: "good" })),
    },
  };

  const res = runExperiment(win);

  // The glue dispatched to EVENT mode and reported the corpus stats.
  assert.equal(res.mode, "event", "events present → event mode");
  assert.equal(res.stats.mode, "event");
  assert.equal(res.stats.mode === "event" && res.stats.goodEvents, 3, "three good trials used");
  assert.equal(res.stats.mode === "event" && res.stats.totalEvents, 3, "three total events");

  // Brick 0 ran INSIDE the glue: the rolling counter byte was tagged & excluded.
  assert.ok(res.tags.get(HB_ID), "id 0x5A0 was tagged");
  assert.ok(res.excludedCount >= 1, "at least the counter byte was excluded");
  const counterTag = (res.tags.get(HB_ID) ?? []).find(
    (t) => t.kind === "counter" && t.byteIndex === HB_COUNTER_BYTE,
  );
  assert.ok(counterTag, "byte5 tagged as the rolling counter");

  // The handbrake bit is #1, in the UNIFIED shape, perfect score, right flip.
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");
  const top = res.candidates[0];
  assert.equal(top.mode, "event", "candidate carries its mode");
  assert.equal(top.id, HB_ID, "#1 is the handbrake id");
  assert.equal(top.byteIndex, HB_BYTE, "#1 is byte2");
  assert.ok(top.event, "event evidence block present");
  assert.equal(top.event!.bit, HB_BIT, "#1 is bit0");
  assert.equal(top.event!.direction, "0->1", "rises on the action");
  assert.equal(top.score, 1, "matched every good trial");
  assert.equal(top.key, `evt:${HB_ID}:${HB_BYTE}:${HB_BIT}`, "stable unified key");
  assert.equal(top.event!.evidence.length, 3, "evidence kept per good trial");
  assert.ok(
    top.event!.evidence.every((e) => e.rest === 0 && e.action === 1),
    "each trial: rest low, action high",
  );

  // NO candidate is the excluded counter byte, and no trend block leaks in.
  assert.ok(
    !res.candidates.some((c) => c.id === HB_ID && c.byteIndex === HB_COUNTER_BYTE),
    "the rolling counter is not a candidate (tagger exclusion flowed through)",
  );
  assert.ok(res.candidates.every((c) => c.trend === undefined), "no trend evidence in event mode");
  // Chatter id never out-ranks / surfaces as the signal.
  assert.ok(!res.candidates.some((c) => c.id === 0x100), "chatter id produced no candidate");
});

/* ────────────────────────────────────────────────────────────────────────
 * Fixture #2 — TREND mode (fuel-style ramp field + wrapping counter)
 * ──────────────────────────────────────────────────────────────────────── */

const FUEL_ID = 0x2c4;
const FUEL_OFF = 0; // bytes 0..1 = 16-bit BE fuel/RPM ramp
const TREND_COUNTER_OFF = 3; // byte3 low nibble = wrapping counter

test("2) TREND fixture: trend mode surfaces the ramp field #1 (unified shape); counter excluded", () => {
  const r = rng(2);
  const durMs = 4000;
  const periodMs = 20; // 50 Hz → 200 frames; many counter wraps over the window.
  const win: ExperimentWindow = {
    frames: [],
    marks: { trend: { startTUs: 500 * MS, endTUs: 3500 * MS, direction: "up" } },
  };

  let counter = 0;
  win.frames = periodic(FUEL_ID, periodMs * MS, durMs * MS, (n, _tUs) => {
    // 16-bit BE value rising 800 → ~6000 across the run, with ±30 noise (slosh).
    const base = 800 + Math.round((n / 200) * 5200);
    const v = base + Math.round((r() - 0.5) * 60);
    const [hi, lo] = be16(v & 0xffff);

    counter = (counter + 1) & 0x0f; // low-nibble counter: wraps every 16 frames.
    return [hi, lo, Math.floor(r() * 256), counter, 0, Math.floor(r() * 256)];
  });

  const res = runExperiment(win);

  // The glue dispatched to TREND mode and reported the corpus stats.
  assert.equal(res.mode, "trend", "trend present → trend mode");
  assert.equal(res.stats.mode, "trend");
  assert.ok(res.stats.mode === "trend" && res.stats.framesInWindow > 0, "frames fell in the window");

  // Brick 0 ran INSIDE the glue: the wrapping counter byte was tagged & excluded.
  assert.ok(res.excludedCount >= 1, "at least the counter byte was excluded");
  assert.ok(
    (res.tags.get(FUEL_ID) ?? []).some((t) => t.kind === "counter" && t.byteIndex === TREND_COUNTER_OFF),
    "byte3 tagged as the wrapping counter",
  );

  // The 16-bit BE ramp field is #1, in the UNIFIED shape, rising, high |ρ|.
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");
  const top = res.candidates[0];
  assert.equal(top.mode, "trend", "candidate carries its mode");
  assert.equal(top.id, FUEL_ID, "#1 is the ramp id");
  assert.equal(top.byteIndex, FUEL_OFF, "#1 starts at byte0");
  assert.ok(top.trend, "trend evidence block present");
  assert.equal(top.trend!.width, 16, "#1 is a 16-bit field");
  assert.equal(top.trend!.byteOrder, "big", "#1 decoded big-endian");
  assert.equal(top.trend!.signed, false, "#1 decoded unsigned");
  assert.equal(top.trend!.slopeSign, 1, "Theil–Sen slope is positive (rising)");
  assert.ok(top.score >= 0.95, `near-perfect monotone ramp (got ρ≈${top.score.toFixed(3)})`);
  assert.equal(top.key, `trnd:${FUEL_ID}:${FUEL_OFF}:16BEu`, "stable unified key");
  assert.ok((top.trend!.spearman ?? 0) > 0, "signed Spearman ρ is positive");

  // NO candidate is from the excluded counter byte (8-bit at off3 or a 16-bit
  // field overlapping it), and no event block leaks into trend mode.
  for (const c of res.candidates) {
    const w = c.trend?.width ?? 8;
    assert.ok(
      !(c.id === FUEL_ID && c.byteIndex === TREND_COUNTER_OFF) &&
        !(c.id === FUEL_ID && w === 16 && c.byteIndex + 1 === TREND_COUNTER_OFF),
      `excluded byte must not appear in candidate ${c.id}:${c.byteIndex}/${w}`,
    );
  }
  assert.ok(res.candidates.every((c) => c.event === undefined), "no event evidence in trend mode");
});

/* ────────────────────────────────────────────────────────────────────────
 * Wiring behaviours: merge, precedence, no-mark, config forwarding
 * ──────────────────────────────────────────────────────────────────────── */

test("3) caller exclusions are MERGED with the tagger's (union, both honoured)", () => {
  // A clean id with a real ramp and NO counter, so the tagger excludes nothing.
  const r = rng(3);
  const frames = periodic(0x310, 20 * MS, 4000 * MS, (n) => {
    const v = 800 + Math.round((n / 200) * 5200) + Math.round((r() - 0.5) * 40);
    return [...be16(v & 0xffff), Math.floor(r() * 256)];
  });

  // Caller pins byte0 (the real ramp's high byte) as externally-known noise.
  // A 16-bit field at off0 overlaps it, so the ramp must NOT surface; an 8-bit
  // field at byte2 (chatter) is unaffected by the exclusion.
  const win: ExperimentWindow = {
    frames,
    marks: { trend: { startTUs: 0, endTUs: 4000 * MS, direction: "up" } },
    excluded: new Set<string>([`${0x310}:0`]),
  };

  const res = runExperiment(win);
  assert.ok(res.excludedCount >= 1, "caller exclusion present in the merged set");
  assert.ok(
    !res.candidates.some((c) => c.id === 0x310 && c.byteIndex === 0),
    "caller-excluded byte0 (and the 16-bit field over it) is suppressed",
  );

  // Sanity: WITHOUT the caller exclusion the ramp at byte0 IS the #1 candidate,
  // proving the suppression above was caused by the merge, not by absence.
  const open = runExperiment({ ...win, excluded: undefined });
  assert.equal(open.candidates[0]?.id, 0x310, "ramp surfaces once the exclusion is removed");
  assert.equal(open.candidates[0]?.byteIndex, 0, "ramp is at byte0");
});

test("4) precedence & empty: events win over trend; no marks → empty 'none' result (tagger still ran)", () => {
  // Both marks present on the same simple handbrake-bit stream → event mode wins.
  const cues = [1000, 3000, 5000];
  const active = (tUs: number): boolean =>
    cues.some((c) => tUs >= (c + 100) * MS && tUs < (c + 100 + 1200) * MS);
  const frames = periodic(0x123, 50 * MS, 7000 * MS, (_n, tUs) =>
    withBit([0, 0, 0], 1, 3, active(tUs)),
  );

  const both = runExperiment({
    frames,
    marks: {
      events: cues.map((c) => ({ at: c * MS, quality: "good" })),
      trend: { startTUs: 0, endTUs: 7000 * MS, direction: "up" },
    },
  });
  assert.equal(both.mode, "event", "with both marks, event mode takes precedence");
  assert.equal(both.candidates[0]?.mode, "event", "candidate is an event candidate");
  assert.equal(both.candidates[0]?.event?.bit, 3, "the chosen bit is bit3");

  // No marks at all → nothing to score, but the tagger still ran on the frames.
  const none = runExperiment({ frames, marks: {} });
  assert.equal(none.mode, "none", "no mark → mode 'none'");
  assert.deepEqual(none.candidates, [], "no candidates without a mark");
  assert.equal(none.stats.mode, "none", "stats report the empty mode");
  assert.ok(none.tags.get(0x123), "the tagger still analysed the frames");
});

test("5) per-brick config forwards through (trend floor lowered rescues a weak ramp)", () => {
  const r = rng(5);
  // A field drifting only WEAKLY upward in heavy noise → |ρ| below the 0.6 floor
  // at the default, but kept once the floor is lowered via config.trend.
  const frames = periodic(0x401, 40 * MS, 4000 * MS, (n) => {
    const v = 1000 + Math.round((n / 100) * 80) + Math.round((r() - 0.5) * 800);
    return be16(Math.max(0, Math.min(0xffff, v)));
  });
  const marks = { trend: { startTUs: 0, endTUs: 4000 * MS, direction: "up" as const } };

  const strict = runExperiment({ frames, marks });
  assert.ok(
    !strict.candidates.some((c) => c.id === 0x401 && c.trend?.width === 16),
    "weak drift gated out at the default 0.6 floor",
  );

  const loose = runExperiment({ frames, marks }, { trend: { trendMinSpearman: 0.1 } });
  assert.ok(
    loose.candidates.some((c) => c.id === 0x401 && c.trend?.width === 16),
    "the same weak trend is kept once the floor is lowered via config",
  );
});

test("6) failed event trials are ignored by the glue (delegates to scoreEvents)", () => {
  // Four cues; the 3rd is FAILED and the bit deliberately does NOT flip there.
  // The unified result must reflect 3 good / 4 total and a perfect score.
  const events: { at: number; quality: "good" | "failed" }[] = [
    { at: 2000 * MS, quality: "good" },
    { at: 5000 * MS, quality: "good" },
    { at: 8000 * MS, quality: "failed" }, // operator missed: no flip
    { at: 11000 * MS, quality: "good" },
  ];
  const goodActive = (tUs: number): boolean =>
    events
      .filter((e) => e.quality === "good")
      .some((e) => tUs >= e.at + 100 * MS && tUs < e.at + (100 + 1500) * MS);

  const frames = periodic(0x5a0, 50 * MS, 13000 * MS, (_n, tUs) =>
    withBit([0, 0, 0], 2, 0, goodActive(tUs)),
  );

  const res = runExperiment({ frames, marks: { events } });
  assert.equal(res.mode, "event");
  assert.equal(res.stats.mode === "event" && res.stats.goodEvents, 3, "3 good trials used");
  assert.equal(res.stats.mode === "event" && res.stats.totalEvents, 4, "4 total events reported");
  const top = res.candidates[0];
  assert.equal(top.score, 1, "failed trial ignored → perfect 3/3, not 3/4");
  assert.equal(top.event?.evidence.length, 3, "only good trials in the evidence");
});

test("7) empty events array does NOT shadow a real trend (regression: length > 0 guard)", () => {
  // marks.events = [] is truthy but carries no confirmed instants, so it must
  // NOT win over a populated trend mark — and alone it must yield 'none'.
  const r = rng(7);
  const frames = periodic(0x2c4, 20 * MS, 4000 * MS, (n) =>
    be16((800 + Math.round((n / 200) * 5200) + Math.round((r() - 0.5) * 40)) & 0xffff),
  );

  const both = runExperiment({
    frames,
    marks: { events: [], trend: { startTUs: 0, endTUs: 4000 * MS, direction: "up" } },
  });
  assert.equal(both.mode, "trend", "empty events falls through to trend mode");
  assert.equal(both.candidates[0]?.id, 0x2c4, "the ramp surfaces in trend mode");

  const alone = runExperiment({ frames, marks: { events: [] } });
  assert.equal(alone.mode, "none", "empty events alone → 'none', not 'event'");
  assert.deepEqual(alone.candidates, [], "no candidates");
});

test("8) deterministic & input-immutable (the file's headline guarantees)", () => {
  const cues = [2000, 6000, 10000];
  const active = (tUs: number): boolean =>
    cues.some((c) => tUs >= (c + 120) * MS && tUs < (c + 120 + 1500) * MS);
  const frames = periodic(0x5a0, 50 * MS, 12000 * MS, (_n, tUs) =>
    withBit([0, 0, 0, 0, 0, 0], 2, 0, active(tUs)),
  );
  const events = cues.map((c) => ({ at: c * MS, quality: "good" as const }));
  const excluded = new Set<string>([`${0x5a0}:5`]);

  const lenBefore = frames.length;
  const firstData = frames[0].data;
  const firstDataCopy = firstData.slice();
  const exclSizeBefore = excluded.size;

  // Deterministic: reversing the input frame order yields identical ordering.
  const a = runExperiment({ frames, marks: { events }, excluded });
  const b = runExperiment({ frames: [...frames].reverse(), marks: { events }, excluded });
  assert.deepEqual(
    a.candidates.map((c) => c.key),
    b.candidates.map((c) => c.key),
    "candidate ordering is independent of input frame order",
  );

  // Immutable: none of the inputs were touched.
  assert.equal(frames.length, lenBefore, "frames array not mutated");
  assert.equal(frames[0].data, firstData, "frame payload identity preserved");
  assert.deepEqual(frames[0].data, firstDataCopy, "frame payload contents unchanged");
  assert.equal(excluded.size, exclSizeBefore, "caller's excluded Set not mutated");
});

/* ────────────────────────────────────────────────────────────────────────
 * Fixture #9 — 2-POINT / compare mode (fuel level FULL vs LOW + counter + chatter)
 * ──────────────────────────────────────────────────────────────────────────
 * A single id captured in two steady states the operator drove by hand (tank
 * near-full, then under half — the FULL-vs-LOW case that can't be ramped):
 *   byte0 = the FUEL LEVEL — HIGH (~230) in window A, LOWER (~100) in window B,
 *           steady within each (small slosh) → the signal we want #1.
 *   byte1 = a rolling +1 counter → tagged by Brick 0 and excluded.
 *   byte2 = a CHATTER byte churning across its whole range within EACH state →
 *           NOT a counter/checksum (so the tagger leaves it), but its huge
 *           intra-state spread makes compareStates reject it (it's not a level).
 *   byte3 = constant 0 → a stable level but with zero between-state change, so
 *           its score is 0 and it never ranks.
 * The two capture windows are slices of the SAME frame history by tUs; the gap
 * between them (where the operator was draining) is in neither window.
 */
const FUEL2_ID = 0x480;
const FUEL2_BYTE = 0;
const FUEL2_COUNTER_BYTE = 1;
const FUEL2_CHATTER_BYTE = 2;

test("9) 2-POINT fixture: compare mode surfaces the fuel byte #1 (positive Δ); counter excluded, chatter rejected", () => {
  const r = rng(9);
  const periodMs = 50; // 20 Hz.

  // State A = [0, 2000ms]  (≈40 frames, near-full); the operator then drains;
  // State B = [4000, 6000ms] (≈40 frames, under half). The 2000..4000ms gap is
  // captured by neither window.
  const aWin = { startTUs: 0, endTUs: 2000 * MS };
  const bWin = { startTUs: 4000 * MS, endTUs: 6000 * MS };
  const durMs = 6000;

  const FUEL_A = 230; // near-full level
  const FUEL_B = 100; // under-half level
  const inA = (tUs: number) => tUs <= aWin.endTUs;
  const inB = (tUs: number) => tUs >= bWin.startTUs && tUs <= bWin.endTUs;

  let counter = 0;
  const frames = periodic(FUEL2_ID, periodMs * MS, durMs * MS, (_n, tUs) => {
    // Fuel: steady high in A, steady lower in B, with ±2 slosh; mid-drain in the
    // gap (a falling value there is irrelevant — neither window sees it).
    let fuel: number;
    if (inA(tUs)) fuel = FUEL_A + Math.round((r() - 0.5) * 4);
    else if (inB(tUs)) fuel = FUEL_B + Math.round((r() - 0.5) * 4);
    else fuel = FUEL_A - Math.round(((tUs / MS - aWin.endTUs / MS) / 2000) * (FUEL_A - FUEL_B));

    counter = (counter + 1) & 0xff; // rolling +1 counter, no wrap needed to tag.
    const chatter = Math.floor(r() * 256); // churns full-range within each state.
    return [fuel & 0xff, counter, chatter, 0];
  });

  const win: ExperimentWindow = {
    frames,
    marks: { compare: { a: aWin, b: bWin } },
  };

  const res = runExperiment(win);

  // The glue dispatched to COMPARE mode and reported the per-state frame counts.
  assert.equal(res.mode, "compare", "compare mark present → compare mode");
  assert.equal(res.stats.mode, "compare");
  assert.ok(res.stats.mode === "compare" && res.stats.framesA > 0, "state A captured frames");
  assert.ok(res.stats.mode === "compare" && res.stats.framesB > 0, "state B captured frames");

  // Brick 0 ran INSIDE the glue (over ALL frames, not just a window): the rolling
  // counter byte was tagged & excluded.
  assert.ok(res.excludedCount >= 1, "at least the counter byte was excluded");
  assert.ok(
    (res.tags.get(FUEL2_ID) ?? []).some((t) => t.kind === "counter" && t.byteIndex === FUEL2_COUNTER_BYTE),
    "byte1 tagged as the rolling counter",
  );

  // The fuel byte is #1, in the UNIFIED shape, with a POSITIVE signed delta
  // (A near-full > B under-half) and the right per-state medians.
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");
  const top = res.candidates[0];
  assert.equal(top.mode, "compare", "candidate carries its mode");
  assert.equal(top.id, FUEL2_ID, "#1 is the fuel id");
  assert.equal(top.byteIndex, FUEL2_BYTE, "#1 is byte0");
  assert.ok(top.compare, "compare evidence block present");
  assert.equal(top.compare!.width, 8, "#1 is an 8-bit field");
  assert.ok(top.compare!.delta > 0, `signed Δ is positive, A>B (got ${top.compare!.delta})`);
  // Robust to the ±2 slosh: medians land near the steady levels, Δ near +130.
  assert.ok(Math.abs(top.compare!.medianA - FUEL_A) <= 3, `median_A ≈ ${FUEL_A}`);
  assert.ok(Math.abs(top.compare!.medianB - FUEL_B) <= 3, `median_B ≈ ${FUEL_B}`);
  assert.ok(top.compare!.delta >= 120 && top.compare!.delta <= 140, "Δ ≈ full−half level shift");
  assert.equal(top.key, `cmp:${FUEL2_ID}:${FUEL2_BYTE}:8BEu`, "stable unified compare key");
  assert.equal(top.compare!.medianA - top.compare!.medianB, top.compare!.delta, "delta = median_A − median_B");

  // The counter never surfaces (tagger exclusion flowed through); the chatter is
  // rejected for high intra-state spread (it is not a stable level in either
  // state), so neither byte1 nor byte2 appears as a candidate, at ANY width.
  for (const c of res.candidates) {
    const w = c.compare?.width ?? 8;
    assert.notEqual(c.id === FUEL2_ID && c.byteIndex === FUEL2_COUNTER_BYTE, true, "counter byte never a candidate");
    assert.ok(
      !(c.id === FUEL2_ID && c.byteIndex === FUEL2_CHATTER_BYTE) &&
        !(c.id === FUEL2_ID && w === 16 && c.byteIndex + 1 === FUEL2_CHATTER_BYTE),
      `chatter byte must not appear in candidate ${c.id}:${c.byteIndex}/${w} (high intra-state spread)`,
    );
  }
  // Wrong mode's evidence never leaks into a compare result.
  assert.ok(res.candidates.every((c) => c.event === undefined && c.trend === undefined), "only compare evidence");
});

test("10) compare precedence & empty: events>trend>compare; compare alone runs; no usable frames → empty", () => {
  const r = rng(10);
  const periodMs = 50;
  const durMs = 6000;
  const aWin = { startTUs: 0, endTUs: 2000 * MS };
  const bWin = { startTUs: 4000 * MS, endTUs: 6000 * MS };
  const inA = (tUs: number) => tUs <= aWin.endTUs;
  const inB = (tUs: number) => tUs >= bWin.startTUs && tUs <= bWin.endTUs;

  // A clean fuel-level stream (no counter) so compare alone yields a candidate.
  const frames = periodic(0x480, periodMs * MS, durMs * MS, (_n, tUs) => {
    const fuel = inA(tUs) ? 230 + Math.round((r() - 0.5) * 4)
      : inB(tUs) ? 100 + Math.round((r() - 0.5) * 4)
      : 165;
    return [fuel & 0xff, 0];
  });
  const compare = { a: aWin, b: bWin };

  // compare ALONE → compare mode with the fuel byte surfacing.
  const alone = runExperiment({ frames, marks: { compare } });
  assert.equal(alone.mode, "compare", "compare mark alone → compare mode");
  assert.equal(alone.candidates[0]?.id, 0x480, "the fuel level surfaces in compare mode");
  assert.equal(alone.candidates[0]?.byteIndex, 0, "the fuel byte is byte0");

  // trend BEATS compare (a directional ramp is richer than two snapshots).
  const overTrend = runExperiment({
    frames,
    marks: { trend: { startTUs: 0, endTUs: durMs * MS, direction: "down" }, compare },
  });
  assert.equal(overTrend.mode, "trend", "trend takes precedence over compare");

  // NON-EMPTY events beat compare (the most specific evidence wins).
  const cues = [500, 2500, 4500];
  const overEvents = runExperiment({
    frames,
    marks: { events: cues.map((c) => ({ at: c * MS, quality: "good" as const })), compare },
  });
  assert.equal(overEvents.mode, "event", "non-empty events take precedence over compare");

  // An EMPTY events array must NOT shadow a real compare mark.
  const emptyEvents = runExperiment({ frames, marks: { events: [], compare } });
  assert.equal(emptyEvents.mode, "compare", "empty events fall through to compare");

  // Compare windows that capture too few frames (below minSamples=8) → compare
  // mode still RUNS (the mark was present), but yields no candidates.
  const thin = runExperiment({
    frames,
    marks: { compare: { a: { startTUs: 0, endTUs: 50 * MS }, b: { startTUs: 4000 * MS, endTUs: 4050 * MS } } },
  });
  assert.equal(thin.mode, "compare", "a present compare mark always runs compare mode");
  assert.deepEqual(thin.candidates, [], "too few captured frames per state → no candidates");
});
