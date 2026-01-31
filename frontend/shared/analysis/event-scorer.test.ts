// Unit tests for Brick 1 — the EVENT SCORER (analysis/event-scorer.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as tagger.test.ts
// / protocol.test.ts) — zero deps.
//
// The load-bearing test is #1: a synthetic stream where ONE chosen bit (the
// "handbrake", id 0x5A0 byte2 bit0) flips 0->1 inside every good action window
// and back at rest, ALONGSIDE a rolling counter byte (which the Brick-0 tagger
// excludes) and random chatter bits. It pins that the scorer ranks the real bit
// #1, never surfaces the counter/chatter, and honours the tagger's exclusions.
// If that regresses, the Wizard's event mode would surface noise as candidates.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreEvents,
  EVENT_SCORER_DEFAULTS,
  type TimedFrame,
  type EventMark,
} from "./event-scorer.ts";
// Brick 0, reused exactly as the integration will: tag the stream, exclude the
// counter/checksum bytes, hand that Set to the scorer.
import { tagFrames, excludedBytes, type RawFrame } from "./tagger.ts";

// Deterministic PRNG (mulberry32) — same one tagger.test.ts uses.
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

/** True while time `tUs` is inside a good trial's "action held" interval. */
type Active = (tUs: number) => boolean;

/**
 * Build a periodic stream for one id over `[0, durUs)`. `mkData(n, tUs)` returns
 * the payload for the n-th frame; the bit-setting is the test's job.
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

/**
 * Three evenly spaced good events; the bit is "held" for `holdMs` starting
 * `latencyMs` after each cue (latency models human + CAN reaction). Returns the
 * marks and an `Active` predicate over the held intervals.
 */
function trial(
  events: { atMs: number; quality: "good" | "failed" }[],
  latencyMs: number,
  holdMs: number,
): { marks: EventMark[]; active: Active } {
  const marks: EventMark[] = events.map((e) => ({ at: e.atMs * MS, quality: e.quality }));
  // Only GOOD trials actually flip the bit (a failed trial = no action taken).
  const goodWindows = events
    .filter((e) => e.quality === "good")
    .map((e) => ({ from: (e.atMs + latencyMs) * MS, to: (e.atMs + latencyMs + holdMs) * MS }));
  const active: Active = (tUs) => goodWindows.some((w) => tUs >= w.from && tUs < w.to);
  return { marks, active };
}

const HANDBRAKE_ID = 0x5a0;
const HB_BYTE = 2;
const HB_BIT = 0;

