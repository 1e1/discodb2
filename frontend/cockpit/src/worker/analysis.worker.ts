/**
 * Analysis Web Worker — OWNS the raw analysis ring (DESIGN §6.1.2).
 *
 * It parses each batch into a worker-owned RawFrameRing and, on a throttled
 * cadence (~100 ms, matching the parser worker's snapshot), posts:
 *   - `ringStats` — the ring's size/time span, and
 *   - `messages`  — the per-message rows for the currently selected frame, via
 *     the incremental `MessageModel` (which it owns; detection memoized +
 *     cumulative groups folded from the ring's O(delta) cursor).
 *
 * This moves the message-list compute off the main thread: the main thread posts
 * `select {sel, def, windowSeconds}` when the selection / FrameDef / window
 * changes, and binds the posted rows into a store — no `$:`-block ring read.
 *
 * During the migration a PARALLEL ring still lives on the main thread (read by
 * the Inspector + Hunt panel until those move too); only the message list reads
 * from here. The ring is a pure SoA, so it relocated unchanged.
 */

/// <reference lib="webworker" />

import { parseBatch } from '../protocol/parseBatch';
import { RawFrameRing } from '../state/ringBuffer';
import { createMessageModel } from '../protocol/messageModel';
import { decodeSignal } from '../protocol/decode';
import { evalFormula } from '../protocol/formula';
import type { EditableSignal, FrameDef } from '../protocol/datamodel';
import { decodeDiagnostic, decodeDiagnosticReassembled, type DiagDecodeReassembled } from '@shared/diagnostic.ts';
import { runExperimentDetailed, type ExperimentWindow } from '../hunt/hunt';
import { analyzeRun } from '@shared/analysis/logbook.ts';
import { analyzeFieldRun } from '@shared/analysis/field-run.ts';
import { findSynonyms, type FieldLocator } from '@shared/analysis/synonyms.ts';
import { scanBitActivityPacked } from '../hunt/bitActivity';
import { scanByteHistogramPacked } from '../hunt/byteHistogram';
import { scanSignalDiscoveryPacked } from '../hunt/signalDiscovery';
import { scanCoOccurrencePacked } from '../hunt/coOccurrence';
import { scanSignalCorrelationPacked } from '../hunt/signalCorrelation';
import { setCoOccurrenceTallyKernel } from '@shared/analysis/co-occurrence.ts';
import { loadCoocKernel } from './wasm/coocKernel';
import { isExtended as packedIsExtended, type PackedFrames } from '@shared/analysis/packed.ts';
import type { ClusterTarget, FromAnalysisMsg, HuntResult, HuntScanReq, HuntWindow, ToAnalysisMsg } from './analysisApi';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Same capacity the main thread used (DESIGN: ~1e6 frames ≈ 8 min @ 2 kfps).
const RING_CAPACITY = 1_000_000;
const ring = new RawFrameRing(RING_CAPACITY);

// The incremental per-message model for the master-detail detail pane. One
// instance, re-pointed by `select`; it rebuilds internally on selection/def/ring
// changes and folds deltas otherwise.
const model = createMessageModel();

// WASM co-occurrence accelerator (DESIGN §6.1.4 step 4 / §6.1.5). Loaded once at
// startup and injected behind the pure-JS packed seam; fire-and-forget so scans
// before it resolves — and the SIMD-less browser floor or any load failure —
// transparently use the JS fallback (WASM-ready, not WASM-dependent).
void loadCoocKernel()
  .then((loaded) => {
    if (loaded) {
      setCoOccurrenceTallyKernel(loaded.kernel);
      console.info(`[analysis] co-occurrence WASM kernel active: ${loaded.tier}`);
    }
  })
  .catch(() => {
    /* keep the pure-JS default */
  });

let sel: { id: number; isExtended: boolean } | null = null;
let selDef: FrameDef | undefined;
let windowSeconds = 10;

// CLUSTER dashboard watched set (the decoded-signals dashboard, DESIGN §6.1.2).
// Empty ⇒ not in Cluster mode → no series traced. Re-pointed by `clusterWatch`.
let clusterTargets: ClusterTarget[] = [];
let clusterWindowS = 10;
// Cap on traced points per series (a pathologically noisy signal); same bound
// and stride-decimation as the Logbook detail trace.
const CLUSTER_POINT_CAP = 800;

// Post cadence (matches the parser worker's snapshot interval).
const TICK_MS = 100;
// The Inspector's history / sparkline / reassembly look back this far (fixed —
// independent of the message-list rate window). Mirrors the old Inspector.
const INSPECTOR_WINDOW_S = 10;
// Max distinct payload rows the Inspector history shows (newest first).
const HISTORY_MAX = 40;

