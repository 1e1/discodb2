/**
 * INCREMENTAL message model for the MessageList detail pane.
 *
 * WHY: the list is cumulative (every mux value seen since connect persists), so
 * the old path re-materialized the selected id's ENTIRE history (`lastSeconds`)
 * and re-grouped it on every ~10 Hz snapshot tick — O(N)/tick. This model keeps
 * the group state across ticks and only folds in the NEW frames (via the ring's
 * O(delta) `since` cursor), so a steady stream costs O(frames-per-tick), not O(N).
 *
 * It also owns the (expensive) Message-ID DETECTION, memoized: re-detected only on
 * selection/def change, a staleness backstop, or a ring lap — so detection
 * materializes full history at most every few seconds, not every tick.
 *
 * RATE: the cumulative `count` is exact; the windowed RATE is kept per group as a
 * ring of 1-second buckets over a 600 s horizon (the largest fixed UI window), so
 * the windowed count is a bounded bucket sum instead of a full re-scan. This is
 * accurate to ±1 s at the window edge — fine for an fps read-out, and the only
 * intentional divergence from computeMessages (which counts by exact µs).
 *
 * GROUPS are bounded by mux cardinality. For a too-wide discriminator (> MAX_MESSAGES
 * distinct values — the degenerate "field too wide" case, already render-capped +
 * warned), the model drops to PASSTHROUGH: it re-derives via computeMessages each
 * tick (no per-group bucket memory), matching the prior behavior exactly.
 *
 * The cheap parts (computeMessages, the field helpers) are SHARED so the
 * incremental groups and the from-scratch path stay identical — locked by an
 * equivalence test (messageModel.test.ts).
 */

import {
  computeMessages,
  effectiveMessageId,
  fieldBytes,
  fieldHexWidth,
  fieldValueOf,
  MAX_MESSAGES,
  type EffectiveMessageId,
  type MessageIdField,
  type MessageRow,
} from './messages';
import type { RawFrameRing, FrameView } from '../state/ringBuffer';
import type { FrameDef } from './datamodel';

const ALL_SECONDS = 86400; // "All" span = everything still buffered for this id.
const RATE_HORIZON_S = 600; // largest fixed UI window → bucket ring length.
const DETECT_REFRESH_US = 5e6; // re-detect at most this often (staleness backstop).
const DETECT_GROWTH = 1.25; // ...or once the id's history has grown by this factor.

interface Grp {
  data: Uint8Array;
  dlc: number;
  count: number; // cumulative since connect
  lastTUs: number;
  bSec: Int32Array; // per-bucket second tag (−1 = empty)
  bCnt: Int32Array; // per-bucket arrival count
}

type Sel = { id: number; isExtended: boolean };

export interface MessageModel {
  /** Recompute the message rows for the selection — incremental where possible. */
  sync(ring: RawFrameRing, sel: Sel | null, def: FrameDef | undefined, windowSeconds: number, nowTUs: number): MessageRow[];
  /**
   * The effective Message-ID resolved at the last {@link sync} (the SAME detection
   * the rows are split by). Lets the Inspector read-out share this one detection
   * instead of re-detecting separately — over the full history, so it sees more
   * evidence than a short-window resolver would. Null when nothing is selected.
   */
  effective(): EffectiveMessageId | null;
}

