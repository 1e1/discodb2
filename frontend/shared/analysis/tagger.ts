// discodb2 — Brick 0: the counter/checksum TAGGER (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Scoring → Brick 0 — counter/checksum
// tagger". This is the foundation the Event/Trend scorers stand on: it marks
// the bytes (and nibbles) that are NOT real signal — free-running counters and
// checksums — so the scorers can exclude them and never emit them as false
// candidates.
//
// Pure & framework-free (like protocol.ts): no Svelte/Vite/DOM-only deps, runs
// in the cockpit, a Web Worker, or a plain Node test runner. Mutates nothing,
// allocates fresh output.
//
// What "not real signal" means here:
//   • COUNTER — a value that advances by a (near-)constant step modulo 2^k and
//     wraps (k=8 for a whole byte, k=4 for a nibble). A wrapping counter is a
//     sawtooth: ρ≈0 over a multi-wrap window, so a trend scorer half-rejects it
//     anyway, but tagging is exact and also kills it for the event scorer.
//   • CHECKSUM — a byte that is a deterministic function of the other bytes of
//     the same frame (XOR of all others, XOR of the bytes before it, sum-mod-256
//     of the others, or a CRC-8). It changes whenever any payload byte changes,
//     so it would otherwise look like a perfect "event/trend" follower.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw classic-CAN frame in arrival order. `data` is 0..8 bytes (the frame's
 * DLC); each entry is a byte 0..255. We accept a plain `number[]` (the cheap
 * shape a decoder or a test hands us) — see protocol.ts `CanRecord` for the
 * richer on-wire record this is a thin projection of.
 */
export interface RawFrame {
  id: number;
  data: number[];
}

/** Which half of a byte a nibble-counter lives in. */
export type Nibble = "low" | "high";

/** The checksum function families we test a byte against. */
export type ChecksumScheme = "xor-all" | "xor-prefix" | "sum-all" | "crc8";

/**
 * A single tagged byte/nibble for one id. `kind` discriminates the meaningful
 * extra fields:
 *   • counter  → `step` (the detected constant step) and optional `nibble`.
 *   • checksum → `scheme` (which function matched).
 * `confidence` is the fraction of evidence (transitions / frames) that fit the
 * model, 0..1.
 */
export interface Tag {
  kind: "counter" | "checksum";
  /** Byte index within the frame payload. */
  byteIndex: number;
  /** Present only for counters detected on a nibble (else the whole byte). */
  nibble?: Nibble;
  /** Counter only: the detected per-frame increment (modulo 2^k). */
  step?: number;
  /** Checksum only: the matching scheme. */
  scheme?: ChecksumScheme;
  /** Fraction of the evidence that matched the model, 0..1. */
  confidence: number;
}

/** Tunable thresholds. Kept local & overridable; sane defaults below. */
export interface TaggerConfig {
  /** Min consecutive transitions of an id before counter detection is trusted. */
  minTransitions: number;
  /** Min frames of an id before checksum detection is trusted. */
  minFrames: number;
  /** Min fraction of transitions matching the constant-step+wrap model. */
  counterThreshold: number;
  /** Min fraction of frames where byte === f(others) to tag a checksum. */
  checksumThreshold: number;
}

export const TAGGER_DEFAULTS: TaggerConfig = {
  // A counter needs to be seen wrapping/advancing enough that noise can't fake
  // it: 16 transitions is one full wrap of a nibble plus margin.
  minTransitions: 16,
  minFrames: 16,
  counterThreshold: 0.9,
  checksumThreshold: 0.9,
};

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Tag the counter/checksum bytes across a stream of frames.
 *
 * Groups `frames` by id internally (arrival order is preserved within each id —
 * that order is what counter detection needs). Returns a Map from id to its
 * tags. Ids with no tagged bytes are present with an empty array iff they had
 * any frames, so callers can tell "analysed, nothing found" from "never seen".
 *
 * Pure: does not mutate `frames` or `config`.
 */
