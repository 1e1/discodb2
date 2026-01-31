// Unit tests for Brick 2 — the TREND SCORER (analysis/trend-scorer.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as
// event-scorer.test.ts / tagger.test.ts / protocol.test.ts) — zero deps.
//
// The load-bearing test is #1: a synthetic window where ONE chosen 16-bit BE
// field RAMPS UP with noise, ALONGSIDE a wrapping nibble counter (many wraps →
// a sawtooth that self-rejects), random chatter, and a tagger-excluded byte. It
// pins that the scorer ranks the real field #1 for direction 'up', the counter
// scores ~0, chatter never surfaces, and the tagger's exclusions are honoured.
// If that regresses, the Wizard's trend mode would surface noise/counters as
// candidates.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreTrend,
  compareStates,
  TREND_SCORER_DEFAULTS,
  type TimedFrame,
  type TrendWindow,
} from "./trend-scorer.ts";
// Brick 0, reused exactly as the integration will: tag the stream, exclude the
// counter/checksum bytes, hand that Set to the scorer.
import { tagFrames, excludedBytes, type RawFrame } from "./tagger.ts";

// Deterministic PRNG (mulberry32) — same one event-scorer.test.ts uses.
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

const MS = 1000; // µs per ms — the window and frames share the µs clock.

/**
 * Build a periodic stream for one id over `[0, durUs)`. `mkData(n, tUs)` returns
 * the payload for the n-th frame. (Same helper shape as event-scorer.test.ts.)
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

/** Pack a 16-bit value big-endian into two bytes [hi, lo]. */
function be16(v: number): [number, number] {
  return [(v >> 8) & 0xff, v & 0xff];
}

const RAMP_ID = 0x2c4;
const RAMP_OFF = 0; // bytes 0..1 = 16-bit BE ramp (e.g. RPM)
const COUNTER_OFF = 3; // byte3 low nibble = wrapping counter
const CHATTER_OFF = 5; // byte5 = random chatter

test("1) 16-bit BE ramp ranks #1 for 'up'; wrapping counter ~0; chatter rejected; excluded byte skipped", () => {
  const r = rng(1);
  const durMs = 4000;
  const periodMs = 20; // 50 Hz → 200 frames; many counter wraps over the window.
  const window: TrendWindow = { startTUs: 500 * MS, endTUs: 3500 * MS, direction: "up" };

  let counter = 0;
  const frames = periodic(RAMP_ID, periodMs * MS, durMs * MS, (n, _tUs) => {
    // 16-bit BE value rising 800 → ~6000 across the run, with ±30 noise (slosh).
    const base = 800 + Math.round((n / 200) * 5200);
    const rpm = base + Math.round((r() - 0.5) * 60);
    const [hi, lo] = be16(rpm & 0xffff);

    counter = (counter + 1) & 0x0f; // low-nibble counter: wraps every 16 frames.
    const d = [hi, lo, Math.floor(r() * 256), counter, 0, Math.floor(r() * 256)];
    // byte2 left as random chatter too; byte5 is the named chatter byte.
    return d;
  });

  // Brick 0 tags the wrapping counter byte; feed its exclusions to the scorer.
  const excluded = excludedBytes(tagFrames(frames as RawFrame[]));
  assert.ok(excluded.has(`${RAMP_ID}:${COUNTER_OFF}`), "tagger excluded the wrapping counter byte3");

  const res = scoreTrend(frames, window, excluded);

  assert.ok(res.framesInWindow > 0, "frames fell inside the window");
  assert.ok(res.candidates.length >= 1, "at least one candidate survived");

  // The 16-bit BE ramp is #1: correct field, rising slope, high |ρ|.
  const top = res.candidates[0];
  assert.equal(top.id, RAMP_ID, "#1 is the ramp id");
  assert.equal(top.byteIndex, RAMP_OFF, "#1 starts at byte0");
  assert.equal(top.width, 16, "#1 is a 16-bit field");
  assert.equal(top.byteOrder, "big", "#1 decoded big-endian");
  assert.equal(top.slopeSign, 1, "Theil–Sen slope is positive (rising)");
  assert.ok(top.score >= 0.95, `near-perfect monotone ramp (got ρ≈${top.score.toFixed(3)})`);

  // No candidate comes from the excluded counter byte, ever.
  for (const c of res.candidates) {
    assert.ok(
      !excluded.has(`${c.id}:${c.byteIndex}`) &&
        !(c.width === 16 && excluded.has(`${c.id}:${c.byteIndex + 1}`)),
      `excluded byte must not appear in candidate ${c.id}:${c.byteIndex}/${c.width}`,
    );
  }

  // The wrapping counter, scored DIRECTLY (no exclusion), self-rejects: a
  // multi-wrap sawtooth has |ρ| ≈ 0, far below threshold → never a candidate.
  const noExclusions = scoreTrend(frames, window, new Set<string>());
  const counterCand = noExclusions.candidates.find(
    (c) => c.id === RAMP_ID && c.byteIndex === COUNTER_OFF && c.width === 8,
  );
  assert.equal(counterCand, undefined, "wrapping counter self-rejects (|ρ|≈0 sawtooth)");

  // Random chatter never surfaces (with or without exclusions).
  assert.ok(
    !noExclusions.candidates.some((c) => c.id === RAMP_ID && c.byteIndex === CHATTER_OFF),
    "chatter byte5 is not a candidate",
  );
});