/** "now" for the rate window = the newest backend µs the ring holds. */
function nowTUs(): number {
  return ring.stats().newestTUs ?? 0;
}

/** Space-separated uppercase hex of a payload (matches the Inspector's format). */
function toHex(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i++) {
    s += data[i].toString(16).toUpperCase().padStart(2, '0');
    if (i < data.length - 1) s += ' ';
  }
  return s;
}

/** Compute + post the message rows for the current selection (if any). */
function postMessages(): void {
  if (!sel) {
    const out: FromAnalysisMsg = { type: 'messages', rows: [] };
    ctx.postMessage(out);
    return;
  }
  const rows = model.sync(ring, sel, selDef, windowSeconds, nowTUs());
  const out: FromAnalysisMsg = { type: 'messages', rows };
  ctx.postMessage(out);
}

/**
 * Compute + post the Inspector derivations for the selection over its recent
 * window: the unified `eff` (from the model — same detection the rows use), the
 * multi-frame diagnostic reassembly, the distinct-payload history, and the
 * first-signal sparkline. Raw backend µs are posted; the main thread maps to
 * relative seconds via its SessionClock. Call AFTER postMessages so the model's
 * `effective()` reflects the latest sync.
 */
function postInspector(): void {
  if (!sel) {
    const out: FromAnalysisMsg = {
      type: 'inspector', eff: null, diagReassembled: null, history: [], spark: { tUs: [], values: [], label: '' },
    };
    ctx.postMessage(out);
    return;
  }
  const s = sel;
  const frames = ring.lastSeconds(INSPECTOR_WINDOW_S, s.id).filter((f) => f.isExtended === s.isExtended);

  // Unified detection: the same EffectiveMessageId the message rows are split by.
  const eff = model.effective();

  // Multi-frame diagnostic reassembly — only when the newest frame is a First /
  // Consecutive ISO-TP frame (mirrors the Inspector's gate).
  let diagReassembled: DiagDecodeReassembled | null = null;
  if (frames.length > 0) {
    const latest = frames[frames.length - 1];
    const d = decodeDiagnostic(s.id, s.isExtended, Array.from(latest.data));
    if (d && (d.isotp.kind === 'first' || d.isotp.kind === 'consecutive')) {
      diagReassembled = decodeDiagnosticReassembled(s.id, s.isExtended, frames.map((f) => Array.from(f.data)));
    }
  }

  // Distinct payloads, newest first.
  const history: { tUs: number; hex: string }[] = [];
  let prevHex = '';
  for (let i = frames.length - 1; i >= 0 && history.length < HISTORY_MAX; i--) {
    const f = frames[i];
    const h = toHex(f.data);
    if (h === prevHex) continue;
    prevHex = h;
    history.push({ tUs: f.tUs, hex: h });
  }

  // Sparkline: the first signal's decoded value (or byte 0) over the window.
  const sig: EditableSignal | null =
    selDef && selDef.signals.length > 0 ? (selDef.signals[0] as EditableSignal) : null;
  const tUs: number[] = [];
  const values: number[] = [];
  for (const f of frames) {
    tUs.push(f.tUs);
    if (sig) values.push(decodeSignal(f.data, sig).value);
    else values.push(f.data.length > 0 ? f.data[0] : 0);
  }
  const label = sig ? sig.name : 'byte 0';

  const out: FromAnalysisMsg = { type: 'inspector', eff, diagReassembled, history, spark: { tUs, values, label } };
  ctx.postMessage(out);
}

function postStats(): void {
  const out: FromAnalysisMsg = { type: 'ringStats', stats: ring.stats() };
  ctx.postMessage(out);
}

/**
 * Compute + post the CLUSTER dashboard's traced series for the watched set over
 * its recent window. Each target's value-over-time is decoded from the ring
 * (signal geometry or "Custom" formula), changepoint-compressed into a step
 * series, then stride-decimated to a cap (mirrors the Logbook detail trace).
 * No-op when no target is registered (i.e. not in Cluster mode), so the tick
 * stays cheap everywhere else.
 */