/** Create a model with its own state. One per MessageList view (no global state). */
export function createMessageModel(): MessageModel {
  // Detection memo.
  let eff: EffectiveMessageId | null = null;
  let lastDetectTUs = -Infinity;
  let curSelKey: string | null = null;
  let curDef: FrameDef | undefined;
  let lastGen = -1; // ring generation at last sync (reset/reconnect detection)
  let idCount = 0; // cumulative frames folded for this id (drives growth re-detect)
  let detectCount = 0; // idCount at the last detection

  // Grouping state (valid while mode === 'incremental').
  let curFieldKey: string | null = null;
  let mode: 'incremental' | 'passthrough' = 'incremental';
  let cursor = 0;
  let groups = new Map<number, Grp>(); // field !== null, keyed by mux value (incl. −1)
  let nullGroup: Grp | null = null; // field === null (one message = the frame)
  let valueOfFn: ((f: FrameView) => number) | null = null;
  let idBytes: number[] | null = null;
  let idHexWidth = 0;
  let idFirstTUs = 0;
  let idLastTUs = 0;

  function histOf(ring: RawFrameRing, sel: Sel): FrameView[] {
    return ring.lastSeconds(ALL_SECONDS, sel.id).filter((f) => f.isExtended === sel.isExtended);
  }

  function makeGrp(f: FrameView): Grp {
    return {
      data: f.data,
      dlc: f.dlc,
      count: 0,
      lastTUs: f.tUs,
      bSec: new Int32Array(RATE_HORIZON_S).fill(-1),
      bCnt: new Int32Array(RATE_HORIZON_S),
    };
  }

  function bump(g: Grp, sec: number): void {
    const idx = ((sec % RATE_HORIZON_S) + RATE_HORIZON_S) % RATE_HORIZON_S;
    if (g.bSec[idx] !== sec) {
      g.bSec[idx] = sec;
      g.bCnt[idx] = 0;
    }
    g.bCnt[idx] += 1;
  }

  function updateGrp(g: Grp, f: FrameView): void {
    g.count += 1;
    g.data = f.data; // frames are oldest → newest, so last write = latest payload.
    g.dlc = f.dlc;
    g.lastTUs = f.tUs;
    bump(g, Math.floor(f.tUs / 1e6));
  }

  /** Fold one frame into the group state. Returns false if it overflowed MAX_MESSAGES. */
  function addFrame(field: MessageIdField | null, f: FrameView): boolean {
    idCount += 1;
    if (field === null) {
      if (nullGroup === null) nullGroup = makeGrp(f);
      updateGrp(nullGroup, f);
      return true;
    }
    const v = valueOfFn!(f);
    let g = groups.get(v);
    if (!g) {
      g = makeGrp(f);
      groups.set(v, g);
    }
    updateGrp(g, f);
    return groups.size <= MAX_MESSAGES;
  }

  function rebuildState(field: MessageIdField | null, hist: FrameView[]): void {
    mode = 'incremental';
    groups = new Map();
    nullGroup = null;
    idCount = 0; // addFrame re-counts as it folds `hist` below.
    valueOfFn = field ? fieldValueOf(field) : null;
    idBytes = field ? fieldBytes(field) : null;
    idHexWidth = field ? fieldHexWidth(field) : 0;
    idFirstTUs = hist.length ? hist[0].tUs : 0;
    idLastTUs = hist.length ? hist[hist.length - 1].tUs : 0;
    for (const f of hist) {
      if (!addFrame(field, f)) {
        // Too wide → stop building per-group state; fall back to passthrough.
        mode = 'passthrough';
        groups = new Map();
        nullGroup = null;
        return;
      }
    }
  }

  function spanOf(frames: FrameView[]): number {
    if (frames.length < 2) return 1;
    return Math.max((frames[frames.length - 1].tUs - frames[0].tUs) / 1e6, 1e-6);
  }

  function windowedCount(g: Grp, nowSec: number, winSec: number): number {
    let sum = 0;
    for (let s = nowSec - winSec + 1; s <= nowSec; s++) {
      const idx = ((s % RATE_HORIZON_S) + RATE_HORIZON_S) % RATE_HORIZON_S;
      if (g.bSec[idx] === s) sum += g.bCnt[idx];
    }
    return sum;
  }

  function emit(field: MessageIdField | null, windowSeconds: number, nowTUs: number): MessageRow[] {
    const isAll = windowSeconds === 0;
    const denom = isAll ? Math.max((idLastTUs - idFirstTUs) / 1e6, 1e-6) : windowSeconds;
    const nowSec = Math.floor(nowTUs / 1e6);
    const rateOf = (g: Grp): number => {
      if (denom <= 0) return 0;
      const wc = isAll ? g.count : windowedCount(g, nowSec, windowSeconds);
      return wc / denom;
    };

    if (field === null) {
      if (nullGroup === null) return [];
      const g = nullGroup;
      return [{ mux: null, data: g.data, dlc: g.dlc, rate: rateOf(g), lastTUs: g.lastTUs, count: g.count, idBytes: null, idHexWidth: 0 }];
    }

    const rows: MessageRow[] = [];
    for (const [v, g] of groups) {
      rows.push({ mux: v, data: g.data, dlc: g.dlc, rate: rateOf(g), lastTUs: g.lastTUs, count: g.count, idBytes, idHexWidth });
    }
    // Value-ascending, like computeMessages — the row order never moves.
    rows.sort((a, b) => (a.mux as number) - (b.mux as number));
    return rows;
  }

  function reset(): void {
    eff = null;
    lastDetectTUs = -Infinity;
    curSelKey = null;
    curDef = undefined;
    curFieldKey = null;
    mode = 'incremental';
    cursor = 0;
    groups = new Map();
    nullGroup = null;
    idCount = 0;
    detectCount = 0;
  }

  return {
    sync(ring, sel, def, windowSeconds, nowTUs) {
      if (!sel) {
        reset();
        return [];
      }
      const selKey = `${sel.id}:${sel.isExtended}`;
      // A ring reset (reconnect) invalidates everything, even if the cursor would
      // otherwise look valid (totalPushed can climb back to a stale value).
      const genChanged = ring.generation !== lastGen;
      lastGen = ring.generation;
      const selChanged = selKey !== curSelKey || def !== curDef || genChanged;
      curSelKey = selKey;
      curDef = def;

      // 1. Detection (memoized): re-detect on selection/def/reset change, when the
      //    id's history has grown materially (Auto sharpens with evidence — this is
      //    what closes the stale-field gap), or on a time backstop. Full history is
      //    materialized ONLY here, never every tick.
      let hist: FrameView[] | null = null;
      let detected = false;
      if (
        eff === null ||
        selChanged ||
        idCount >= detectCount * DETECT_GROWTH + 1 ||
        nowTUs - lastDetectTUs >= DETECT_REFRESH_US
      ) {
        hist = histOf(ring, sel);
        eff = effectiveMessageId(hist, def);
        lastDetectTUs = nowTUs;
        detected = true;
      }

      // 2. Resolve the field and whether the group state must rebuild.
      const field = eff.field;
      const fKey = `${selKey}|${field ? `${field.bitStart},${field.bitLength},${field.byteOrder},${field.signed}` : 'none'}`;
      let rebuild = selChanged || fKey !== curFieldKey;

      // 3. Incremental append (unless we must rebuild, or we are in passthrough —
      //    passthrough keeps no group state, so it must NOT fold deltas in).
      if (!rebuild && mode === 'incremental') {
        const delta = ring.since(cursor, sel.id);
        if (delta.lapped) {
          rebuild = true;
        } else {
          for (const f of delta.frames) {
            if (f.isExtended !== sel.isExtended) continue;
            if (!addFrame(field, f)) {
              // Crossed into too-wide while appending → passthrough.
              mode = 'passthrough';
              groups = new Map();
              nullGroup = null;
              break;
            }
            idLastTUs = f.tUs;
          }
          cursor = delta.seq;
        }
      }

      // 4. Rebuild from full history (reuse `hist` from detection when present).
      if (rebuild) {
        if (hist === null) hist = histOf(ring, sel);
        rebuildState(field, hist);
        cursor = ring.pushed;
        curFieldKey = fKey;
      }

      // Mark the growth baseline at the post-rebuild/append count.
      if (detected) detectCount = idCount;

      // 5. Emit. Passthrough re-derives via computeMessages (degenerate too-wide).
      if (mode === 'passthrough') {
        const h = hist ?? histOf(ring, sel);
        const denom = windowSeconds === 0 ? spanOf(h) : windowSeconds;
        return computeMessages(h, def, denom, nowTUs, eff ?? undefined);
      }
      return emit(field, windowSeconds, nowTUs);
    },
    effective() {
      return eff;
    },
  };
}