test("2) direction sign: a DECREASING field matches 'down', not 'up'", () => {
  const r = rng(2);
  const durMs = 4000;
  // 16-bit BE value falling 6000 → ~900 with noise.
  const frames = periodic(0x310, 20 * MS, durMs * MS, (n) => {
    const v = 6000 - Math.round((n / 200) * 5100) + Math.round((r() - 0.5) * 60);
    const [hi, lo] = be16(v & 0xffff);
    return [hi, lo];
  });

  const startTUs = 200 * MS;
  const endTUs = 3800 * MS;

  const down = scoreTrend(frames, { startTUs, endTUs, direction: "down" });
  const up = scoreTrend(frames, { startTUs, endTUs, direction: "up" });

  const top = down.candidates[0];
  assert.ok(top, "the decreasing field is a candidate for 'down'");
  assert.equal(top.id, 0x310);
  assert.equal(top.byteIndex, 0);
  assert.equal(top.width, 16);
  assert.equal(top.byteOrder, "big");
  assert.equal(top.slopeSign, -1, "Theil–Sen slope is negative (falling)");
  assert.ok(top.score >= 0.95, "strong monotone fall");

  // The SAME field must NOT be a candidate for the opposite direction — the
  // direction gate zeroes its score.
  assert.ok(
    !up.candidates.some((c) => c.id === 0x310 && c.byteIndex === 0 && c.width === 16),
    "a falling field is not surfaced for direction 'up'",
  );
});

test("3) Theil–Sen robustness: a net-downward field with big up-spikes (slosh) is still 'down'", () => {
  const r = rng(3);
  const durMs = 4000;
  const N = 200;
  // Net descent 5000 → ~1000, but ~1 in 8 samples is a large TRANSIENT UP-SPIKE
  // (fuel slosh hitting the sender): +2500..4000 above the trend for one frame.
  // A least-squares slope can be dragged toward 0/positive by these; Theil–Sen
  // (median of pairwise slopes) ignores them and still reads negative.
  const frames = periodic(0x222, 20 * MS, durMs * MS, (n) => {
    let v = 5000 - Math.round((n / N) * 4000) + Math.round((r() - 0.5) * 40);
    if (n % 8 === 3) v += 2500 + Math.floor(r() * 1500); // transient spike up
    const [hi, lo] = be16(Math.max(0, Math.min(0xffff, v)));
    return [hi, lo];
  });

  const res = scoreTrend(frames, { startTUs: 0, endTUs: durMs * MS, direction: "down" });
  const top = res.candidates.find((c) => c.id === 0x222 && c.byteIndex === 0 && c.width === 16);
  assert.ok(top, "the sloshing field is still detected as a 'down' candidate");
  assert.equal(top!.slopeSign, -1, "Theil–Sen kept the sign negative despite up-spikes");
  assert.ok(
    (top!.spearman ?? 0) < 0,
    "Spearman ρ is negative overall (the spikes don't flip the rank trend)",
  );
});

