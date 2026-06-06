// Unit tests for Brick 0 — the counter/checksum tagger (analysis/tagger.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as
// protocol.test.ts) — zero deps.
//
// The load-bearing test is #1: it replicates the simulator's exact encoding
// (backend/discodb2_backend/adapters/sim.py — d[6]=counter&0x0F, d[7]=XOR(d[0..6]))
// and pins that the tagger catches BOTH the nibble counter and the checksum
// while leaving the real signal bytes alone. If that regresses, the Wizard's
// scorers would start surfacing the counter/checksum as fake candidates.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tagFrames,
  excludedBytes,
  TAGGER_DEFAULTS,
  type RawFrame,
  type Tag,
} from "./tagger.ts";

/** XOR of bytes[0..7), matching sim.py `_checksum(d[:7])`. */
function xor(bytes: number[]): number {
  return bytes.reduce((x, b) => x ^ b, 0) & 0xff;
}

/** Find a tag of a given kind at a byte index (and optional nibble) or undefined. */
function findTag(tags: Tag[], kind: Tag["kind"], byteIndex: number, nibble?: "low" | "high"): Tag | undefined {
  return tags.find((t) => t.kind === kind && t.byteIndex === byteIndex && t.nibble === nibble);
}

// A small deterministic PRNG so tests are reproducible without a dep (mulberry32).
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

test("1) SIM scheme: byte6 low-nibble counter + byte7 XOR checksum caught, signal bytes left alone", () => {
  const id = 0x280;
  const frames: RawFrame[] = [];
  const r = rng(1);
  let counter = 0;

  // 64 frames = 4 full nibble wraps; plenty for the defaults.
  for (let n = 0; n < 64; n++) {
    counter = (counter + 1) & 0xffff;
    // Slowly varying physical signals + small noise (like rpm/load/coolant).
    const rpm = 800 + Math.round(40 * Math.sin(n / 8)) + Math.round((r() - 0.5) * 4);
    const d: number[] = [
      (rpm >> 8) & 0xff, // byte0: rpm high (BE)
      rpm & 0xff, // byte1: rpm low
      30 + (n % 5), // byte2: a slow ramp + tiny noise
      90 + Math.round(3 * Math.sin(n / 5)), // byte3: coolant-ish
      0, // byte4: unused/constant
      0, // byte5: unused/constant
      counter & 0x0f, // byte6: rolling counter in the LOW nibble (sim's d[6])
      0, // byte7: checksum (filled below)
    ];
    d[7] = xor(d.slice(0, 7)); // sim's d[7] = XOR(d[0..6])
    frames.push({ id, data: d });
  }

  const tags = tagFrames(frames);
  const idTags = tags.get(id);
  assert.ok(idTags, "id was analysed");

  // byte6 low nibble tagged as a +1 counter.
  const c = findTag(idTags!, "counter", 6, "low");
  assert.ok(c, "byte6 low-nibble tagged as counter");
  assert.equal(c!.step, 1, "detected step is +1");
  assert.ok(c!.confidence >= TAGGER_DEFAULTS.counterThreshold, "counter confidence over threshold");

  // byte7 tagged as a checksum, specifically the XOR-of-preceding-bytes scheme.
  const cs = findTag(idTags!, "checksum", 7);
  assert.ok(cs, "byte7 tagged as checksum");
  assert.equal(cs!.scheme, "xor-prefix", "scheme is XOR of the bytes before it (sim's d[:7])");
  assert.equal(cs!.confidence, 1, "checksum matches every frame");

  // The real signal bytes (0,1,2,3) must NOT be tagged — neither counter nor checksum.
  for (const b of [0, 1, 2, 3]) {
    assert.equal(findTag(idTags!, "counter", b), undefined, `signal byte${b} not a counter`);
    assert.equal(findTag(idTags!, "counter", b, "low"), undefined, `signal byte${b} low not a counter`);
    assert.equal(findTag(idTags!, "counter", b, "high"), undefined, `signal byte${b} high not a counter`);
    assert.equal(findTag(idTags!, "checksum", b), undefined, `signal byte${b} not a checksum`);
  }

  // excludedBytes exposes both offending bytes (keyed decimal "id:index").
  const excluded = excludedBytes(tags);
  assert.ok(excluded.has(`${id}:6`), "byte6 excluded");
  assert.ok(excluded.has(`${id}:7`), "byte7 excluded");
  assert.ok(!excluded.has(`${id}:0`), "byte0 (signal) not excluded");
});

