// discodb2 — PASSIVE analyzer: DISCRIMINATOR ↔ PAYLOAD DEPENDENCE (frontend/shared/analysis).
//
// SOURCE OF TRUTH: the decoding-strategy step back (project memory "CAN
// multiplexor & decoding reality"). The AUTO message-ID detector finds a
// low-cardinality candidate field; this analyzer answers the question that
// SEPARATES a real discriminator from a false positive:
//
//   does conditioning on the candidate field actually PREDICT the rest of the
//   payload?  — the DEFINING property of a multiplexor (it selects which signals
//   the other bytes carry). A plain status/enum byte (e.g. gear 1..6) is also
//   low-cardinality, but the other bytes vary INDEPENDENTLY of it, so it must be
//   rejected.
//
// MEASURE: normalized mutual information (NMI) between the field's value and each
// other payload byte. The naive plug-in MI is BIASED UPWARD when samples are few
// relative to the value space (a high-cardinality byte over a short window makes
// every (field,byte) pair look unique → spurious "perfect" dependence). We
// control that with a PERMUTATION NULL BASELINE: recompute NMI on randomly
// PERMUTED field labels (fixed-seed shuffles, which preserve both marginals and
// the sparsity but DESTROY the pairing). A byte truly depends on the field only
// when its real NMI exceeds the null NMI by a margin — the sparsity inflation
// cancels because it hits the real and permuted estimates equally. We shuffle
// rather than cyclically shift so the null breaks the pairing even for STRICTLY
// PERIODIC data (a round-robin multiplexor), which a shift would leave aligned.
// Seeds are fixed, so the analyzer stays pure and reproducible (no RNG).
//
// VERDICT (`rejects`): true only when the test is CONCLUSIVE (enough paired
// samples, ≥1 judgeable target byte) AND NOTHING in the payload depends on the
// field — i.e. solid evidence the candidate is not a discriminator. Otherwise
// false (keep the candidate). So this gate can only IMPROVE precision; when data
// is thin or ambiguous it defers to the caller's cardinality decision and never
// rejects a candidate for lack of evidence.
//
// LIMITATION (honest): a real multiplexor whose sub-signals are themselves
// HIGH-cardinality (e.g. VIN chars) over a SHORT window can look sparse → the
// margin isn't cleared → the field may be conservatively rejected. With more
// history it recovers; and the operator can always FORCE such a field manually.
//
// Pure & framework-free: no Svelte/Vite/DOM deps; runs in the cockpit, a Web
// Worker, or a Node test runner. Mutates nothing, allocates fresh output.

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/** One frame for the test: id + 0..8 raw payload bytes. */
export interface DependenceFrame {
  id: number;
  /** Payload bytes — the ring's `Uint8Array` (zero-copy) or a plain `number[]`. */
  data: ArrayLike<number>;
}

/** The candidate discriminator field — a sub-range of ONE byte (LSB-indexed). */
export interface CandidateField {
  /** Byte index the field lives in. */
  byteIndex: number;
  /** Lowest bit of the field within the byte (0 = LSB). */
  bitLo: number;
  /** Field width in bits. */
  bitLen: number;
}

export interface DependenceConfig {
  /** Max byte slots to consider as targets (classic CAN = 8). */
  maxBytes: number;
  /** Below this many paired samples the test is INCONCLUSIVE (never rejects). */
  minFrames: number;
  /**
   * A target byte DEPENDS on the field when its real NMI exceeds the shifted-null
   * NMI by at least this margin (in normalized [0,1] units). 0.1 is a robust
   * separation in practice: independent bytes leave ~0 margin, a real partition
   * leaves a large one.
   */
  nmiMargin: number;
  /**
   * Upper bound on the paired-sample count the NMI + permutation null actually
   * walk. The test cost is ~7 Map-based O(N) passes PER target byte (1 real NMI +
   * 6 null shuffles), so on a deep ring (tens of thousands of frames) it dominates
   * a Message-ID re-detect (measured ~58% at 50k frames; see DESIGN §6.1.1). An
   * NMI + permutation null is a STATISTICAL estimate that converges quickly — a
   * few thousand paired samples separate a real partition from independence just
   * as decisively as fifty thousand, and Miller-Madow already corrects finite-N
   * bias. So when an id carries more than `sampleCap` frames we DETERMINISTICALLY
   * down-sample to `sampleCap` (fixed-seed partial Fisher-Yates over positions —
   * uniform, no aliasing with a periodic mux, reproducible) before the per-byte
   * loops, making the test O(min(N, sampleCap)). Datasets at or below the cap are
   * untouched (bit-exact). 0 disables capping (use the full history).
   */
  sampleCap: number;
}

