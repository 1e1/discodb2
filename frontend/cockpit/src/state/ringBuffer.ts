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

const PAYLOAD_STRIDE = 8;

export interface FrameView {
  tUs: number;
  id: number;
  isExtended: boolean;
  isError: boolean;
  isRtr: boolean;
  dlc: number;
  data: Uint8Array; // view of length dlc into the backing store (copy on read)
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
  }

  pushMany(frames: ArrayLike<CanFrame>): void {
    for (let i = 0; i < frames.length; i++) this.push(frames[i]);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Logical index 0 = oldest retained frame. */
  private physical(logical: number): number {
    const start = this.count < this.cap ? 0 : this.head;
    return (start + logical) % this.cap;
  }

  /** Materialize a single frame at logical index (0 = oldest). */
  at(logical: number): FrameView {
    if (logical < 0 || logical >= this.count) {
      throw new RangeError(`ring index ${logical} out of range [0,${this.count})`);
    }
    const p = this.physical(logical);
    const dlc = this.dlc[p];
    const base = p * PAYLOAD_STRIDE;
    const data = this.data.slice(base, base + dlc);
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

  stats(): RingStats {
    if (this.count === 0) {
      return { capacity: this.cap, size: 0, oldestTUs: null, newestTUs: null };
    }
    const oldest = this.tUs[this.physical(0)];
    const newest = this.tUs[this.physical(this.count - 1)];
    return { capacity: this.cap, size: this.count, oldestTUs: oldest, newestTUs: newest };
  }

  /**
   * Return all frames whose backend µs timestamp ∈ [startTUs, endTUs],
   * optionally filtered to a single id. Materializes FrameViews — intended for
   * analysis windows (the Hunt seam), not per-render use.
   */
  window(startTUs: number, endTUs: number, id?: number): FrameView[] {
    const out: FrameView[] = [];
    for (let l = 0; l < this.count; l++) {
      const p = this.physical(l);
      const t = this.tUs[p];
      if (t < startTUs || t > endTUs) continue;
      if (id !== undefined && this.id[p] !== id) continue;
      out.push(this.at(l));
    }
    return out;
  }

  /** The most recent `seconds` of history relative to the newest frame. */
  lastSeconds(seconds: number, id?: number): FrameView[] {
    if (this.count === 0) return [];
    const newest = this.tUs[this.physical(this.count - 1)];
    return this.window(newest - seconds * 1e6, newest, id);
  }
}