test("2) pure-random chatter id: nothing tagged (no false positives)", () => {
  const id = 0x100;
  const frames: RawFrame[] = [];
  const r = rng(42);
  // 256 frames of independent random bytes — the adversarial no-structure case.
  for (let n = 0; n < 256; n++) {
    const d: number[] = [];
    for (let b = 0; b < 8; b++) d.push(Math.floor(r() * 256));
    frames.push({ id, data: d });
  }

  const tags = tagFrames(frames);
  const idTags = tags.get(id) ?? [];
  assert.deepEqual(idTags, [], "no tags on pure random chatter");
  assert.equal(excludedBytes(tags).size, 0, "nothing excluded");
});

test("3) full-byte counter (mod 256) is detected as a whole-byte counter", () => {
  const id = 0x222;
  const frames: RawFrame[] = [];
  // 300 frames so the byte wraps past 256 — proves mod-256 wrap handling.
  for (let n = 0; n < 300; n++) {
    frames.push({ id, data: [n & 0xff, 0x00] }); // byte0 = mod-256 counter, byte1 constant
  }

  const tags = tagFrames(frames);
  const idTags = tags.get(id);
  assert.ok(idTags, "id analysed");

  const c = findTag(idTags!, "counter", 0);
  assert.ok(c, "byte0 tagged as a whole-byte counter");
  assert.equal(c!.nibble, undefined, "whole byte, not a nibble");
  assert.equal(c!.step, 1, "step +1");
  assert.equal(c!.confidence, 1, "every transition fits");

  // It must NOT also be reported as two separate nibble counters (no double-tag).
  assert.equal(findTag(idTags!, "counter", 0, "low"), undefined, "not double-tagged as low nibble");
  assert.equal(findTag(idTags!, "counter", 0, "high"), undefined, "not double-tagged as high nibble");
});

test("3b) full-byte counter with a larger step (mod 256) — actual step is detected", () => {
  const id = 0x223;
  const frames: RawFrame[] = [];
  let v = 0;
  for (let n = 0; n < 300; n++) {
    frames.push({ id, data: [v & 0xff] });
    v += 5; // step of 5, wrapping
  }
  const c = findTag(tagFrames(frames).get(id)!, "counter", 0);
  assert.ok(c, "stepped counter detected");
  assert.equal(c!.step, 5, "detected the actual step (5), not assumed +1");
});

test("4) too few frames: no tags (don't over-claim on thin data)", () => {
  const id = 0x280;
  const frames: RawFrame[] = [];
  // Only 8 frames — below minTransitions/minFrames (16). Same SIM structure.
  let counter = 0;
  for (let n = 0; n < 8; n++) {
    counter += 1;
    const d = [10 + n, 20 + n, 0, 0, 0, 0, counter & 0x0f, 0];
    d[7] = xor(d.slice(0, 7));
    frames.push({ id, data: d });
  }

  const tags = tagFrames(frames);
  const idTags = tags.get(id) ?? [];
  assert.deepEqual(idTags, [], "no tags when frames are below the minimum");
  assert.equal(excludedBytes(tags).size, 0, "nothing excluded on thin data");
});

test("5) sum-mod-256 checksum scheme is recognised", () => {
  const id = 0x333;
  const frames: RawFrame[] = [];
  const r = rng(7);
  for (let n = 0; n < 40; n++) {
    const a = Math.floor(r() * 256);
    const b = Math.floor(r() * 256);
    const sum = (a + b) & 0xff; // byte2 = (byte0 + byte1) mod 256
    frames.push({ id, data: [a, b, sum] });
  }
  const cs = findTag(tagFrames(frames).get(id)!, "checksum", 2);
  assert.ok(cs, "sum checksum tagged");
  assert.equal(cs!.scheme, "sum-all", "scheme is sum-mod-256 of the others");
  assert.equal(cs!.confidence, 1, "matches every frame");
});

