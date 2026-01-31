/**
 * Typed message contract between the main thread and the parser Web Worker.
 *
 * Heavy work that lives in the worker (DESIGN §6: "Heavy compute in Web
 * Workers"):
 *   - parsing binary batches (§3.2) with DataView,
 *   - aggregating per-id statistics (rate, count, last payload, last-seen),
 *   - per-bit change detection for the inspector grid.
 *
 * The main thread receives compact, render-ready snapshots on a throttled
 * cadence rather than every frame — so the UI never does per-frame DOM work.
 */

import type { BatchMeta } from '../protocol/types';

// ── main → worker ─────────────────────────────────────────────────────────────

/** Feed one raw binary batch (the ArrayBuffer is transferred, zero-copy). */
export interface IngestMsg {
  type: 'ingest';
  buffer: ArrayBuffer;
}

/** Set how often the worker emits an aggregated snapshot to the UI (ms). */
export interface ConfigMsg {
  type: 'config';
  snapshotIntervalMs: number;
}

/** Clear all accumulated state (e.g. on reconnect / new session). */
export interface ResetMsg {
  type: 'reset';
}

export type ToWorkerMsg = IngestMsg | ConfigMsg | ResetMsg;

// ── worker → main ─────────────────────────────────────────────────────────────

/**
 * Per-id aggregate row for the live frame table. Compact + structured-clone
 * friendly (no class instances).
 */
export interface FrameRow {
  id: number;
  isExtended: boolean;
  isError: boolean;
  isRtr: boolean;
  dlc: number;
  /** Latest payload bytes (length === dlc). */
  data: Uint8Array;
  /** Per-bit "changed recently" mask, one entry per data bit (dlc*8 bits). */
  changedBits: Uint8Array;
  /** Total frames seen for this id this session. */
  count: number;
  /** Estimated frames/second (decaying estimate). */
  rate: number;
  /** Backend monotonic µs of the most recent frame. */
  lastTUs: number;
}

/** A throttled snapshot of all known ids plus stream meta. */
export interface SnapshotMsg {
  type: 'snapshot';
  rows: FrameRow[];
  /** Total frames parsed since last reset. */
  totalFrames: number;
  /** Frames-per-second across the whole bus (decaying estimate). */
  busFps: number;
  /** Meta of the most recent batch (replay flag, base time). */
  lastBatch: BatchMeta | null;
  /** Highest backend monotonic µs seen so far (for relative-time display). */
  maxTUs: number;
}

/** A non-fatal parse error surfaced for diagnostics. */
export interface WorkerErrorMsg {
  type: 'error';
  message: string;
}

export type FromWorkerMsg = SnapshotMsg | WorkerErrorMsg;
