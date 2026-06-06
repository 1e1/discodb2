// discodb2 — PASSIVE analyzer: the CO-OCCURRENCE OF CHANGES matrix (frontend/shared/analysis).
//
// SOURCE OF TRUTH: docs/WIZARD.md → passive scan analyzers (the Hunt "Scan"
// sub-view). Like the BIT-ACTIVITY HEATMAP and the BYTE HISTOGRAM, this analyzer
// takes NO operator action: it scans the capture buffer for one id and surfaces
// structure automatically. Where the heatmap answers "which BYTES move?" and the
// histogram answers "HOW is each byte's VALUE distributed?", this one answers
// "which BYTES change TOGETHER?" — the cross-byte coupling the other two cannot
// see, because they each look at one byte (or bit) in isolation.
//
// Why it matters:
//   • Two ADJACENT bytes that almost always change together are very likely the
//     two halves of one MULTI-BYTE value (a 16-bit speed/rpm split LE or BE). A
//     run of adjacent high-co-change bytes ⇒ a likely multi-byte signal group.
//   • A byte that co-changes with MANY others (high out-degree) is a likely
//     MULTIPLEXOR (its value selects which of the other bytes is live) or a
//     CHECKSUM (it changes whenever any payload byte changes). The tagger already
//     flags checksums/counters — the cockpit seam wires `excludedBytes` so the UI
//     can annotate those, and so a checksum's "couples with everything" pattern
//     is explained rather than mistaken for signal.
//
// METHOD. For one id, walk the ordered frames. For each consecutive frame PAIR,
// note which bytes CHANGED (value differs from the previous frame). Then for each
// byte-pair (i, j):
//   • coChange[i][j] = number of pairs where BOTH i and j changed,
//   • the per-byte "changed" count gives the marginals.
// From those we derive, per ordered pair (i → j), the CONDITIONAL probability
// P(j changes | i changed) = coChange[i][j] / changed[i], and the symmetric
// JACCARD index |i∧j| / |i∨j| = coChange[i][j] / (changed[i] + changed[j] −
// coChange[i][j]). Conditional probability is directional (it exposes a
// multiplexor/checksum that drives many bytes — high P(j|i) for many j); Jaccard
// is symmetric and is what the "likely groups" read-out runs on (two bytes that
// move as one have Jaccard ≈ 1).
//
// SHORT-DLC handling matches the rest of the stack: a PAIR only counts toward
// (i, j) when BOTH frames of the pair carry BOTH bytes i and j. A byte missing
// from one side of a pair is not a "0 → 0, unchanged" sample; that pair simply
// does not contribute to any byte-pair involving the missing byte. The per-byte
// and per-pair denominators are tracked separately so each ratio divides by the
// number of pairs that actually COULD have observed that (byte or pair).
//
// Pure & framework-free (like tagger.ts / bit-activity.ts / byte-histogram.ts):
// no Svelte/Vite/DOM-only deps; runs in the cockpit, a Web Worker, or a plain
// Node test runner. Mutates nothing, allocates fresh output.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One raw frame for the scan, in arrival order, on the backend µs clock. `data`
 * is 0..8 bytes (the frame's DLC); each entry is a byte 0..255. Identical shape
 * to the bit-activity ScanFrame / histogram HistogramFrame (a structural superset
 * of the tagger's RawFrame), so the cockpit seam can pass one mapped array to all
 * analyzers. The analyzer itself does not read `tUs` — the caller has already
 * sliced the window — but accepting it keeps the seam a trivial pass-through.
 */
export interface CoOccurrenceFrame {
  id: number;
  tUs: number;
  data: number[];
}

/** Tunable thresholds. Kept local & overridable; sane defaults below. */
export interface CoOccurrenceConfig {
  /**
   * Max byte slots to analyze. Classic CAN is ≤8 bytes, so 8 is the natural cap;
   * kept configurable for CAN-FD experiments later. A byte index ≥ maxBytes is
   * never considered even if some frame carries it.
   */
  maxBytes: number;
  /**
   * An id needs at least this many frames before its co-change matrix is trusted.
   * With fewer than 2 frames there are zero pairs, so nothing can be measured; a
   * small floor also stops a single stray frame from creating a degenerate
   * matrix. (Same intent as the heatmap's minFrames.)
   */
  minFrames: number;
  /**
   * The Jaccard threshold above which two ADJACENT bytes are linked into the same
   * "likely group" (a run of adjacent bytes that move as one ⇒ a multi-byte
   * value). 0.6 keeps a single noisy disagreement (e.g. a low byte that wraps
   * without carrying) from breaking an otherwise-tight 16-bit pair, while still
   * rejecting bytes that merely happen to change at similar rates.
   */
  groupJaccard: number;
  /**
   * A byte is flagged a likely CHECKSUM/MULTIPLEXOR hub when MANY other bytes i
   * "drive" it — i.e. P(this changes | byte i changed) ≥ this — for at least
   * `hubMinDegree` distinct i. A CHECKSUM changes whenever ANY payload byte
   * changes, so P(checksum | i) ≈ 1 for every varying i: it has high IN-degree.
   * (A multiplexor that selects which byte is live couples similarly.) A plain
   * signal is driven by at most its own multi-byte partner, so its in-degree is
   * low. We measure in-degree (who drives ME) rather than out-degree because the
   * checksum case — the one the tagger also flags — is exactly an in-hub.
   */
  hubConditional: number;
  /** Min in-degree (number of bytes that strongly drive this one) to flag a hub. */
  hubMinDegree: number;
}

export const CO_OCCURRENCE_DEFAULTS: CoOccurrenceConfig = {
  maxBytes: 8, // classic CAN payload width
  minFrames: 2, // need ≥1 pair before co-change means anything
  groupJaccard: 0.6, // adjacent bytes this correlated ⇒ same multi-byte value
  hubConditional: 0.8, // P(this|i) ≥ 0.8 counts byte i as "driving" this one
  hubMinDegree: 3, // driven by ≥3 other bytes ⇒ likely checksum/mux
};

/**
 * A contiguous run of adjacent bytes that change together (Jaccard ≥ threshold
 * on every adjacent step), i.e. a LIKELY MULTI-BYTE SIGNAL. `startByte`..`endByte`
 * inclusive; `length` = endByte − startByte + 1 (always ≥ 2 — a lone byte is not
 * a group). `minJaccard` is the weakest adjacent link in the run (how tight the
 * grouping is); `excluded` is true when ANY byte in the run was flagged by the
 * tagger (a "group" that is really a checksum/counter — surfaced so the UI can
 * down-weight it).
 */
export interface CoChangeGroup {
  startByte: number;
  endByte: number;
  length: number;
  minJaccard: number;
  excluded: boolean;
}

/**
 * A byte that co-changes with MANY others — a likely CHECKSUM or MULTIPLEXOR.
 *   • `byteIndex`  — the hub byte.
 *   • `degree`     — how many OTHER bytes strongly DRIVE it: i with P(this|i) ≥
 *                    config.hubConditional (the in-degree).
 *   • `drivenBy`   — those driver byte indices (ascending), for the read-out.
 *   • `excluded`   — true when the tagger flagged this byte (then it is almost
 *                    certainly the checksum, not a multiplexor — the UI can say so).
 */
export interface CoChangeHub {
  byteIndex: number;
  degree: number;
  drivenBy: number[];
  excluded: boolean;
}

/**
 * The whole co-change profile for ONE id over the window.
 *
 *   • `id` / `frames`     — the id and how many of its frames were in the window.
 *   • `maxByte`           — widest payload (in bytes) seen, so the UI sizes the
 *                           matrix to exactly the bytes this id carries.
 *   • `byteCount`         — min(maxByte, maxBytes): the matrix dimension.
 *   • `changed[i]`        — pairs in which byte i changed (the marginal count).
 *   • `present[i]`        — pairs in which byte i was carried by BOTH frames (the
 *                           denominator for byte i's marginal change rate).
 *   • `coChange[i][j]`    — pairs in which BOTH i and j changed (i∧j). Symmetric.
 *   • `coPresent[i][j]`   — pairs in which BOTH i and j were carried by BOTH
 *                           frames (the denominator for the (i,j) ratios; smaller
 *                           than `pairs` only under short DLC). Symmetric.
 *   • `jaccard[i][j]`     — coChange / (changed[i]+changed[j]−coChange), in [0,1],
 *                           0 when neither ever changed. Symmetric; the heatmap
 *                           value and the grouping basis.
 *   • `conditional[i][j]` — P(j changes | i changed) = coChange / changed[i], in
 *                           [0,1], 0 when i never changed. DIRECTIONAL (row i =
 *                           "given i changed, who else moved?").
 *   • `excludedBytes`     — byte indices the tagger flagged (counter/checksum),
 *                           threaded from the seam so the read-out can annotate.
 *   • `groups`            — runs of adjacent high-Jaccard bytes (likely values).
 *   • `hubs`              — bytes that drive many others (likely mux/checksum).
 */
export interface IdCoOccurrence {
  id: number;
  frames: number;
  maxByte: number;
  byteCount: number;
  pairs: number; // consecutive frame pairs of this id (frames - 1)
  changed: number[];
  present: number[];
  coChange: number[][];
  coPresent: number[][];
  jaccard: number[][];
  conditional: number[][];
  excludedBytes: number[];
  groups: CoChangeGroup[];
  hubs: CoChangeHub[];
}

/** The whole-scan result: one profile per id, plus run-wide totals. */
export interface CoOccurrenceResult {
  /** Per-id profiles, sorted by descending coupling (most-structured id first). */
  ids: IdCoOccurrence[];
  /** Total frames actually analyzed (after the optional allow-list / minFrames). */
  framesAnalyzed: number;
  /** Number of distinct ids in {@link ids}. */
  idCount: number;
  /** The maxBytes the scan ran with (so the UI can size its grid). */
  maxBytes: number;
}

import { payloadLen, groupByIdPacked, type PackedFrames } from "./packed.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Injectable accelerator seam (DESIGN §6.1.4 step 4 / §6.1.5)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The hot O(pairs · bytes²) tally of one id's consecutive-pair byte changes, in
 * FLAT row-major form (the shape a WASM kernel fills over linear memory):
 *   • `changed[i]`         — pairs in which byte i changed.
 *   • `present[i]`         — pairs in which byte i was carried by both frames.
 *   • `coChange[i*bc + j]` — pairs in which BOTH i and j changed (symmetric).
 *   • `coPresent[i*bc + j]`— pairs in which BOTH i and j were carried (symmetric).
 * where `bc = byteCount` is the row stride. This is the ONLY part of the packed
 * co-occurrence scan that scales with input size and the WASM target chosen by
 * the Phase 0 bench; the derived read-outs (jaccard/conditional/groups/hubs) run
 * unchanged on top of it.
 */
export interface CoOccurrenceTally {
  changed: Int32Array;
  present: Int32Array;
  coChange: Int32Array;
  coPresent: Int32Array;
}

/**
 * A drop-in tally kernel: packed `data`/`dlc` columns + this id's `indices` (in
 * arrival order) + the matrix `byteCount` → the {@link CoOccurrenceTally}. The
 * pure-JS {@link jsCoocTally} is the default AND the runtime fallback; the cockpit
 * worker may inject a WASM-backed kernel with the SAME signature (it stays pure
 * integer, so WASM is bit-identical). `shared/analysis` imports nothing WASM.
 */
export type CoOccurrenceTallyKernel = (
  data: Uint8Array,
  dlc: Uint8Array,
  indices: Int32Array,
  byteCount: number,
) => CoOccurrenceTally;

let injectedTallyKernel: CoOccurrenceTallyKernel | null = null;

/**
 * Inject (or clear, with `null`) the co-occurrence tally accelerator. Called once
 * by the cockpit analysis worker after it loads the WASM kernel; everywhere else
 * the pure-JS default runs (Node tests, browser floor without WASM/SIMD). Pure
 * integer ⇒ the injected kernel must produce bit-identical counts (pinned by
 * `cooc.wasm.equiv.test.ts`).
 */
export function setCoOccurrenceTallyKernel(kernel: CoOccurrenceTallyKernel | null): void {
  injectedTallyKernel = kernel;
}

/**
 * The reference JS tally — fills the flat {@link CoOccurrenceTally} for one id's
 * frames over a packed buffer. Reads `data`/`dlc` directly (no per-frame objects),
 * mirroring the WASM kernel byte-for-byte so the two are interchangeable. Short-DLC
 * handling: a pair contributes to byte i / pair (i,j) only within
 * `common = min(dlc[prev], dlc[cur], byteCount)`.
 */
export function jsCoocTally(
  data: Uint8Array,
  dlc: Uint8Array,
  indices: ArrayLike<number>,
  byteCount: number,
): CoOccurrenceTally {
  const changed = new Int32Array(byteCount);
  const present = new Int32Array(byteCount);
  const coChange = new Int32Array(byteCount * byteCount);
  const coPresent = new Int32Array(byteCount * byteCount);
  const n = indices.length;
  for (let k = 1; k < n; k++) {
    const prev = indices[k - 1];
    const cur = indices[k];
    const lp = dlc[prev];
    const lc = dlc[cur];
    const common = Math.min(lp, lc, byteCount);
    const pbase = prev * 8;
    const cbase = cur * 8;
    // Change bitmask over the comparable bytes (matches the kernel's change_mask).
    let mask = 0;
    for (let i = 0; i < common; i++) {
      present[i]++;
      if (data[pbase + i] !== data[cbase + i]) {
        mask |= 1 << i;
        changed[i]++;
      }
    }
    for (let i = 0; i < common; i++) {
      const ci = (mask >> i) & 1;
      const row = i * byteCount;
      for (let j = i + 1; j < common; j++) {
        coPresent[row + j]++;
        coPresent[j * byteCount + i]++;
        if (ci && (mask >> j) & 1) {
          coChange[row + j]++;
          coChange[j * byteCount + i]++;
        }
      }
    }
  }
  return { changed, present, coChange, coPresent };
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the co-change matrices over a window of frames.
 *
 * Groups `frames` by id internally (arrival order is preserved within each id —
 * that order is what consecutive-pair change detection needs). Ids with fewer
 * than `minFrames` frames are dropped (nothing measurable). The remaining
 * profiles are sorted so the id with the strongest coupling (the highest single
 * off-diagonal Jaccard) comes first — the id most likely to carry a multi-byte
 * signal, which is what the operator is hunting for.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames        the windowed scan frames (the caller slices the ring window).
 * @param allowIds      optional id allow-list; empty/undefined = all ids.
 * @param excludedByIds optional map id → byte indices the tagger flagged (the
 *                      cockpit seam fills this from `excludedBytes`); used only to
 *                      ANNOTATE groups/hubs, never to change the math.
 * @param config        optional threshold overrides.
 */
export function coOccurrence(
  frames: ReadonlyArray<CoOccurrenceFrame>,
  allowIds?: ReadonlyArray<number>,
  excludedByIds?: ReadonlyMap<number, ReadonlyArray<number>>,
  config: Partial<CoOccurrenceConfig> = {},
): CoOccurrenceResult {
  const cfg: CoOccurrenceConfig = { ...CO_OCCURRENCE_DEFAULTS, ...config };
  const allow = allowIds && allowIds.length > 0 ? new Set(allowIds) : null;

  // Group payloads by id, preserving arrival order (the pair basis).
  const byId = new Map<number, number[][]>();
  for (const f of frames) {
    if (allow && !allow.has(f.id)) continue;
    let group = byId.get(f.id);
    if (group === undefined) {
      group = [];
      byId.set(f.id, group);
    }
    // Defensive copy clamped to bytes so the value reads below are safe.
    group.push(f.data.map((b) => b & 0xff));
  }

  const ids: IdCoOccurrence[] = [];
  let framesAnalyzed = 0;
  for (const [id, group] of byId) {
    if (group.length < cfg.minFrames) continue;
    const excluded = excludedByIds?.get(id) ?? [];
    const profile = profileOneId(id, group, excluded, cfg);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  // Most-structured id first (see compareCoupled).
  ids.sort(compareCoupled);

  return {
    ids,
    framesAnalyzed,
    idCount: ids.length,
    maxBytes: cfg.maxBytes,
  };
}

/**
 * Packed-window variant of {@link coOccurrence} (DESIGN §6.1.4 step 3b). Same
 * output, but reads a columnar {@link PackedFrames} via index lists + byteAt — no
 * per-frame payload objects. Used by the synchronous worker Hunt scans; the
 * frame-based {@link coOccurrence} stays for the pure Node tests / arbitrary-width
 * callers. An equivalence test pins packed ≡ frame, bit-identical.
 */
export function coOccurrencePacked(
  p: PackedFrames,
  allowIds?: ReadonlyArray<number>,
  excludedByIds?: ReadonlyMap<number, ReadonlyArray<number>>,
  config: Partial<CoOccurrenceConfig> = {},
): CoOccurrenceResult {
  const cfg: CoOccurrenceConfig = { ...CO_OCCURRENCE_DEFAULTS, ...config };
  const byId = groupByIdPacked(p, allowIds);

  const ids: IdCoOccurrence[] = [];
  let framesAnalyzed = 0;
  for (const [id, indices] of byId) {
    if (indices.length < cfg.minFrames) continue;
    const excluded = excludedByIds?.get(id) ?? [];
    const profile = profileOneIdPacked(id, p, indices, excluded, cfg);
    ids.push(profile);
    framesAnalyzed += profile.frames;
  }

  ids.sort(compareCoupled);
  return { ids, framesAnalyzed, idCount: ids.length, maxBytes: cfg.maxBytes };
}

/**
 * Most-structured id first: sort by the id's PEAK off-diagonal Jaccard (the
 * tightest byte-pair coupling), then by frame count (more evidence wins ties),
 * then by id (stable, deterministic). Shared by both entry points.
 */
function compareCoupled(a: IdCoOccurrence, b: IdCoOccurrence): number {
  const pa = peakOffDiagonal(a.jaccard);
  const pb = peakOffDiagonal(b.jaccard);
  if (pb !== pa) return pb - pa;
  if (b.frames !== a.frames) return b.frames - a.frames;
  return a.id - b.id;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-id profiling
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the co-change matrices + derived read-outs for one id's ordered payloads.
 *
 * SHORT-DLC handling: a consecutive PAIR contributes to byte i only when both
 * frames of the pair carry byte i (it could have CHANGED), and to byte-pair (i,j)
 * only when both frames carry BOTH i and j. We track per-byte `present` and
 * per-pair `coPresent` denominators so every ratio divides by the number of pairs
 * that could actually have observed that quantity — never by a phantom count.
 */
function profileOneId(
  id: number,
  payloads: number[][],
  excludedBytesList: ReadonlyArray<number>,
  cfg: CoOccurrenceConfig,
): IdCoOccurrence {
  let maxByte = 0;
  for (const p of payloads) if (p.length > maxByte) maxByte = p.length;
  const byteCount = Math.min(maxByte, cfg.maxBytes);

  const changed = new Array<number>(byteCount).fill(0);
  const present = new Array<number>(byteCount).fill(0);
  const coChange = makeMatrix(byteCount);
  const coPresent = makeMatrix(byteCount);

  // Walk consecutive pairs. For each pair, compute the set of bytes that are
  // PRESENT (carried by both frames) and, among those, which CHANGED.
  for (let n = 1; n < payloads.length; n++) {
    const prev = payloads[n - 1];
    const cur = payloads[n];
    // A byte is comparable in this pair only if both frames carry it.
    const common = Math.min(prev.length, cur.length, byteCount);

    // First pass: per-byte present + changed marginals for this pair.
    const didChange: boolean[] = new Array(common);
    for (let i = 0; i < common; i++) {
      present[i]++;
      const c = prev[i] !== cur[i];
      didChange[i] = c;
      if (c) changed[i]++;
    }

    // Second pass: pairwise co-presence + co-change (upper triangle, mirrored).
    for (let i = 0; i < common; i++) {
      for (let j = i + 1; j < common; j++) {
        coPresent[i][j]++;
        coPresent[j][i]++;
        if (didChange[i] && didChange[j]) {
          coChange[i][j]++;
          coChange[j][i]++;
        }
      }
    }
  }

  // Derive the symmetric Jaccard and directional conditional matrices.
  const jaccard = makeMatrix(byteCount);
  const conditional = makeMatrix(byteCount);
  for (let i = 0; i < byteCount; i++) {
    for (let j = 0; j < byteCount; j++) {
      if (i === j) continue; // diagonal stays 0 (self-coupling is meaningless here)
      const both = coChange[i][j];
      // Jaccard = |i∧j| / |i∨j| = both / (changed[i] + changed[j] − both). The
      // union can only be 0 when neither byte ever changed → coupling 0.
      const union = changed[i] + changed[j] - both;
      jaccard[i][j] = union > 0 ? both / union : 0;
      // Conditional P(j changes | i changed) = both / changed[i].
      conditional[i][j] = changed[i] > 0 ? both / changed[i] : 0;
    }
  }

  const excludedBytes = excludedBytesList.filter((b) => b >= 0 && b < byteCount).slice().sort((a, b) => a - b);
  const excludedSet = new Set(excludedBytes);

  const groups = findGroups(jaccard, byteCount, cfg.groupJaccard, excludedSet);
  const hubs = findHubs(conditional, byteCount, cfg, excludedSet);

  return {
    id,
    frames: payloads.length,
    maxByte,
    byteCount,
    pairs: Math.max(0, payloads.length - 1),
    changed,
    present,
    coChange,
    coPresent,
    jaccard,
    conditional,
    excludedBytes,
    groups,
    hubs,
  };
}

/**
 * Packed twin of {@link profileOneId}: identical co-change/co-presence tally and
 * derived matrices, but reads each consecutive pair's bytes via byteAt over an
 * index list instead of payload arrays. Short-DLC handling is preserved via
 * payloadLen (a pair contributes to byte i / pair (i,j) only when both frames
 * carry the byte(s)). findGroups/findHubs/derive are reused unchanged.
 */
function profileOneIdPacked(
  id: number,
  p: PackedFrames,
  indices: number[],
  excludedBytesList: ReadonlyArray<number>,
  cfg: CoOccurrenceConfig,
): IdCoOccurrence {
  let maxByte = 0;
  for (const i of indices) {
    const len = payloadLen(p, i);
    if (len > maxByte) maxByte = len;
  }
  const byteCount = Math.min(maxByte, cfg.maxBytes);

  // The hot tally goes through the injectable kernel (WASM in the cockpit worker)
  // or the pure-JS reference. Output is bit-identical either way (pure integer).
  const tally = injectedTallyKernel
    ? injectedTallyKernel(p.data, p.dlc, Int32Array.from(indices), byteCount)
    : jsCoocTally(p.data, p.dlc, indices, byteCount);

  // Expand the flat tally into the per-byte arrays / matrices the result exposes.
  const changed: number[] = new Array(byteCount);
  const present: number[] = new Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    changed[i] = tally.changed[i];
    present[i] = tally.present[i];
  }
  const coChange = makeMatrix(byteCount);
  const coPresent = makeMatrix(byteCount);
  for (let i = 0; i < byteCount; i++) {
    const row = i * byteCount;
    for (let j = 0; j < byteCount; j++) {
      coChange[i][j] = tally.coChange[row + j];
      coPresent[i][j] = tally.coPresent[row + j];
    }
  }

  const jaccard = makeMatrix(byteCount);
  const conditional = makeMatrix(byteCount);
  for (let i = 0; i < byteCount; i++) {
    for (let j = 0; j < byteCount; j++) {
      if (i === j) continue;
      const both = coChange[i][j];
      const union = changed[i] + changed[j] - both;
      jaccard[i][j] = union > 0 ? both / union : 0;
      conditional[i][j] = changed[i] > 0 ? both / changed[i] : 0;
    }
  }

  const excludedBytes = excludedBytesList.filter((b) => b >= 0 && b < byteCount).slice().sort((a, b) => a - b);
  const excludedSet = new Set(excludedBytes);

  const groups = findGroups(jaccard, byteCount, cfg.groupJaccard, excludedSet);
  const hubs = findHubs(conditional, byteCount, cfg, excludedSet);

  return {
    id,
    frames: indices.length,
    maxByte,
    byteCount,
    pairs: Math.max(0, indices.length - 1),
    changed,
    present,
    coChange,
    coPresent,
    jaccard,
    conditional,
    excludedBytes,
    groups,
    hubs,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Read-outs: "likely groups" + hubs
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Find runs of ADJACENT bytes whose pairwise Jaccard meets the threshold on every
 * adjacent step — a chain b, b+1, b+2, … where each neighbour pair moves as one.
 * Such a run is a likely MULTI-BYTE VALUE (a 16-/24-/32-bit field split across
 * consecutive bytes). A lone byte is never a group (length ≥ 2 required).
 *
 * The `minJaccard` reported for a run is its WEAKEST adjacent link, so the UI can
 * rank tighter groups higher. A run is `excluded` when any byte in it was tagged
 * (then the "group" is really a counter/checksum span — surfaced, not hidden).
 */
function findGroups(
  jaccard: number[][],
  byteCount: number,
  threshold: number,
  excludedSet: ReadonlySet<number>,
): CoChangeGroup[] {
  const groups: CoChangeGroup[] = [];
  let start = 0;
  while (start < byteCount - 1) {
    // Extend the run while each adjacent neighbour pair is tightly coupled.
    let end = start;
    let minLink = Infinity;
    while (end < byteCount - 1 && jaccard[end][end + 1] >= threshold) {
      minLink = Math.min(minLink, jaccard[end][end + 1]);
      end++;
    }
    if (end > start) {
      // [start..end] is a run of ≥2 adjacent coupled bytes.
      let excluded = false;
      for (let b = start; b <= end; b++) if (excludedSet.has(b)) excluded = true;
      groups.push({
        startByte: start,
        endByte: end,
        length: end - start + 1,
        minJaccard: minLink,
        excluded,
      });
      start = end + 1; // a byte belongs to at most one run
    } else {
      start++;
    }
  }
  return groups;
}

/**
 * Find HUB bytes: a byte K that MANY other bytes strongly drive, i.e. for many i
 * the conditional P(K changes | i changed) ≥ config.hubConditional. A CHECKSUM
 * changes whenever any payload byte changes, so P(K|i) ≈ 1 for every varying i —
 * a high IN-degree. A MULTIPLEXOR that gates which byte is live couples similarly.
 * A plain signal is driven only by its own multi-byte partner, so its in-degree
 * stays below `hubMinDegree` and a 16-bit pair (in-degree 1) is never mistaken
 * for a hub. We read conditional[i][K] down COLUMN K (who drives K). `excluded`
 * marks a hub the tagger already flagged — almost certainly the checksum, so the
 * UI can name it as such.
 */
function findHubs(
  conditional: number[][],
  byteCount: number,
  cfg: CoOccurrenceConfig,
  excludedSet: ReadonlySet<number>,
): CoChangeHub[] {
  const hubs: CoChangeHub[] = [];
  for (let k = 0; k < byteCount; k++) {
    const drivenBy: number[] = [];
    for (let i = 0; i < byteCount; i++) {
      if (i === k) continue;
      if (conditional[i][k] >= cfg.hubConditional) drivenBy.push(i);
    }
    if (drivenBy.length >= cfg.hubMinDegree) {
      hubs.push({ byteIndex: k, degree: drivenBy.length, drivenBy, excluded: excludedSet.has(k) });
    }
  }
  // Strongest hub (highest degree) first; ties by byte index for determinism.
  hubs.sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.byteIndex - b.byteIndex));
  return hubs;
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** A fresh n×n matrix of zeros. */
function makeMatrix(n: number): number[][] {
  const m: number[][] = new Array(n);
  for (let i = 0; i < n; i++) m[i] = new Array<number>(n).fill(0);
  return m;
}

/** The largest off-diagonal value in a square matrix (0 if none / empty). */
function peakOffDiagonal(m: number[][]): number {
  let peak = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m.length; j++) {
      if (i === j) continue;
      if (m[i][j] > peak) peak = m[i][j];
    }
  }
  return peak;
}
