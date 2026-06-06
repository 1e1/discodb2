/**
 * Bounded ring buffer of raw CAN frames for analysis windows.
 *
 * DESIGN: "A bounded ring buffer of raw frames for analysis windows (buffering
 * lives in THIS client)." The cockpit is the heavy client — it keeps a long
 * history; the copilot does not.
 *
 * Storage strategy: a Struct-of-Arrays over flat typed arrays. This keeps the
 * buffer compact (no per-frame object allocation / GC churn) for the deep
 * history a reverse-engineering session needs, and makes time-window slicing a
 * pair of index lookups. Payloads are stored in a fixed 8-byte stride (classic
 * CAN ≤ 8, §3.2).
 *
 * Capacity is a frame COUNT. At 2 kfps a 1e6-frame buffer ≈ ~8 min of history
 * and ~28 MB — well within a laptop budget.
 */

import type { CanFrame } from '../protocol/types';
import { PACKED_STRIDE, type PackedFrames } from '@shared/analysis/packed.ts';

const PAYLOAD_STRIDE = 8;

export interface FrameView {
  tUs: number;
  id: number;
  isExtended: boolean;
  isError: boolean;
  isRtr: boolean;
  dlc: number;
  // Length-dlc payload. From at/window/lastSeconds it is a COPY (safe to
  // retain across pushes/wraparound). From atView/windowView/lastSecondsView it
  // is a SUBARRAY VIEW into the backing store (no copy) — see those methods.
  data: Uint8Array;
}

export interface RingStats {
  capacity: number;
  size: number;
  /** Backend µs of oldest retained frame, or null if empty. */
  oldestTUs: number | null;
  /** Backend µs of newest retained frame, or null if empty. */
  newestTUs: number | null;
}

export class RawFrameRing {
  private readonly cap: number;
  private head = 0; // next write slot
  private count = 0; // number of valid frames (<= cap)
  // Monotonic total of frames ever pushed (NOT capped) — a stable cursor space
  // for incremental consumers (see `since`).
  private totalPushed = 0;
  // Bumped on every clear() so incremental consumers detect a reset/reconnect
  // even when `totalPushed` happens to climb back to a stale cursor value.
  private gen = 0;

  private readonly tUs: Float64Array;
  private readonly id: Uint32Array;
  private readonly flags: Uint8Array; // bit0 extended, bit1 error, bit2 rtr
  private readonly dlc: Uint8Array;
  private readonly data: Uint8Array; // cap * 8

  constructor(capacity = 1_000_000) {
    this.cap = Math.max(1, capacity);
    this.tUs = new Float64Array(this.cap);
    this.id = new Uint32Array(this.cap);
    this.flags = new Uint8Array(this.cap);
    this.dlc = new Uint8Array(this.cap);
    this.data = new Uint8Array(this.cap * PAYLOAD_STRIDE);
  }

  get capacity(): number {
    return this.cap;
  }
  get size(): number {
    return this.count;
  }
  /** Monotonic count of frames ever pushed — the cursor space for {@link since}. */
  get pushed(): number {
    return this.totalPushed;
  }
  /** Increments on each {@link clear} — incremental consumers rebuild when it changes. */
  get generation(): number {
    return this.gen;
  }

  push(f: CanFrame): void {
    const i = this.head;
    this.tUs[i] = f.tUs;
    this.id[i] = f.id;
    this.flags[i] =
      (f.isExtended ? 1 : 0) | (f.isError ? 2 : 0) | (f.isRtr ? 4 : 0);
    this.dlc[i] = f.dlc;
    const base = i * PAYLOAD_STRIDE;
    const n = Math.min(f.dlc, PAYLOAD_STRIDE);
    for (let b = 0; b < PAYLOAD_STRIDE; b++) {
      this.data[base + b] = b < n ? f.data[b] : 0;
    }
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
    this.totalPushed += 1;
  }

  pushMany(frames: ArrayLike<CanFrame>): void {
    for (let i = 0; i < frames.length; i++) this.push(frames[i]);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.totalPushed = 0;
    this.gen += 1;
  }

  /** Logical index 0 = oldest retained frame. */
  private physical(logical: number): number {
    const start = this.count < this.cap ? 0 : this.head;
    return (start + logical) % this.cap;
  }