function postClusterSeries(): void {
  if (clusterTargets.length === 0) return;
  const series: { key: string; tUs: number[]; values: number[] }[] = [];
  for (const t of clusterTargets) {
    // Zero-copy views: decoded synchronously here, never retained past this pass.
    const frames = ring.lastSecondsView(clusterWindowS, t.id).filter((f) => f.isExtended === t.isExtended);
    const tUsAll: number[] = [];
    const valsAll: number[] = [];
    let last = NaN;
    for (const f of frames) {
      let v: number;
      if (t.kind === 'signal') {
        v = decodeSignal(f.data, t.sig).value;
      } else {
        const r = evalFormula(t.expr, f.data, t.unit);
        v = typeof r.value === 'number' ? r.value : r.value === true ? 1 : r.value === false ? 0 : NaN;
      }
      if (!Number.isFinite(v)) continue;
      if (v !== last || tUsAll.length === 0) { tUsAll.push(f.tUs); valsAll.push(v); last = v; }
    }
    let tUs = tUsAll;
    let values = valsAll;
    if (tUsAll.length > CLUSTER_POINT_CAP) {
      const step = Math.ceil(tUsAll.length / CLUSTER_POINT_CAP);
      tUs = [];
      values = [];
      for (let i = 0; i < tUsAll.length; i += step) { tUs.push(tUsAll[i]); values.push(valsAll[i]); }
    }
    series.push({ key: t.key, tUs, values });
  }
  ctx.postMessage({ type: 'clusterSeries', series } satisfies FromAnalysisMsg);
}

/**
 * Materialize a Hunt window as columnar {@link PackedFrames} for the synchronous
 * passive scans (DESIGN §6.1.4 step 3b): one bulk allocation, no per-frame FrameView
 * objects or `Array.from` payload copies. Safe because the scans consume it
 * synchronously and discard it.
 */
function huntWindowPacked(w: HuntWindow, id?: number): PackedFrames {
  return w.mode === 'recent' ? ring.lastSecondsPacked(w.seconds, id) : ring.windowPacked(0, nowTUs(), id);
}

/** Run an on-demand Hunt computation over the ring (DESIGN §6.1.2). */
function runHuntScan(req: HuntScanReq): HuntResult {
  if (req.kind === 'experiment') {
    // synchronous scan, not retained → zero-copy view (DESIGN §6.1.4 step 3a)
    const frames = ring.windowView(req.startTUs, req.endTUs);
    const win: ExperimentWindow = {
      frames,
      startTUs: req.startTUs,
      endTUs: req.endTUs,
      marks: req.marks,
      candidateIds: req.candidateIds,
    };
    const detailed = runExperimentDetailed(win);
    // The compare-sort + top-N slice are presentation choices kept on the main
    // thread; return the full ranked set + frame count.
    return { kind: 'experiment', candidates: detailed.candidates, info: detailed.info, frameCount: frames.length };
  }
  if (req.kind === 'logbook') {
    // Span = the run's overall window; analyzeRun slices the role-tagged sub-windows.
    let start = Infinity;
    let end = -Infinity;
    for (const w of req.run.windows) {
      if (w.startTUs < start) start = w.startTUs;
      if (w.endTUs > end) end = w.endTUs;
    }
    // synchronous scan, not retained → zero-copy view (DESIGN §6.1.4 step 3a);
    // payloads are copied out via Array.from below before any later push.
    const fv = start <= end ? ring.windowView(start, end) : [];
    const frames = fv.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
    const isExtended: Record<number, boolean> = {};
    for (const f of fv) if (isExtended[f.id] === undefined) isExtended[f.id] = f.isExtended;
    return { kind: 'logbook', result: analyzeRun(req.run, frames, { excluded: req.excluded }), isExtended };
  }
  if (req.kind === 'fieldRun') {
    // synchronous scan, not retained → zero-copy view (DESIGN §6.1.4 step 3a);
    // payloads are copied out via Array.from below before any later push.
    const fv = req.startTUs <= req.endTUs ? ring.windowView(req.startTUs, req.endTUs) : [];
    const frames = fv.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
    const isExtended: Record<number, boolean> = {};
    for (const f of fv) if (isExtended[f.id] === undefined) isExtended[f.id] = f.isExtended;
    return { kind: 'fieldRun', result: analyzeFieldRun(req.input, frames, { excluded: req.excluded }), isExtended };
  }
  if (req.kind === 'logbookDetail') {
    // synchronous scan, not retained → zero-copy view (DESIGN §6.1.4 step 3a)
    const fv = ring.windowView(req.startTUs, req.endTUs);
    const t = req.target;
    // The target's value at each of its frames, changepoint-compressed into a step
    // series (a flag/level is tiny; a noisy byte is capped by stride below).
    const tUsAll: number[] = [];
    const valsAll: number[] = [];
    let last = NaN;
    let min = Infinity;
    let max = -Infinity;
    for (const f of fv) {
      if (f.id !== t.frameId || t.byteIndex >= f.data.length) continue;
      const v = t.bit === undefined ? f.data[t.byteIndex] : (f.data[t.byteIndex] >> t.bit) & 1;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v !== last || tUsAll.length === 0) { tUsAll.push(f.tUs); valsAll.push(v); last = v; }
    }
    // Cap output points (a pathologically noisy byte) by uniform stride.
    const CAP = 800;
    let tUs = tUsAll;
    let values = valsAll;
    if (tUsAll.length > CAP) {
      const step = Math.ceil(tUsAll.length / CAP);
      tUs = [];
      values = [];
      for (let i = 0; i < tUsAll.length; i += step) { tUs.push(tUsAll[i]); values.push(valsAll[i]); }
    }
    // Behavioral synonyms: the target's series vs the other loci over the same window.
    const frames = fv.map((f) => ({ id: f.id, tUs: f.tUs, data: Array.from(f.data) }));
    const target: FieldLocator = { id: t.frameId, byteIndex: t.byteIndex, bit: t.bit };
    const cands: FieldLocator[] = req.others.map((o) => ({ id: o.frameId, byteIndex: o.byteIndex, bit: o.bit, name: o.name }));
    const synonyms = findSynonyms(frames, target, cands).map((m) => ({
      frameId: m.field.id,
      byteIndex: m.field.byteIndex,
      bit: m.field.bit,
      name: m.field.name,
      correlation: m.correlation,
    }));
    return {
      kind: 'logbookDetail',
      trace: { tUs, values },
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 1,
      synonyms,
    };
  }
  if (req.kind === 'correlation') {
    // synchronous scan, not retained → columnar packed window (DESIGN §6.1.4 step 3b)
    const packed = huntWindowPacked(req.window);
    return { kind: 'correlation', corr: scanSignalCorrelationPacked(packed, req.reference, req.allow) };
  }
  // scanAll: the five passive analyzers over one window + an id→isExtended map.
  // synchronous scan, not retained → columnar packed window (DESIGN §6.1.4 step 3b)
  const packed = huntWindowPacked(req.window);
  const scan = scanBitActivityPacked(packed, req.allow);
  const hist = scanByteHistogramPacked(packed, req.allow);
  const sweep = scanSignalDiscoveryPacked(packed, req.sweepAllow);
  const cooc = scanCoOccurrencePacked(packed, req.allow);
  const corr = req.corrReference ? scanSignalCorrelationPacked(packed, req.corrReference, req.allow) : null;
  const isExtended: Record<number, boolean> = {};
  for (let i = 0; i < packed.count; i++) {
    const id = packed.id[i];
    if (isExtended[id] === undefined) isExtended[id] = packedIsExtended(packed, i);
  }
  return { kind: 'scanAll', scan, hist, sweep, cooc, corr, isExtended };
}

