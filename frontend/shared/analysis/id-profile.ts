// discodb2 — PASSIVE analyzer: the CUMULATIVE PER-ID PROFILE (frontend/shared/analysis).
//
// SOURCE OF TRUTH: the decoding-strategy step back (see the project memory
// "CAN multiplexor & decoding reality"). This analyzer is the SUBSTRATE the rest
// of the decode pipeline leans on: before we try to detect a discriminator
// (message-ID / multiplexor) or discover a signal, we need a single, unified
// picture of what each byte and each BIT of an id is DOING over the whole
// history — which slots are CONSTANT (and therefore carry no information), which
// are counters/checksums (structure, but never a discriminator), and which are
// the genuine CANDIDATES worth deducing over.
//
// It is a pure COMPOSITION of the three existing passive analyzers — it does NOT
// recompute their work:
//   • byte-histogram → per-byte distinct/min/max/samples  (distinct ≤ 1 ⇒ constant)
//   • bit-activity   → per-bit toggle activity + constant flag (the SUB-BYTE view;
//                      real automotive discriminators are 82% sub-byte, so the bit
//                      grain matters, not just the byte grain)
//   • tagger         → counter/checksum byte exclusion
// and folds them into ONE per-id profile plus the derived CONSTANT-EXCLUSION:
// `constantBytes` (ignore these — incl. the OBD2 padding that "stays at 0") and
// `candidateBytes` (non-constant, non-counter/checksum — the search space for the
// discriminator/signal detectors that build on top of this).
//
// CUMULATIVE: like the analyzers it composes, it is PURE over the frames it is
// given. "Cumulative / since-connect" is the CALLER's responsibility — it passes
// the FULL ring (not just the rendered window), so a byte that is constant "since
// the start" is judged over the whole history. Two honest caveats the caller must
// respect: (1) the ring is bounded (~8 min @ 2 kfps), so "since the start" means
// "as far back as the ring still holds"; (2) "constant so far" ≠ "constant
// forever" (an OBD2 PID arrives later), so re-profile as the history grows. An
// incremental O(1)/frame cache is a later cockpit-seam optimization; this pure
// layer simply re-derives over whatever frames it receives, matching the idiom of
// byte-histogram / bit-activity.
//
// Pure & framework-free: no Svelte/Vite/DOM-only deps; runs in the cockpit, a Web
// Worker, or a plain Node test runner. Mutates nothing, allocates fresh output.
//
// SHORT-DLC handling is inherited from the composed analyzers: a byte/bit is only
// judged on the frames long enough to carry it; a missing byte is never a value-0
// sample.

import { byteHistogram, type HistogramFrame } from "./byte-histogram.ts";
import { bitActivity, type IdBitActivity } from "./bit-activity.ts";
import { tagFrames, excludedBytes } from "./tagger.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the profile, in arrival order on the backend µs clock.
 * `data` is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. This is
 * the SAME shape the byte-histogram and bit-activity analyzers accept, so the
 * cockpit seam maps the ring ONCE and passes the one array to all of them.
 */
export interface ProfileFrame {
  id: number;
  tUs: number;
  /**
   * The payload bytes. Accepts the ring's `Uint8Array` (zero-copy — already
   * byte-clamped) or a plain `number[]` (a decoder/test, defensively clamped).
   */
  data: ArrayLike<number>;
}

/** Tunable thresholds; forwarded to the composed analyzers. */
export interface IdProfileConfig {
  /** Max byte slots to profile (classic CAN = 8). A byte ≥ maxBytes is ignored. */
  maxBytes: number;
  /**
   * Min frames of an id before its profile is trusted. Below this nothing is
   * measurable (a single frame makes every byte look "constant"). Mirrors the
   * composed analyzers' floor so an id either appears in all of them or none.
   */
  minFrames: number;
}

export const ID_PROFILE_DEFAULTS: IdProfileConfig = {
  maxBytes: 8, // classic CAN payload width (→ 64 bits)
  minFrames: 2,
};

/**
 * The profile of ONE byte index of an id over the whole history.
 *
 *   • `samples`           — frames where this byte was present.
 *   • `distinct`          — distinct values it took (cardinality). FEW ⇒ enum/ID
 *                           candidate; MANY ⇒ analog.
 *   • `constant`          — true when it never varied (distinct ≤ 1): no
 *                           information — the "ignore me" / OBD2-padding case.
 *   • `min`/`max`         — value range seen (−1/−1 when no samples).
 *   • `counterOrChecksum` — the tagger flagged this byte (or a nibble of it) as a
 *                           counter or checksum: it has structure but is NEVER a
 *                           discriminator, so detectors must skip it.
 *   • `candidate`         — !constant && !counterOrChecksum: eligible to be (part
 *                           of) a discriminator or a signal. Cardinality policy
 *                           (how small an "enum" must be) is left to the detector
 *                           on top — this layer only reports the raw eligibility.
 */
export interface ByteProfile {
  byteIndex: number;
  samples: number;
  distinct: number;
  constant: boolean;
  min: number;
  max: number;
  counterOrChecksum: boolean;
  candidate: boolean;
}

/**
 * The profile of ONE bit of an id. Global `bitIndex` = byteIndex*8 + bitInByte,
 * bitInByte 0 = the byte's LSB (matches the bit-activity numbering).
 *
 *   • `activity` — toggle frequency in [0,1]: 0 = never flips, ~1 = flips every
 *                  frame.
 *   • `constant` — true when the bit never changed (and had ≥1 pair to judge).
 *                  The sub-byte analogue of a constant byte — lets a detector
 *                  find a discriminator that lives in only SOME bits of a byte
 *                  (the dominant real case).
 */