export const DEPENDENCE_DEFAULTS: DependenceConfig = {
  maxBytes: 8,
  minFrames: 24,
  nmiMargin: 0.1,
  // ~8k paired samples: comfortably above the joint-bin count of a small mux ×
  // a 256-value byte, so the estimate is unchanged in practice, while capping the
  // dominant cost on a deep ring. Tunable; 0 = no cap.
  sampleCap: 8192,
};

export interface DependenceResult {
  /** Target bytes we could actually judge (non-constant over the paired frames). */
  targetsJudged: number;
  /** Of those, how many DEPEND on the field (real NMI beat the null by the margin). */
  dependentBytes: number;
  /** Per judged target byte: its real & null NMI and the verdict. */
  perByte: Array<{ byteIndex: number; nmi: number; nullNmi: number; dependent: boolean }>;
  /** Enough paired samples AND ≥1 judgeable target → the verdict is trustworthy. */
  conclusive: boolean;
  /**
   * CONFIDENT verdict that the candidate does NOT discriminate the payload
   * (conclusive AND zero dependent bytes). The caller should reject the candidate.
   */
  rejects: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level API
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Test whether `field` partitions the payload of its id — i.e. whether the
 * `targetBytes` depend on the field's value.
 *
 * Pure: does not mutate `frames` or `config`.
 *
 * @param frames      frames for ONE id, in arrival order (pass the full history).
 * @param field       the candidate discriminator sub-byte field.
 * @param targetBytes which OTHER byte indices to test for dependence (the caller
 *                    passes the non-constant, non-counter/checksum bytes — i.e.
 *                    the profile's candidate bytes minus the field's own byte).
 * @param config      optional threshold overrides.
 */
export function payloadDependence(
  frames: ReadonlyArray<DependenceFrame>,
  field: CandidateField,
  targetBytes: ReadonlyArray<number>,
  config: Partial<DependenceConfig> = {},
): DependenceResult {
  const cfg: DependenceConfig = { ...DEPENDENCE_DEFAULTS, ...config };
  const mask = (1 << field.bitLen) - 1;
  const fieldByte = field.byteIndex;

  const empty: DependenceResult = {
    targetsJudged: 0,
    dependentBytes: 0,
    perByte: [],
    conclusive: false,
    rejects: false,
  };

  // The field's own value per frame (only frames long enough to carry it).
  let keyAll: number[] = [];
  let carrierIdx: number[] = []; // frame indices that carry the field byte
  for (let i = 0; i < frames.length; i++) {
    const d = frames[i].data;
    if (fieldByte >= d.length) continue;
    keyAll.push((d[fieldByte] >> field.bitLo) & mask);
    carrierIdx.push(i);
  }
  if (keyAll.length < cfg.minFrames) return empty;

  // Cap the sample the NMI + permutation null walk (see `sampleCap`). The per-byte
  // loops below are the hot path (~7 Map-based passes each); bounding the paired
  // sample bounds the whole test. We down-sample keyAll/carrierIdx IN PARALLEL so
  // each (field value, frame index) pairing is preserved.
  if (cfg.sampleCap > 0 && keyAll.length > cfg.sampleCap) {
    const kept = sampledPositions(keyAll.length, cfg.sampleCap);
    const k2: number[] = new Array(kept.length);
    const c2: number[] = new Array(kept.length);
    for (let i = 0; i < kept.length; i++) {
      k2[i] = keyAll[kept[i]];
      c2[i] = carrierIdx[kept[i]];
    }
    keyAll = k2;
    carrierIdx = c2;
  }

  const perByte: DependenceResult['perByte'] = [];
  let dependentBytes = 0;
  for (const j of targetBytes) {
    if (j === fieldByte || j < 0 || j >= cfg.maxBytes) continue;

    // Pair the field value with byte j over frames carrying BOTH.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < carrierIdx.length; k++) {
      const d = frames[carrierIdx[k]].data;
      if (j >= d.length) continue;
      xs.push(keyAll[k]);
      ys.push(d[j]);
    }
    if (xs.length < cfg.minFrames) continue;
    if (distinctCount(ys) < 2) continue; // constant target → no information to judge

    const nmi = normalizedMutualInfo(xs, ys);
    const nullNmi = permutedNullNmi(xs, ys);
    const dependent = nmi - nullNmi >= cfg.nmiMargin;
    if (dependent) dependentBytes += 1;
    perByte.push({ byteIndex: j, nmi, nullNmi, dependent });
  }