test("4) compareStates: the one byte that differs strongly (full vs low) ranks #1; counter/noise do not", () => {
  const r = rng(4);
  const id = 0x3d8;
  const periodMs = 20;
  const stateMs = 2000; // 100 frames per state

  // State helper: byte0 = the tank level (a STABLE level per state, tiny jitter),
  // byte1 = a wrapping counter (sweeps 0..255 within EACH state → not a level),
  // byte2 = pure chatter.
  let counter = 0;
  const mkState = (levelByte: number, durUs: number): TimedFrame[] =>
    periodic(id, periodMs * MS, durUs, () => {
      counter = (counter + 1) & 0xff;
      const level = (levelByte + Math.round((r() - 0.5) * 2)) & 0xff; // ±1 jitter
      return [level, counter, Math.floor(r() * 256)];
    });

  const full = mkState(240, stateMs * MS); // tank FULL  → byte0 ≈ 240
  const low = mkState(40, stateMs * MS); //  tank LOW   → byte0 ≈ 40

  // The counter byte sweeps its full range within a state, so don't even rely on
  // the tagger here — compareStates must reject it on intra-state spread alone.
  const res = compareStates(full, low);

  assert.ok(res.candidates.length >= 1, "a candidate survived");
  const top = res.candidates[0];
  assert.equal(top.id, id);
  assert.equal(top.byteIndex, 0, "the tank-level byte ranks #1");
  assert.equal(top.width, 8);
  assert.ok(Math.abs(top.delta ?? 0) >= 180, `large signed Δ reported (got ${top.delta})`);
  assert.ok((top.medianA ?? 0) > (top.medianB ?? 0), "full-state median exceeds low-state median");

  // Neither the counter byte nor the chatter byte is a stable level → rejected.
  assert.ok(
    !res.candidates.some((c) => c.byteIndex === 1),
    "the within-state counter byte is rejected (unstable level)",
  );
  assert.ok(
    !res.candidates.some((c) => c.byteIndex === 2),
    "the chatter byte is rejected (unstable level)",
  );
});

test("5) config: trendMinSpearman default matches WizardConfig; threshold gates weak trends", () => {
  assert.equal(TREND_SCORER_DEFAULTS.trendMinSpearman, 0.6, "default ρ floor is the WizardConfig value");

  const r = rng(5);
  // A field that drifts only WEAKLY upward, buried in heavy noise → |ρ| below
  // the 0.6 floor → not a candidate at the default, but kept at a low override.
  const frames = periodic(0x401, 40 * MS, 4000 * MS, (n) => {
    const v = 1000 + Math.round((n / 100) * 80) + Math.round((r() - 0.5) * 800);
    const [hi, lo] = be16(Math.max(0, Math.min(0xffff, v)));
    return [hi, lo];
  });
  const win: TrendWindow = { startTUs: 0, endTUs: 4000 * MS, direction: "up" };

  const strict = scoreTrend(frames, win);
  assert.ok(
    !strict.candidates.some((c) => c.id === 0x401 && c.width === 16),
    "weak/noisy drift gated out at the default 0.6 floor",
  );

  const loose = scoreTrend(frames, win, new Set<string>(), { trendMinSpearman: 0.1 });
  assert.ok(
    loose.candidates.some((c) => c.id === 0x401 && c.width === 16),
    "the same weak trend is kept once the floor is lowered",
  );
});