export interface BitProfile {
  bitIndex: number;
  byteIndex: number;
  activity: number;
  constant: boolean;
}

/** The whole cumulative profile for ONE id. */
export interface IdProfile {
  id: number;
  /** Frames of this id seen over the history. */
  frames: number;
  /** Widest payload (in bytes) seen for this id. */
  maxByte: number;
  /** One {@link ByteProfile} per byte index 0..min(maxByte,maxBytes)-1. */
  bytes: ByteProfile[];
  /** One {@link BitProfile} per bit of the carried bytes (length = bytes.length*8). */
  bits: BitProfile[];
  /** Byte indices that are constant (the CONSTANT-EXCLUSION; incl. padding/zeros). */
  constantBytes: number[];
  /** Byte indices eligible as discriminator/signal (non-constant, non-counter/checksum). */
  candidateBytes: number[];
}

/** The whole-scan result: one profile per id, plus run-wide totals. */
export interface IdProfileResult {
  /** Per-id profiles, richest-first (most candidate bytes, then most frames). */
  ids: IdProfile[];
  /** Total frames actually profiled (after the optional allow-list / minFrames). */
  framesAnalyzed: number;
  /** Number of distinct ids in {@link ids}. */
  idCount: number;
  /** The maxBytes the scan ran with (so the UI can size its grid). */
  maxBytes: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the cumulative per-id profile over a history of frames.
 *
 * Composes byte-histogram + bit-activity + tagger over the SAME frames, then
 * folds them per id into byte/bit profiles and the constant-exclusion /
 * candidate masks. Ids with fewer than `minFrames` frames are dropped (nothing
 * measurable). Profiles are sorted richest-first (most candidate bytes), so the
 * id most worth decoding surfaces at the top.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames   the history to profile — pass the FULL ring for a since-connect
 *                 profile (the caller slices; this layer treats them as given).
 * @param allowIds optional id allow-list; empty/undefined = all ids.
 * @param config   optional threshold overrides.
 */
export function idProfile(
  frames: ReadonlyArray<ProfileFrame>,
  allowIds?: ReadonlyArray<number>,
  config: Partial<IdProfileConfig> = {},
): IdProfileResult {
  const cfg: IdProfileConfig = { ...ID_PROFILE_DEFAULTS, ...config };
  const maxBits = cfg.maxBytes * 8;

  // The three composed analyzers accept this exact frame shape, so we forward
  // the array as-is. byteHistogram/bitActivity read {id,tUs,data}; the tagger
  // reads {id,data} (a structural subset).
  const hist = byteHistogram(frames as ReadonlyArray<HistogramFrame>, allowIds, {
    maxBytes: cfg.maxBytes,
    minFrames: cfg.minFrames,
  });
  const bits = bitActivity(frames, allowIds, {
    maxBits,
    minFrames: cfg.minFrames,
  });
  // ProfileFrame {id,tUs,data} is a structural superset of the tagger's RawFrame
  // {id,data}, so pass the frames straight through — no per-frame re-wrap.
  const excluded = excludedBytes(tagFrames(frames));

  // Index the bit profiles by id so the (id-sorted-differently) histogram drives
  // the iteration and bit lookups are O(1).
  const bitsById = new Map<number, IdBitActivity>();
  for (const b of bits.ids) bitsById.set(b.id, b);

  const ids: IdProfile[] = [];
  let framesAnalyzed = 0;
  for (const h of hist.ids) {
    const bit = bitsById.get(h.id);
    const byteProfiles: ByteProfile[] = h.bytes.map((b) => {
      const constant = b.distinct <= 1;
      const counterOrChecksum = excluded.has(`${h.id}:${b.byteIndex}`);
      return {
        byteIndex: b.byteIndex,
        samples: b.samples,
        distinct: b.distinct,
        constant,
        min: b.min,
        max: b.max,
        counterOrChecksum,
        candidate: !constant && !counterOrChecksum,
      };
    });

    // One bit profile per bit of the carried bytes. bit-activity arrays are
    // length maxBits; we read only the bits this id actually carries.
    const bitProfiles: BitProfile[] = [];
    for (let bi = 0; bi < byteProfiles.length * 8; bi++) {
      bitProfiles.push({
        bitIndex: bi,
        byteIndex: bi >> 3,
        activity: bit ? bit.activity[bi] : 0,
        constant: bit ? bit.constant[bi] : false,
      });
    }

    ids.push({
      id: h.id,
      frames: h.frames,
      maxByte: h.maxByte,
      bytes: byteProfiles,
      bits: bitProfiles,
      constantBytes: byteProfiles.filter((b) => b.constant).map((b) => b.byteIndex),
      candidateBytes: byteProfiles.filter((b) => b.candidate).map((b) => b.byteIndex),
    });
    framesAnalyzed += h.frames;
  }

  // Richest id first: most candidate bytes (most to decode), then most frames
  // (more evidence wins ties), then id (stable, deterministic).
  ids.sort((a, b) => {
    if (b.candidateBytes.length !== a.candidateBytes.length) {
      return b.candidateBytes.length - a.candidateBytes.length;
    }
    if (b.frames !== a.frames) return b.frames - a.frames;
    return a.id - b.id;
  });

  return { ids, framesAnalyzed, idCount: ids.length, maxBytes: cfg.maxBytes };
}
