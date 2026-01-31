/**
 * Parser Web Worker — the heavy/hot path (DESIGN §6).
 *
 * Responsibilities:
 *   - parse binary batches (§3.2) via DataView (little-endian),
 *   - maintain per-id aggregates (latest payload, count, decaying rate,
 *     last-seen, per-bit change flags),
 *   - emit a compact, render-ready SnapshotMsg on a throttled cadence.
 *
 * The raw ring buffer for analysis windows lives on the MAIN thread (DESIGN:
 * "buffering lives in THIS client"); this worker is purely a parser/aggregator
 * so its memory stays bounded by the id count, not by history depth.
 */

/// <reference lib="webworker" />

import { parseBatch } from '../protocol/parseBatch';
import type { BatchMeta, CanFrame } from '../protocol/types';
import type { FromWorkerMsg, FrameRow, ToWorkerMsg } from './workerApi';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Internal mutable aggregate per id (kept off the wire). */
interface Agg {
  id: number;
  isExtended: boolean;
  isError: boolean;
  isRtr: boolean;
  dlc: number;
  data: Uint8Array; // latest payload (length dlc)
  /** Per-bit "recently changed" decaying counters (frames-since-change-ish). */
  changedBits: Uint8Array; // 1 = changed within the flash window
  changeAtUs: Float64Array; // last-change backend µs per bit, for flash decay
  count: number;
  rate: number;
  lastTUs: number;
  prevTUs: number;
}

const aggs = new Map<string, Agg>();
let totalFrames = 0;
let busFps = 0;
let lastBusTUs = 0;
let maxTUs = 0;
let lastBatch: BatchMeta | null = null;

let snapshotIntervalMs = 100;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** How long (backend µs) a bit stays flagged "changed" after it flips. */
const FLASH_WINDOW_US = 400_000; // 400 ms
/** Rate estimator smoothing (EMA over inter-frame interval). */
const RATE_ALPHA = 0.2;

function keyOf(id: number, isExtended: boolean): string {
  return `${isExtended ? 'e' : 's'}${id}`;
}

function aggToRow(a: Agg): FrameRow {
  // Copy buffers so the transfer of the snapshot doesn't neuter worker state.
  return {
    id: a.id,
    isExtended: a.isExtended,
    isError: a.isError,
    isRtr: a.isRtr,
    dlc: a.dlc,
    data: a.data.slice(),
    changedBits: a.changedBits.slice(),
    count: a.count,
    rate: a.rate,
    lastTUs: a.lastTUs,
  };
}

function ingestFrame(f: CanFrame): void {
  totalFrames += 1;
  if (f.tUs > maxTUs) maxTUs = f.tUs;

  // Whole-bus fps estimate (EMA over inter-frame gap).
  if (lastBusTUs > 0) {
    const dt = f.tUs - lastBusTUs;
    if (dt > 0) {
      const inst = 1e6 / dt;
      busFps = busFps === 0 ? inst : busFps + RATE_ALPHA * (inst - busFps);
    }
  }
  lastBusTUs = f.tUs;

  const key = keyOf(f.id, f.isExtended);
  let a = aggs.get(key);
  if (!a) {
    a = {
      id: f.id,
      isExtended: f.isExtended,
      isError: f.isError,
      isRtr: f.isRtr,
      dlc: f.dlc,
      data: f.data.slice(),
      changedBits: new Uint8Array(f.dlc * 8),
      changeAtUs: new Float64Array(f.dlc * 8),
      count: 1,
      rate: 0,
      lastTUs: f.tUs,
      prevTUs: f.tUs,
    };
    aggs.set(key, a);
    return;
  }

  // Per-bit change detection vs previous payload.
  const nBits = Math.max(a.dlc, f.dlc) * 8;
  if (a.changedBits.length < nBits) {
    const grownFlags = new Uint8Array(nBits);
    grownFlags.set(a.changedBits);
    a.changedBits = grownFlags;
    const grownAt = new Float64Array(nBits);
    grownAt.set(a.changeAtUs);
    a.changeAtUs = grownAt;
  }
  const oldData = a.data;
  for (let bit = 0; bit < nBits; bit++) {
    const byteIdx = bit >> 3;
    const mask = 1 << (bit & 7);
    const oldBit = byteIdx < oldData.length ? oldData[byteIdx] & mask : 0;
    const newBit = byteIdx < f.data.length ? f.data[byteIdx] & mask : 0;
    if (oldBit !== newBit) {
      a.changedBits[bit] = 1;
      a.changeAtUs[bit] = f.tUs;
    }
  }

  // Rate (EMA over inter-frame interval).
  const dt = f.tUs - a.lastTUs;
  if (dt > 0) {
    const inst = 1e6 / dt;
    a.rate = a.rate === 0 ? inst : a.rate + RATE_ALPHA * (inst - a.rate);
  }

  a.prevTUs = a.lastTUs;
  a.lastTUs = f.tUs;
  a.isError = f.isError;
  a.isRtr = f.isRtr;
  a.dlc = f.dlc;
  a.data = f.data.slice();
  a.count += 1;
}

/** Decay the per-bit flash flags so the grid stops flashing after FLASH_WINDOW. */
function decayFlashes(): void {
  for (const a of aggs.values()) {
    for (let bit = 0; bit < a.changedBits.length; bit++) {
      if (a.changedBits[bit] && maxTUs - a.changeAtUs[bit] > FLASH_WINDOW_US) {
        a.changedBits[bit] = 0;
      }
    }
  }
}

function emitSnapshot(): void {
  decayFlashes();
  const rows: FrameRow[] = [];
  for (const a of aggs.values()) rows.push(aggToRow(a));
  rows.sort((x, y) => x.id - y.id);

  const msg: FromWorkerMsg = {
    type: 'snapshot',
    rows,
    totalFrames,
    busFps,
    lastBatch,
    maxTUs,
  };
  ctx.postMessage(msg);
}

function startSnapshots(): void {
  if (snapshotTimer !== null) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(emitSnapshot, snapshotIntervalMs);
}

function reset(): void {
  aggs.clear();
  totalFrames = 0;
  busFps = 0;
  lastBusTUs = 0;
  maxTUs = 0;
  lastBatch = null;
}

ctx.onmessage = (ev: MessageEvent<ToWorkerMsg>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'ingest': {
      try {
        const { meta, frames } = parseBatch(msg.buffer);
        lastBatch = meta;
        for (let i = 0; i < frames.length; i++) ingestFrame(frames[i]);
      } catch (err) {
        const out: FromWorkerMsg = {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        ctx.postMessage(out);
      }
      break;
    }
    case 'config': {
      snapshotIntervalMs = Math.max(16, msg.snapshotIntervalMs);
      startSnapshots();
      break;
    }
    case 'reset': {
      reset();
      break;
    }
  }
};

// Begin emitting snapshots at the default cadence immediately.
startSnapshots();
