// Watch model: what the driver pins to a tile.
//
// Three kinds, all resolvable straight from a CanRecord (no buffering):
//   • signal — a named Signal from the Project (decoded: raw*factor+offset).
//   • byte   — a single raw byte of a frame id (0..7), shown as a number.
//   • frame  — a raw frame id; the tile shows all DLC bytes as hex + a bit grid.
//
// Each watch resolves to a LatestValue snapshot updated in place. We keep only
// the latest snapshot per watch (+ the gauge's ring buffer); never history.

import type { CanRecord, FrameDef, Project, Signal } from "../protocol/types";
import { decodeSignal } from "../protocol/decode";

export type WatchKind = "signal" | "byte" | "frame";

export interface SignalWatch {
  kind: "signal";
  key: string; // unique tile key
  signal: Signal;
  label: string;
  unit: string;
}
export interface ByteWatch {
  kind: "byte";
  key: string;
  frameId: number;
  isExtended: boolean;
  byteIndex: number; // 0..7
  label: string;
}
export interface FrameWatch {
  kind: "frame";
  key: string;
  frameId: number;
  isExtended: boolean;
  label: string;
}
export type Watch = SignalWatch | ByteWatch | FrameWatch;

/** Latest decoded snapshot for one watch. Mutated in place; bounded size. */
export interface LatestValue {
  /** Physical/raw numeric value (for signal & byte watches). */
  value: number;
  /** Per-byte payload snapshot (copied; for frame watches and the bit grid). */
  bytes: Uint8Array; // length 8
  dlc: number;
  /** Absolute backend µs of the last update. */
  tUs: number;
  /** Local performance.now() ms at last update — for relative-age display. */
  seenAtMs: number;
  /** Whether the last matching frame was an error frame. */
  isError: boolean;
  /** Count of updates since reset (wraps harmlessly; for flash detection). */
  seq: number;
  /** Previous value, for change/flash detection. */
  prevValue: number;
}

export function newLatest(): LatestValue {
  return {
    value: NaN,
    bytes: new Uint8Array(8),
    dlc: 0,
    tUs: 0,
    seenAtMs: 0,
    isError: false,
    seq: 0,
    prevValue: NaN,
  };
}

/** True if this record's id/extended matches the watch's target frame. */
function matchesFrame(w: Watch, rec: CanRecord): boolean {
  switch (w.kind) {
    case "signal":
      return (
        rec.id === w.signal.frameId && rec.isExtended === w.signal.isExtended
      );
    case "byte":
    case "frame":
      return rec.id === w.frameId && rec.isExtended === w.isExtended;
  }
}

/**
 * Update `lv` in place from a matching record. Returns true if this watch
 * matched the record (caller may use that to mark the tile dirty).
 */
export function applyRecord(w: Watch, lv: LatestValue, rec: CanRecord): boolean {
  if (!matchesFrame(w, rec)) return false;

  lv.prevValue = lv.value;
  lv.dlc = rec.dlc;
  lv.tUs = rec.tUs;
  lv.seenAtMs = performance.now();
  lv.isError = rec.isError;
  lv.seq++;
  // Snapshot the 8 payload bytes (rec.data is shared scratch — must copy).
  lv.bytes.set(rec.data);

  switch (w.kind) {
    case "signal":
      lv.value = decodeSignal(w.signal, rec.data);
      break;
    case "byte":
      lv.value =
        w.byteIndex < rec.dlc ? rec.data[w.byteIndex] : NaN;
      break;
    case "frame":
      lv.value = lv.seq; // frame tiles show bytes, not a single value
      break;
  }
  return true;
}

// ── helpers to build watches ─────────────────────────────────────────────────

export function makeSignalWatch(sig: Signal): SignalWatch {
  return {
    kind: "signal",
    key: `sig:${sig.id}`,
    signal: sig,
    label: sig.name || sig.id,
    unit: sig.unit,
  };
}

export function makeByteWatch(
  frameId: number,
  byteIndex: number,
  isExtended = false,
): ByteWatch {
  return {
    kind: "byte",
    key: `byte:${frameId}:${byteIndex}:${isExtended ? "x" : "s"}`,
    frameId,
    isExtended,
    byteIndex,
    label: `0x${frameId.toString(16).toUpperCase()} · B${byteIndex}`,
  };
}

export function makeFrameWatch(frameId: number, isExtended = false): FrameWatch {
  return {
    kind: "frame",
    key: `frame:${frameId}:${isExtended ? "x" : "s"}`,
    frameId,
    isExtended,
    label: `0x${frameId.toString(16).toUpperCase()}`,
  };
}

/** Flatten a Project to a pickable list of signal watches. */
export function signalsFromProject(project: Project): SignalWatch[] {
  const out: SignalWatch[] = [];
  for (const f of project.frames) {
    for (const s of f.signals) out.push(makeSignalWatch(s));
  }
  return out;
}

/** Find the FrameDef for an id (for labelling). */
export function frameDefFor(
  project: Project,
  id: number,
  isExtended: boolean,
): FrameDef | undefined {
  return project.frames.find((f) => f.id === id && f.isExtended === isExtended);
}