  const targetsJudged = perByte.length;
  const conclusive = keyAll.length >= cfg.minFrames && targetsJudged >= 1;
  return {
    targetsJudged,
    dependentBytes,
    perByte,
    conclusive,
    rejects: conclusive && dependentBytes === 0,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Information-theoretic helpers (natural log, Miller-Madow bias-corrected)
 * ──────────────────────────────────────────────────────────────────────── */

function distinctCount(vals: ReadonlyArray<number>): number {
  return new Set(vals).size;
}

/** Shannon entropy (nats) of a value list, Miller-Madow corrected. */
function entropyMM(counts: Map<number, number>, n: number): number {
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log(p);
  }
  // Miller-Madow: + (observed bins - 1) / (2N) corrects the downward bias of the
  // plug-in entropy (and, via MI = Hx+Hy-Hxy, the UPWARD bias of plug-in MI).
  return h + (counts.size - 1) / (2 * n);
}

function counts1(vals: ReadonlyArray<number>): Map<number, number> {
  const m = new Map<number, number>();
  for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function counts2(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < xs.length; i++) {
    const key = xs[i] * 256 + ys[i]; // ys are bytes 0..255
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/**
 * Normalized mutual information NMI = MI / min(H(X), H(Y)) in [0,1], all terms
 * Miller-Madow corrected and MI clamped at 0. 0 when either side is ~constant.
 */
function normalizedMutualInfo(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  const n = xs.length;
  const hx = entropyMM(counts1(xs), n);
  const hy = entropyMM(counts1(ys), n);
  const hxy = entropyMM(counts2(xs, ys), n);
  const mi = Math.max(0, hx + hy - hxy);
  const denom = Math.min(hx, hy);
  if (denom <= 1e-9) return 0;
  return Math.min(1, mi / denom);
}

/** Fixed seeds for the permutation null (pure & reproducible — no RNG). */
const NULL_SEEDS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];

/**
 * The permutation NULL: recompute NMI with the field labels randomly PERMUTED by
 * a few fixed-seed shuffles. A permutation preserves the marginals and the sample
 * sparsity but destroys the X↔Y pairing — even for strictly periodic data, unlike
 * a cyclic shift. We take the MAX NMI over the shuffles (the most adversarial
 * null); a byte counts as dependent only when its real NMI beats this.
 */
function permutedNullNmi(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  let worst = 0;
  for (const seed of NULL_SEEDS) {
    const nmi = normalizedMutualInfo(permute(xs, seed), ys);
    if (nmi > worst) worst = nmi;
  }
  return worst;
}

/**
 * Pick `cap` distinct positions out of [0, n) uniformly, deterministically (a
 * fixed-seed PARTIAL Fisher-Yates — only the first `cap` draws of a full shuffle,
 * so it is O(n) to seed the index array + O(cap) to draw). Uniform sampling (not a
 * stride) avoids aliasing with a periodic mux. Caller guarantees cap < n.
 */
function sampledPositions(n: number, cap: number): number[] {
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  let s = 0x9e3779b1 >>> 0; // fixed seed → reproducible
  for (let i = 0; i < cap; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = i + (s % (n - i)); // pick from the un-drawn tail [i, n)
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  idx.length = cap;
  return idx;
}

/** Fisher-Yates shuffle of a copy of `arr`, driven by a fixed-seed LCG (pure). */
function permute(arr: ReadonlyArray<number>, seed: number): number[] {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
