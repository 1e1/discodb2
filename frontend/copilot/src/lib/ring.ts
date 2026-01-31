// Fixed-capacity numeric ring buffer — the ONLY history the copilot keeps.
//
// Backed by a single preallocated Float64Array; pushing past capacity overwrites
// the oldest sample. No growth, no GC churn — this is the bounded-memory budget
// for the gauge sparkline (§7: tiny rolling window, never full history).

export class RingBuffer {
  private buf: Float64Array;
  private cap: number;
  private head = 0; // next write index
  private len = 0;

  constructor(capacity: number) {
    this.cap = Math.max(1, capacity | 0);
    this.buf = new Float64Array(this.cap);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }

  get length(): number {
    return this.len;
  }
  get capacity(): number {
    return this.cap;
  }

  /** Oldest→newest, into `out` (length >= length). Returns the count written. */
  copyInto(out: Float64Array): number {
    const start = (this.head - this.len + this.cap) % this.cap;
    for (let i = 0; i < this.len; i++) {
      out[i] = this.buf[(start + i) % this.cap];
    }
    return this.len;
  }

  /** Min/max over current contents (NaN-safe-ish; empty → {min:0,max:0}). */
  extent(): { min: number; max: number } {
    if (this.len === 0) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    const start = (this.head - this.len + this.cap) % this.cap;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[(start + i) % this.cap];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  last(): number | undefined {
    if (this.len === 0) return undefined;
    return this.buf[(this.head - 1 + this.cap) % this.cap];
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}