  /**
   * Build a FrameView from a PHYSICAL slot. When `view` is false `data` is a
   * copy (slice); when true it is a subarray VIEW into the backing store (no
   * copy). Per-frame payloads are contiguous (fixed 8-byte stride), so a view
   * never spans the circular wrap. Single source of truth for at/atView and
   * window/windowView so the two flavors cannot drift.
   */
  private build(p: number, view: boolean): FrameView {
    const dlc = this.dlc[p];
    const base = p * PAYLOAD_STRIDE;
    const data = view
      ? this.data.subarray(base, base + dlc)
      : this.data.slice(base, base + dlc);
    const fl = this.flags[p];
    return {
      tUs: this.tUs[p],
      id: this.id[p],
      isExtended: (fl & 1) !== 0,
      isError: (fl & 2) !== 0,
      isRtr: (fl & 4) !== 0,
      dlc,
      data,
    };
  }

  /** Materialize a single frame at logical index (0 = oldest). Data is COPIED. */
  at(logical: number): FrameView {
    if (logical < 0 || logical >= this.count) {
      throw new RangeError(`ring index ${logical} out of range [0,${this.count})`);
    }
    return this.build(this.physical(logical), false);
  }

  /**
   * Like {@link at}, but `data` is a SUBARRAY VIEW into the ring backing store
   * (NO copy). UNSAFE to retain: a later push() overwrites the slot and mutates
   * the view. For synchronous, non-retaining consumers only (the Hunt scans).
   */
  atView(logical: number): FrameView {
    if (logical < 0 || logical >= this.count) {
      throw new RangeError(`ring index ${logical} out of range [0,${this.count})`);
    }
    return this.build(this.physical(logical), true);
  }

  stats(): RingStats {
    if (this.count === 0) {
      return { capacity: this.cap, size: 0, oldestTUs: null, newestTUs: null };
    }
    const oldest = this.tUs[this.physical(0)];
    const newest = this.tUs[this.physical(this.count - 1)];
    return { capacity: this.cap, size: this.count, oldestTUs: oldest, newestTUs: newest };
  }

  /** Shared body for window/windowView: only the copy-vs-view flavor differs. */
  private collect(startTUs: number, endTUs: number, id: number | undefined, view: boolean): FrameView[] {
    const out: FrameView[] = [];
    for (let l = 0; l < this.count; l++) {
      const p = this.physical(l);
      const t = this.tUs[p];
      if (t < startTUs || t > endTUs) continue;
      if (id !== undefined && this.id[p] !== id) continue;
      out.push(this.build(p, view));
    }
    return out;
  }

  /**
   * Return all frames whose backend µs timestamp ∈ [startTUs, endTUs],
   * optionally filtered to a single id. Materializes FrameViews with COPIED
   * payloads — intended for analysis windows (the Hunt seam), not per-render use.
   */
  window(startTUs: number, endTUs: number, id?: number): FrameView[] {
    return this.collect(startTUs, endTUs, id, false);
  }

  /**
   * Like {@link window}, but payloads are SUBARRAY VIEWS (no copy). UNSAFE to
   * retain past the current task — a later push() overwrites the slots. For
   * synchronous, non-retaining consumers only (the Hunt scans).
   */
  windowView(startTUs: number, endTUs: number, id?: number): FrameView[] {
    return this.collect(startTUs, endTUs, id, true);
  }

  /** The most recent `seconds` of history relative to the newest frame. COPIED. */
  lastSeconds(seconds: number, id?: number): FrameView[] {
    if (this.count === 0) return [];
    const newest = this.tUs[this.physical(this.count - 1)];
    return this.window(newest - seconds * 1e6, newest, id);
  }

  /**
   * Like {@link lastSeconds}, but payloads are SUBARRAY VIEWS (no copy). UNSAFE
   * to retain — synchronous, non-retaining consumers only (the Hunt scans).
   */
  lastSecondsView(seconds: number, id?: number): FrameView[] {
    if (this.count === 0) return [];
    const newest = this.tUs[this.physical(this.count - 1)];
    return this.windowView(newest - seconds * 1e6, newest, id);
  }

