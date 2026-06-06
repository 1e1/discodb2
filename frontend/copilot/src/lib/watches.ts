// Watch model: what the driver pins to a tile.
//
// The copilot is a Wizard companion (DESIGN §7); the ONLY watch kind it shows is
// a decoded, CONFIRMED Signal — a named value tile. Raw frame/byte/bit watching
// is a COCKPIT concern (the heavy analysis client), not the driver's glanceable
// phone, so those kinds were removed here.
//
// A signal watch resolves straight from a CanRecord (no buffering): we keep only
// the latest decoded snapshot per watch (+ the gauge's ring buffer); never history.

import type { CanRecord, Project, Signal } from "../protocol/types";
import { decodeSignal } from "../protocol/decode";

export type WatchKind = "signal";

export interface SignalWatch {
  kind: "signal";
  key: string; // unique tile key
  signal: Signal;
  label: string;
  unit: string;
}
export type Watch = SignalWatch;

/** Latest decoded snapshot for one watch. Mutated in place; bounded size. */
export interface LatestValue {
  /** Physical/raw numeric value. */
  value: number;
  /** Absolute backend µs of the last update. */
  tUs: number;
  /** Local performance.now() ms at last update — for relative-age display. */
  seenAtMs: number;
  /** Whether the last matching frame was an error frame. */
  isError: boolean;
  /** Count of updates since reset (wraps harmlessly). */
  seq: number;
  /** Previous value, for change detection. */
  prevValue: number;
}

export function newLatest(): LatestValue {
  return {
    value: NaN,
    tUs: 0,
    seenAtMs: 0,
    isError: false,
    seq: 0,
    prevValue: NaN,
  };
}

/** True if this record's id/extended matches the watch's target frame. */
function matchesFrame(w: Watch, rec: CanRecord): boolean {
  return rec.id === w.signal.frameId && rec.isExtended === w.signal.isExtended;
}

/**
 * Update `lv` in place from a matching record. Returns true if this watch
 * matched the record (caller may use that to mark the tile dirty).
 */
export function applyRecord(w: Watch, lv: LatestValue, rec: CanRecord): boolean {
  if (!matchesFrame(w, rec)) return false;

  lv.prevValue = lv.value;
  lv.tUs = rec.tUs;
  lv.seenAtMs = performance.now();
  lv.isError = rec.isError;
  lv.seq++;
  lv.value = decodeSignal(w.signal, rec.data);
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

/** Flatten a Project to a pickable list of signal watches. */
export function signalsFromProject(project: Project): SignalWatch[] {
  const out: SignalWatch[] = [];
  for (const f of project.frames) {
    for (const s of f.signals) out.push(makeSignalWatch(s));
  }
  return out;
}