test("5b) CRC-8 (J1850, poly 0x1D) trailing checksum is recognised", () => {
  // Independent reference CRC so the test doesn't lean on the module's code.
  const crc8 = (bytes: number[]): number => {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b & 0xff;
      for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
    }
    return crc & 0xff;
  };
  const id = 0x444;
  const frames: RawFrame[] = [];
  const r = rng(11);
  for (let n = 0; n < 40; n++) {
    const body = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    frames.push({ id, data: [...body, crc8(body)] }); // byte3 = CRC8(bytes0..2)
  }
  const cs = findTag(tagFrames(frames).get(id)!, "checksum", 3);
  assert.ok(cs, "CRC-8 checksum tagged");
  assert.equal(cs!.scheme, "crc8", "scheme identified as crc8");
  assert.equal(cs!.confidence, 1, "matches every frame");
});

test("6) grouping by id and per-id independence", () => {
  // Interleave a counter id with a chatter id; counter must still be found and
  // the chatter must stay clean — proves arrival-order grouping per id.
  const counterId = 0x10;
  const chatterId = 0x20;
  const frames: RawFrame[] = [];
  const r = rng(99);
  let v = 0;
  for (let n = 0; n < 64; n++) {
    frames.push({ id: counterId, data: [v & 0xff] });
    v += 1;
    frames.push({ id: chatterId, data: [Math.floor(r() * 256), Math.floor(r() * 256)] });
  }

  const tags = tagFrames(frames);
  assert.ok(findTag(tags.get(counterId)!, "counter", 0), "interleaved counter still detected");
  assert.deepEqual(tags.get(chatterId), [], "interleaved chatter stays clean");
});

test("7) config override: a stricter threshold suppresses a marginal counter", () => {
  const id = 0x44;
  const frames: RawFrame[] = [];
  // A counter that glitches ~20% of the time: confidence ≈ 0.8.
  const r = rng(3);
  let v = 0;
  for (let n = 0; n < 200; n++) {
    frames.push({ id, data: [v & 0xff] });
    v += r() < 0.2 ? 2 : 1; // occasional double-step breaks the constant-step model
  }

  // Default (0.9) should reject this noisy counter.
  assert.deepEqual(tagFrames(frames).get(id), [], "noisy counter rejected at default threshold");
  // A permissive threshold accepts it (proves the knob is wired through).
  const loose = tagFrames(frames, { counterThreshold: 0.5 });
  assert.ok(findTag(loose.get(id)!, "counter", 0), "same data tagged when threshold lowered");
});

test("maxFrames cap: a counter + XOR checksum are still caught on a deep history, no-op below the cap", () => {
  const id = 0x2a0;
  // 20k frames (> default maxFrames 8192): byte0 = full-byte counter, byte7 =
  // XOR(byte0..6) checksum, bytes 1-3 slowly varying signal. The tagger walks only
  // the recent window but must still catch both structural bytes.
  const big: RawFrame[] = [];
  for (let n = 0; n < 20000; n++) {
    const d = [n & 0xff, (n * 3) & 0xff, 30 + (n % 7), (n >> 2) & 0xff, 0, 0, 0];
    d.push(xor(d)); // byte7 = XOR(byte0..6)
    big.push({ id, data: d });
  }
  const tags = tagFrames(big).get(id)!;
  assert.ok(findTag(tags, "counter", 0), "counter on byte0 caught within the recent window");
  assert.ok(findTag(tags, "checksum", 7), "XOR checksum on byte7 caught within the recent window");

  // No-op at/below the cap: capped (default) ≡ uncapped (maxFrames 0) when the id
  // has fewer than maxFrames frames.
  const small = big.slice(0, 4000);
  assert.deepEqual(
    tagFrames(small).get(id),
    tagFrames(small, { maxFrames: 0 }).get(id),
    "below the cap, windowing is a no-op",
  );
});