  /**
   * Materialize a window as columnar {@link PackedFrames} (DESIGN §6.1.4 step 3b):
   * ONE bulk allocation of the five typed arrays sized to the window count, vs the
   * N per-frame `FrameView`/`Uint8Array` objects of {@link window}. The result is
   * a real COPY (safe to retain — unlike a {@link windowView}) and is the layout a
   * WASM analyzer would consume. Frames are time-ordered, so an UNFILTERED full
   * window copies in at most two contiguous spans (handling the circular wrap);
   * a time sub-range / id filter falls back to a per-frame copy into the same
   * preallocated buffer (still no per-frame objects).
   */
  windowPacked(startTUs: number, endTUs: number, id?: number): PackedFrames {
    // First pass: count matches so the columns are sized once.
    let n = 0;
    for (let l = 0; l < this.count; l++) {
      const p = this.physical(l);
      const t = this.tUs[p];
      if (t < startTUs || t > endTUs) continue;
      if (id !== undefined && this.id[p] !== id) continue;
      n++;
    }
    const outTUs = new Float64Array(n);
    const outId = new Uint32Array(n);
    const outFlags = new Uint8Array(n);
    const outDlc = new Uint8Array(n);
    const outData = new Uint8Array(n * PACKED_STRIDE);

    // Fast path: the whole ring (no id filter, nothing time-excluded) is a single
    // contiguous logical range → at most two physical spans across the wrap.
    if (id === undefined && n === this.count && n > 0) {
      const startPhys = this.count < this.cap ? 0 : this.head;
      const first = Math.min(this.count, this.cap - startPhys);
      outTUs.set(this.tUs.subarray(startPhys, startPhys + first), 0);
      outId.set(this.id.subarray(startPhys, startPhys + first), 0);
      outFlags.set(this.flags.subarray(startPhys, startPhys + first), 0);
      outDlc.set(this.dlc.subarray(startPhys, startPhys + first), 0);
      outData.set(this.data.subarray(startPhys * PAYLOAD_STRIDE, (startPhys + first) * PAYLOAD_STRIDE), 0);
      const rest = this.count - first;
      if (rest > 0) {
        outTUs.set(this.tUs.subarray(0, rest), first);
        outId.set(this.id.subarray(0, rest), first);
        outFlags.set(this.flags.subarray(0, rest), first);
        outDlc.set(this.dlc.subarray(0, rest), first);
        outData.set(this.data.subarray(0, rest * PAYLOAD_STRIDE), first * PACKED_STRIDE);
      }
      return { count: n, tUs: outTUs, id: outId, flags: outFlags, dlc: outDlc, data: outData };
    }

    // General path: per-frame scalar + 8-byte copy into the preallocated buffer.
    let w = 0;
    for (let l = 0; l < this.count; l++) {
      const p = this.physical(l);
      const t = this.tUs[p];
      if (t < startTUs || t > endTUs) continue;
      if (id !== undefined && this.id[p] !== id) continue;
      outTUs[w] = this.tUs[p];
      outId[w] = this.id[p];
      outFlags[w] = this.flags[p];
      outDlc[w] = this.dlc[p];
      const sb = p * PAYLOAD_STRIDE;
      const db = w * PACKED_STRIDE;
      for (let b = 0; b < PACKED_STRIDE; b++) outData[db + b] = this.data[sb + b];
      w++;
    }
    return { count: n, tUs: outTUs, id: outId, flags: outFlags, dlc: outDlc, data: outData };
  }

  /** The most recent `seconds` of history as {@link PackedFrames} (see windowPacked). */
  lastSecondsPacked(seconds: number, id?: number): PackedFrames {
    if (this.count === 0) return this.windowPacked(1, 0); // empty (start > end)
    const newest = this.tUs[this.physical(this.count - 1)];
    return this.windowPacked(newest - seconds * 1e6, newest, id);
  }

  /**
   * Frames pushed SINCE a cursor `seq` (a value previously returned here, or 0 to
   * start), optionally filtered to one id, in arrival order. Returns the new
   * frames, the new cursor, and `lapped` = true when the cursor is no longer in
   * the buffer — it fell off the back (the ring wrapped past it) or the ring was
   * cleared (cursor now ahead of `pushed`) — so the caller must rebuild from
   * scratch. Cost is O(frames pushed since seq), NOT O(ring): the incremental
   * read for the message list, vs `lastSeconds` which re-scans everything.
   */
  since(seq: number, id?: number): { frames: FrameView[]; seq: number; lapped: boolean } {
    const pushed = this.totalPushed;
    // Cursor ahead of `pushed` (ring cleared/reconnected) or fallen off the back.
    if (seq > pushed || seq < pushed - this.count) {
      return { frames: [], seq: pushed, lapped: true };
    }
    const frames: FrameView[] = [];
    const base = pushed - this.count; // absolute index of logical 0 (oldest).
    for (let a = seq; a < pushed; a++) {
      const logical = a - base;
      if (id !== undefined && this.id[this.physical(logical)] !== id) continue;
      frames.push(this.at(logical));
    }
    return { frames, seq: pushed, lapped: false };
  }
}