// Throttled tick: refresh stats always, message rows + Inspector derivations
// while a frame is selected. model.sync is incremental (O(new frames)); the
// Inspector derivations are over a bounded ~10 s window.
setInterval(() => {
  postStats();
  if (sel) {
    postMessages();
    postInspector();
  }
  postClusterSeries();
}, TICK_MS);

ctx.onmessage = (ev: MessageEvent<ToAnalysisMsg>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'ingest': {
      try {
        const { frames } = parseBatch(msg.buffer);
        ring.pushMany(frames);
      } catch (err) {
        const out: FromAnalysisMsg = {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        ctx.postMessage(out);
      }
      break;
    }
    case 'select': {
      sel = msg.sel;
      selDef = msg.def;
      windowSeconds = msg.windowSeconds;
      // Compute immediately so a click feels responsive (don't wait for the tick).
      postMessages();
      postInspector(); // after postMessages → model.effective() is fresh
      break;
    }
    case 'clusterWatch': {
      clusterTargets = msg.targets;
      clusterWindowS = msg.windowSeconds;
      // Compute immediately so entering Cluster mode feels responsive.
      postClusterSeries();
      break;
    }
    case 'huntScan': {
      try {
        const result = runHuntScan(msg.req);
        ctx.postMessage({ type: 'huntResult', reqId: msg.reqId, result } satisfies FromAnalysisMsg);
      } catch (err) {
        ctx.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies FromAnalysisMsg);
      }
      break;
    }
    case 'reset': {
      ring.clear(); // bumps the ring generation → the model rebuilds on next sync
      sel = null;
      selDef = undefined;
      postStats();
      postMessages(); // posts [] → clears the detail pane
      postInspector(); // posts cleared Inspector derivations
      postClusterSeries(); // re-trace (empty ring → empty series) if watching
      break;
    }
  }
};