test("1) chosen handbrake bit ranks #1; counter & chatter rejected; excluded bytes never appear", () => {
  const r = rng(1);
  const durMs = 12000;
  // Cues at 2s, 6s, 10s; the bit rises ~120ms after the cue and is HELD ~1.5s
  // (the operator keeps the handbrake up through the feedback window), which
  // comfortably covers the action segment [cue+guard, cue+guard+actionWindow].
  const { marks, active } = trial(
    [
      { atMs: 2000, quality: "good" },
      { atMs: 6000, quality: "good" },
      { atMs: 10000, quality: "good" },
    ],
    120,
    1500,
  );

  // id 0x5A0 @ 50ms: byte2 bit0 = handbrake (flips with the action), byte5 = a
  // rolling +1 counter (Brick-0 fodder), byte0 = random chatter byte.
  let counter = 0;
  const hb = periodic(HANDBRAKE_ID, 50 * MS, durMs * MS, (_n, tUs) => {
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

  // Brick 0 tags the counter byte; feed its exclusions to the scorer.
  const excluded = excludedBytes(tagFrames(frames as RawFrame[]));
  assert.ok(excluded.has(`${HANDBRAKE_ID}:5`), "tagger excluded the rolling counter byte5");

  const res = scoreEvents(frames, marks, excluded);

  assert.equal(res.goodEvents, 3, "all three trials were good");
  assert.equal(res.totalEvents, 3, "total events reported");
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");

  // The handbrake bit is #1, perfect score, correct direction.
  const top = res.candidates[0];
  assert.equal(top.id, HANDBRAKE_ID, "#1 is the handbrake id");
  assert.equal(top.byteIndex, HB_BYTE, "#1 is byte2");
  assert.equal(top.bit, HB_BIT, "#1 is bit0");
  assert.equal(top.direction, "0->1", "rises on the action");
  assert.equal(top.score, 1, "matched every good trial");
  assert.equal(top.evidence.length, 3, "evidence kept per good trial");
  assert.ok(
    top.evidence.every((e) => e.rest === 0 && e.action === 1),
    "each trial: rest low, action high",
  );

  // No candidate is from an excluded byte (the counter), ever.
  for (const c of res.candidates) {
    assert.ok(!excluded.has(`${c.id}:${c.byteIndex}`), `excluded byte ${c.id}:${c.byteIndex} must not be a candidate`);
  }
  // The counter byte5 and any chatter id contribute no surviving candidate.
  assert.ok(
    !res.candidates.some((c) => c.id === HANDBRAKE_ID && c.byteIndex === 5),
    "rolling counter is not a candidate",
  );
  assert.ok(!res.candidates.some((c) => c.id === 0x100), "chatter id produced no candidate");
});

test("2) failed trials are ignored — a miss does not drag the score down", () => {
  // Four cues; the 3rd is FAILED and the bit deliberately does NOT flip there.
  // The scorer must use only the 3 good trials → perfect score, not 3/4.
  const events = [
    { atMs: 2000, quality: "good" as const },
    { atMs: 5000, quality: "good" as const },
    { atMs: 8000, quality: "failed" as const }, // operator missed: no flip
    { atMs: 11000, quality: "good" as const },
  ];
  const { marks } = trial(events, 100, 1500);

  // Build the active predicate from the GOOD events only (failed → no action).
  const goodActive: Active = (tUs) =>
    events
      .filter((e) => e.quality === "good")
      .some((e) => tUs >= (e.atMs + 100) * MS && tUs < (e.atMs + 100 + 1500) * MS);

  const frames = periodic(HANDBRAKE_ID, 50 * MS, 13000 * MS, (_n, tUs) =>
    withBit([0, 0, 0], HB_BYTE, HB_BIT, goodActive(tUs)),
  );

  const res = scoreEvents(frames, marks);
  assert.equal(res.goodEvents, 3, "3 good trials used");
  assert.equal(res.totalEvents, 4, "4 total events reported");

  const top = res.candidates[0];
  assert.equal(top.id, HANDBRAKE_ID);
  assert.equal(top.byteIndex, HB_BYTE);
  assert.equal(top.bit, HB_BIT);
  assert.equal(top.score, 1, "failed trial ignored → still a perfect 3/3, not 3/4");
  assert.equal(top.evidence.length, 3, "only good trials in the evidence");
});

test("3) no-signal case: no bit correlates with the events → nothing reaches threshold", () => {
  const r = rng(7);
  const { marks } = trial(
    [
      { atMs: 2000, quality: "good" },
      { atMs: 6000, quality: "good" },
      { atMs: 10000, quality: "good" },
    ],
    120,
    600,
  );

  // Pure random bytes, uncorrelated with the cue times.
  const frames = periodic(0x321, 40 * MS, 12000 * MS, () => {
    const d: number[] = [];
    for (let b = 0; b < 4; b++) d.push(Math.floor(r() * 256));
    return d;
  });

  const res = scoreEvents(frames, marks);
  assert.equal(res.goodEvents, 3, "good count still reported");
  assert.equal(res.candidates.length, 0, "no candidate reaches eventConsistency on noise");
});

test("4) latency: a flip well after the cue is still captured by cueGuardMs", () => {
  // The bit only rises 250ms AFTER the cue — inside the 300ms guard, so the REST
  // segment (before the cue) reads low and the ACTION segment (after the guard)
  // reads high. A naive "sample at the cue" reader would miss this.
  const guardMs = EVENT_SCORER_DEFAULTS.cueGuardMs; // 300
  assert.equal(guardMs, 300, "guard is the WizardConfig default");

  const latencyMs = 250; // < guard, so the action window still sees the flip
  const { marks, active } = trial(
    [
      { atMs: 2000, quality: "good" },
      { atMs: 6000, quality: "good" },
      { atMs: 10000, quality: "good" },
    ],
    latencyMs,
    1500, // held through the feedback window, past the action segment
  );

  const frames = periodic(HANDBRAKE_ID, 50 * MS, 12000 * MS, (_n, tUs) =>
    withBit([0, 0, 0], HB_BYTE, HB_BIT, active(tUs)),
  );

  const res = scoreEvents(frames, marks);
  const top = res.candidates[0];
  assert.ok(top, "a candidate survived despite the post-cue latency");
  assert.equal(top.id, HANDBRAKE_ID);
  assert.equal(top.byteIndex, HB_BYTE);
  assert.equal(top.bit, HB_BIT);
  assert.equal(top.score, 1, "guard captured the delayed flip on every trial");
  assert.ok(
    top.evidence.every((e) => e.rest === 0 && e.action === 1),
    "rest low before the cue, action high after the guard",
  );
});