export function tagFrames(
  frames: ReadonlyArray<RawFrame>,
  config: Partial<TaggerConfig> = {},
): Map<number, Tag[]> {
  const cfg: TaggerConfig = { ...TAGGER_DEFAULTS, ...config };

  // Group payloads by id, preserving arrival order.
  const byId = new Map<number, number[][]>();
  for (const f of frames) {
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // Defensive copy clamped to bytes, so detectors can index freely.
    group.push(f.data.map((b) => b & 0xff));
  }

  const out = new Map<number, Tag[]>();
  for (const [id, group] of byId) {
    out.set(id, tagOneId(group, cfg));
  }
  return out;
}

/**
 * Flatten a tag map into the set of byte slots the scorers must skip, keyed
 * `"id:byteIndex"` (decimal id, decimal index). A nibble-counter excludes the
 * whole byte: half of a byte is never an independent physical signal worth
 * scoring, and a scorer keying on bytes shouldn't trip over it.
 */
export function excludedBytes(tags: Map<number, Tag[]>): Set<string> {
  const set = new Set<string>();
  for (const [id, list] of tags) {
    for (const t of list) {
      set.add(`${id}:${t.byteIndex}`);
    }
  }
  return set;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id detection
 * ──────────────────────────────────────────────────────────────────────── */

/** Run counter + checksum detection on one id's ordered payloads. */
function tagOneId(payloads: number[][], cfg: TaggerConfig): Tag[] {
  const tags: Tag[] = [];
  // Frames of one id can legally differ in length; use the max width seen and
  // only consider a slot on frames long enough to have it.
  const width = payloads.reduce((m, p) => Math.max(m, p.length), 0);

  for (let i = 0; i < width; i++) {
    tagCounterAt(payloads, i, cfg, tags);
  }

  // Checksums are resolved frame-wide (not per-byte in isolation): an XOR/sum
  // checksum makes EVERY other byte look like "XOR/sum of the rest", so naive
  // per-byte detection would tag all 8 bytes. See detectChecksums.
  tags.push(...detectChecksums(payloads, width, cfg));

  return tags;
}

/** Counter detection for a single byte index, pushing at most one tag. */
function tagCounterAt(payloads: number[][], i: number, cfg: TaggerConfig, tags: Tag[]): void {
  // Whole byte (mod 256), then each nibble (mod 16). The low nibble is the
  // sim's counter location (d[6] & 0x0F).
  const byteCounter = detectCounter(columnAt(payloads, i, (b) => b), 256, cfg);
  const lowCounter = detectCounter(columnAt(payloads, i, (b) => b & 0x0f), 16, cfg);
  const highCounter = detectCounter(columnAt(payloads, i, (b) => (b >> 4) & 0x0f), 16, cfg);

  // One byte yields up to three counter readings (whole, low, high) but it is
  // only ONE thing — report the single best interpretation, never all three.
  //
  //   • A true mod-256 +1 counter scores 1.0 as a byte AND 1.0 on its low
  //     nibble (the low nibble cycles 0..15 cleanly); we break that tie toward
  //     the whole byte (the larger, more specific claim).
  //   • A low-nibble-only counter (high nibble constant, e.g. the sim's
  //     d[6]&0x0F) scores <1.0 as a "byte" — its 15→0 step is a delta of 241,
  //     not 1 — but 1.0 on the low nibble, so the low nibble wins.
  //
  // Picking the max-confidence reading lets the data decide which it is.
  const best = bestCounter([
    byteCounter && { ...byteCounter, nibble: undefined as Nibble | undefined },
    lowCounter && { ...lowCounter, nibble: "low" as const },
    highCounter && { ...highCounter, nibble: "high" as const },
  ]);
  if (best) {
    tags.push({ kind: "counter", byteIndex: i, nibble: best.nibble, step: best.step, confidence: best.confidence });
  }
}

/**
 * Extract the sequence of values at byte index `i` (after `pick`, e.g. a nibble
 * mask) over only the frames long enough to have byte `i`. Frames too short are
 * skipped rather than zero-filled — a missing byte is not a value-0 sample.
 */
function columnAt(payloads: number[][], i: number, pick: (b: number) => number): number[] {
  const seq: number[] = [];
  for (const p of payloads) {
    if (i < p.length) seq.push(pick(p[i]));
  }
  return seq;
}

/* ────────────────────────────────────────────────────────────────────────
 * Counter detection
 * ──────────────────────────────────────────────────────────────────────── */

interface CounterHit {
  step: number;
  confidence: number;
}

/** A counter reading annotated with which slice (whole byte / nibble) it came from. */
interface NibbleCounterHit extends CounterHit {
  nibble: Nibble | undefined;
}

/**
 * Pick the single highest-confidence counter reading for one byte. Candidates
 * are given in preference order (whole byte, low, high), and ties keep the
 * earlier candidate — so a value that reads equally well as a whole byte and as
 * a nibble is reported as the whole byte.
 */
function bestCounter(candidates: Array<NibbleCounterHit | null | undefined | false>): NibbleCounterHit | null {
  let best: NibbleCounterHit | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (best === null || c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * Decide whether `seq` (values in [0, modulus)) is a constant-step counter
 * modulo `modulus`, wrapping.
 *
 * Method: every consecutive pair gives a wrapped delta `(b - a + modulus) %
 * modulus`. A genuine counter has one delta that dominates (its step); we take
 * the modal delta and score confidence = fraction of transitions equal to it.
 *
 * Guards against false positives:
 *   • step 0 is rejected (a constant byte is not a counter).
 *   • a value that never changes (or barely changes) can't reach threshold.
 *   • too few transitions → no hit (don't over-claim on thin data).
 */
function detectCounter(seq: number[], modulus: number, cfg: TaggerConfig): CounterHit | null {
  const transitions = seq.length - 1;
  if (transitions < cfg.minTransitions) return null;

  // Tally wrapped deltas.
  const counts = new Map<number, number>();
  for (let i = 1; i < seq.length; i++) {
    const delta = (seq[i] - seq[i - 1] + modulus) % modulus;
    counts.set(delta, (counts.get(delta) ?? 0) + 1);
  }

  // Modal delta (the candidate step), ignoring 0 (no advance).
  let bestStep = 0;
  let bestCount = 0;
  for (const [delta, c] of counts) {
    if (delta === 0) continue;
    if (c > bestCount) {
      bestCount = c;
      bestStep = delta;
    }
  }
  if (bestStep === 0) return null; // never advanced => constant, not a counter.

  const confidence = bestCount / transitions;
  if (confidence < cfg.counterThreshold) return null;

  return { step: bestStep, confidence };
}

/* ────────────────────────────────────────────────────────────────────────
 * Checksum detection
 * ──────────────────────────────────────────────────────────────────────── */

interface ChecksumHit {
  scheme: ChecksumScheme;
  confidence: number;
}

/** Asymmetric schemes depend only on the bytes BEFORE the target, so they
 *  pinpoint one byte; symmetric schemes (over ALL other bytes) over-match. */
const ASYMMETRIC: ReadonlySet<ChecksumScheme> = new Set(["xor-prefix", "crc8"]);
// Preference order; ties keep the earlier scheme. `xor-prefix` is listed before
// `xor-all` so a TRAILING checksum (where the two compute the same value) gets
// the narrower, more informative label.
const SCHEME_ORDER: ReadonlyArray<ChecksumScheme> = ["xor-prefix", "crc8", "xor-all", "sum-all"];

/**
 * Detect checksum bytes for one id, FRAME-WIDE.
 *
 * Why not per-byte in isolation: a real XOR checksum byte K satisfies
 * XOR(all bytes) = 0, which means EVERY other byte j also equals XOR(others) —
 * so a naive per-byte `xor-all` test tags all 8 bytes. The same holds for
 * sum-mod-256. We therefore:
 *   1. Score every (byte, scheme) pair (fraction of frames where byte === f).
 *   2. Take, per byte, its best qualifying scheme (≥ threshold), preferring an
 *      ASYMMETRIC scheme — those cannot be produced as a side effect of another
 *      byte's checksum, so they are trustworthy on their own.
 *   3. If any byte won via an asymmetric scheme, that's the checksum; suppress
 *      symmetric-only matches (they are the redundancy artifact). Otherwise keep
 *      a single symmetric match — the highest byte index (conventional trailing
 *      checksum position) — never all of them.
 */
function detectChecksums(payloads: number[][], width: number, cfg: TaggerConfig): Tag[] {
  const perByte: Array<{ byteIndex: number; hit: ChecksumHit } | null> = [];

  for (let i = 0; i < width; i++) {
    const frames = payloads.filter((p) => i < p.length);
    // Need evidence, ≥1 other byte to checksum over, and a byte that actually
    // varies (a constant byte carries no signal and can match degenerately).
    if (frames.length < cfg.minFrames) { perByte.push(null); continue; }
    if (frames.every((p) => p.length <= 1)) { perByte.push(null); continue; }
    const first = frames[0][i];
    if (frames.every((p) => p[i] === first)) { perByte.push(null); continue; }

    let best: ChecksumHit | null = null;
    for (const scheme of SCHEME_ORDER) {
      let matches = 0;
      for (const p of frames) if (p[i] === computeChecksum(scheme, p, i)) matches++;
      const confidence = matches / frames.length;
      if (confidence < cfg.checksumThreshold) continue;
      // Prefer higher confidence; on a tie prefer an asymmetric scheme (more
      // specific), else keep the earlier SCHEME_ORDER entry.
      if (
        best === null ||
        confidence > best.confidence ||
        (confidence === best.confidence && ASYMMETRIC.has(scheme) && !ASYMMETRIC.has(best.scheme))
      ) {
        best = { scheme, confidence };
      }
    }
    perByte.push(best ? { byteIndex: i, hit: best } : null);
  }

  const hits = perByte.filter((x): x is { byteIndex: number; hit: ChecksumHit } => x !== null);
  if (hits.length === 0) return [];

  const asym = hits.filter((h) => ASYMMETRIC.has(h.hit.scheme));
  if (asym.length > 0) {
    // Trustworthy: report each asymmetric checksum as found.
    return asym.map((h) => ({ kind: "checksum", byteIndex: h.byteIndex, scheme: h.hit.scheme, confidence: h.hit.confidence } as Tag));
  }

  // Only symmetric matches → the XOR/sum redundancy artifact. The genuine
  // checksum is conventionally the trailing byte; report just the highest index.
  const trailing = hits.reduce((a, b) => (b.byteIndex > a.byteIndex ? b : a));
  return [{ kind: "checksum", byteIndex: trailing.byteIndex, scheme: trailing.hit.scheme, confidence: trailing.hit.confidence }];
}

/** Compute scheme(payload) targeting byte index `target` (excluded from inputs). */
function computeChecksum(scheme: ChecksumScheme, p: number[], target: number): number {
  switch (scheme) {
    case "xor-all": {
      let x = 0;
      for (let j = 0; j < p.length; j++) if (j !== target) x ^= p[j];
      return x & 0xff;
    }
    case "xor-prefix": {
      // The sim's case: XOR of every byte BEFORE the checksum byte.
      let x = 0;
      for (let j = 0; j < target; j++) x ^= p[j];
      return x & 0xff;
    }
    case "sum-all": {
      let s = 0;
      for (let j = 0; j < p.length; j++) if (j !== target) s += p[j];
      return s & 0xff;
    }
    case "crc8":
      return crc8Prefix(p, target);
  }
}

/**
 * CRC-8 (SAE-J1850-ish: poly 0x1D, init 0x00, no reflection, no final XOR) over
 * the bytes BEFORE `target`. One concrete CRC is enough to catch the common
 * automotive case; the family of CRC params is large, so this is a representative
 * probe, not exhaustive coverage.
 */
function crc8Prefix(p: number[], target: number): number {
  let crc = 0x00;
  for (let j = 0; j < target; j++) {
    crc ^= p[j] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}
