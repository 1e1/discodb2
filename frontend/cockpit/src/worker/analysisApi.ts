/**
 * Typed message contract between the main thread and the dedicated ANALYSIS
 * worker (DESIGN §6.1.2).
 *
 * Unlike `parser.worker` (which is bounded by the id count: parse + per-id
 * aggregate → the live frame table), the analysis worker OWNS the raw analysis
 * RING (history-bound) and is where the heavy, history-deep work runs — today
 * just the ring + its stats; subsequently the Message-ID detection, the
 * per-message model, and the Hunt scans (migrated step by step, DESIGN §6.1.2).
 *
 * Keeping it a SEPARATE worker from the parser insulates the must-stay-live
 * frame-table cadence from an occasionally-heavy analysis pass: a big Hunt scan
 * delays results here, never the live table.
 *
 * The main thread is a thin async consumer: it fans the raw batch buffer to this
 * worker and binds the posted results into stores.
 */

import type { RingStats } from '../state/ringBuffer';
import type { EditableSignal, FrameDef } from '../protocol/datamodel';
import type { EffectiveMessageId, MessageRow } from '../protocol/messages';
import type { DiagDecodeReassembled } from '@shared/diagnostic.ts';
import type { RankedCandidate, ExperimentRunInfo, ExperimentWindow } from '../hunt/hunt';
import type { LogbookRun, LogbookResult } from '@shared/analysis/logbook.ts';
import type { FieldRunInput, FieldRunResult } from '@shared/analysis/field-run.ts';
import type { ScanResult } from '../hunt/bitActivity';
import type { ByteHistogramScanResult } from '../hunt/byteHistogram';
import type { SignalDiscoveryScanResult } from '../hunt/signalDiscovery';
import type { CoOccurrenceScanResult } from '../hunt/coOccurrence';
import type { SignalCorrelationScanResult } from '../hunt/signalCorrelation';

/** Which ring window a Hunt scan runs over (mirrors HuntPanel's window control). */
export type HuntWindow = { mode: 'recent'; seconds: number } | { mode: 'all' };

// ── main → analysis.worker ────────────────────────────────────────────────────

/** Feed one raw binary batch (the ArrayBuffer is transferred, zero-copy). */
export interface AnalysisIngestMsg {
  type: 'ingest';
  buffer: ArrayBuffer;
}

/** Clear the worker-owned ring (reconnect / new session). */
export interface AnalysisResetMsg {
  type: 'reset';
}

/**
 * Drive the worker-side per-message model: which frame is selected, its FrameDef
 * (mux signal / Auto flag → how to split), and the rate window. Posted whenever
 * any of the three changes (deduped on the main thread). `sel: null` clears the
 * detail pane. The worker owns the `MessageModel` and recomputes its rows on its
 * own cadence, posting {@link MessagesMsg}.
 */
export interface AnalysisSelectMsg {
  type: 'select';
  sel: { id: number; isExtended: boolean } | null;
  def: FrameDef | undefined;
  windowSeconds: number;
}

/**
 * An ON-DEMAND Hunt computation, run over the worker-owned ring (DESIGN §6.1.2).
 * Correlated to its result by `reqId`. Three shapes:
 *   - `experiment` — a guided run over an explicit µs window + marks → ranked
 *     candidates (`runExperimentDetailed`);
 *   - `scanAll` — the five passive analyzers over one window (the Scan view);
 *   - `correlation` — re-run only the correlation analyzer for a new reference.
 */
export type HuntScanReq =
  | {
      kind: 'experiment';
      startTUs: number;
      endTUs: number;
      marks: ExperimentWindow['marks'];
      candidateIds?: number[];
    }
  | {
      kind: 'scanAll';
      window: HuntWindow;
      allow?: number[];
      sweepAllow?: number[];
      corrReference: EditableSignal | null;
    }
  | { kind: 'correlation'; window: HuntWindow; allow?: number[]; reference: EditableSignal }
  | {
      // LOGBOOK supervised analysis: the run's stamped windows + known-signal
      // exclusions → the HARDENED `analyzeRun` (positive evidence + negative
      // control + response-type + significance) over the worker-owned ring.
      kind: 'logbook';
      run: LogbookRun;
      excluded: string[];
    }
  | {
      // MARKHUNT field-run analysis: the typed, painted spans → `analyzeFieldRun`
      // (per-question dispatch + ≈ equivalence + stable-window control) over the
      // worker-owned ring. The whole run's [startTUs,endTUs] bounds the frames.
      kind: 'fieldRun';
      input: FieldRunInput;
      startTUs: number;
      endTUs: number;
      excluded: string[];
    }
  | {
      // LOGBOOK candidate detail (REPLAY + behavioral synonyms): the target's value
      // trace over the run span (for overlaying on the stimulus timeline) plus the
      // behavioral synonyms (`findSynonyms`) of the target vs the `others` loci.
      kind: 'logbookDetail';
      target: { frameId: number; byteIndex: number; bit?: number };
      others: { frameId: number; byteIndex: number; bit?: number; name?: string }[];
      startTUs: number;
      endTUs: number;
    };

export interface HuntScanMsg {
  type: 'huntScan';
  reqId: number;
  req: HuntScanReq;
}

/**
 * One CLUSTER dashboard value to trace over the recent window (DESIGN §6.1.2):
 * a project signal (decoded by its geometry) or a frame's "Custom" formula
 * (evaluated over the bytes). `key` matches the main-thread `ClusterCard.key`,
 * so the posted {@link ClusterSeriesMsg} series map back to their cards.
 */
export type ClusterTarget =
  | { key: string; id: number; isExtended: boolean; kind: 'signal'; sig: EditableSignal }
  | { key: string; id: number; isExtended: boolean; kind: 'formula'; expr: string; unit?: string };

/**
 * Register the CLUSTER dashboard's watched set + its window. The worker traces
 * each target over the recent `windowSeconds` from its ring on its own cadence,
 * posting {@link ClusterSeriesMsg}. An empty `targets` (e.g. leaving Cluster
 * mode) stops the tracing. Re-posted only when the SET / window changes (the
 * main thread dedupes), not per value tick.
 */
export interface AnalysisClusterWatchMsg {
  type: 'clusterWatch';
  targets: ClusterTarget[];
  windowSeconds: number;
}

export type ToAnalysisMsg =
  | AnalysisIngestMsg
  | AnalysisResetMsg
  | AnalysisSelectMsg
  | HuntScanMsg
  | AnalysisClusterWatchMsg;

// ── analysis.worker → main ──────────────────────────────────────────────────--

/** The worker-owned ring's stats, posted on a throttled cadence. */
export interface RingStatsMsg {
  type: 'ringStats';
  stats: RingStats;
}

/**
 * The current per-message rows for the selected frame (the master-detail DETAIL
 * pane), posted on the worker's cadence while a selection is active. Rows are
 * structured-clone-friendly (plain objects + Uint8Array payloads).
 */
export interface MessagesMsg {
  type: 'messages';
  rows: MessageRow[];
}

/**
 * The selected frame's INSPECTOR derivations, computed over its recent (~10 s)
 * window in the worker (DESIGN §6.1.2). `eff` is the SAME detection the message
 * rows are split by (unified — no separate Inspector resolver). `history` and
 * `spark` carry RAW backend µs; the main thread maps those to relative seconds
 * via its SessionClock (the clock's session origin stays main-thread).
 */
export interface InspectorMsg {
  type: 'inspector';
  eff: EffectiveMessageId | null;
  diagReassembled: DiagDecodeReassembled | null;
  history: { tUs: number; hex: string }[];
  spark: { tUs: number[]; values: number[]; label: string };
}

/**
 * The result of a {@link HuntScanReq}, correlated by `reqId`. `scanAll` also
 * carries an id→isExtended map built over the same window, so the main thread's
 * `scanIsExtended(id)` lookup (the heatmap's `isExtendedFor` prop) stays a
 * synchronous map read with no ring on the main thread.
 */
export type HuntResult =
  | { kind: 'experiment'; candidates: RankedCandidate[]; info: ExperimentRunInfo; frameCount: number }
  | {
      kind: 'scanAll';
      scan: ScanResult;
      hist: ByteHistogramScanResult;
      sweep: SignalDiscoveryScanResult;
      cooc: CoOccurrenceScanResult;
      corr: SignalCorrelationScanResult | null;
      isExtended: Record<number, boolean>;
    }
  | { kind: 'correlation'; corr: SignalCorrelationScanResult | null }
  | {
      // The hardened Logbook result + an id→isExtended map (built over the same
      // window) so the main thread renders/locates candidates with no ring read.
      kind: 'logbook';
      result: LogbookResult;
      isExtended: Record<number, boolean>;
    }
  | {
      // The Markhunt field-run result + an id→isExtended map (built over the same
      // window) so the main thread locates candidates with no ring read.
      kind: 'fieldRun';
      result: FieldRunResult;
      isExtended: Record<number, boolean>;
    }
  | {
      // A candidate's replay trace (changepoint-compressed step series over the run
      // span) + its behavioral synonyms.
      kind: 'logbookDetail';
      trace: { tUs: number[]; values: number[] };
      min: number;
      max: number;
      synonyms: { frameId: number; byteIndex: number; bit?: number; name?: string; correlation: number }[];
    };

export interface HuntResultMsg {
  type: 'huntResult';
  reqId: number;
  result: HuntResult;
}

/**
 * The CLUSTER dashboard's traced series, posted on the worker cadence while a
 * non-empty watched set is registered (see {@link AnalysisClusterWatchMsg}).
 * Each entry is a changepoint-compressed step series (capped points) carrying
 * RAW backend µs; the panel maps those to relative seconds for its sparkline.
 * Keyed by `ClusterCard.key`; absent keys simply have no data in the window.
 */
export interface ClusterSeriesMsg {
  type: 'clusterSeries';
  series: { key: string; tUs: number[]; values: number[] }[];
}

/** A non-fatal error surfaced for diagnostics. */
export interface AnalysisErrorMsg {
  type: 'error';
  message: string;
}

export type FromAnalysisMsg =
  | RingStatsMsg
  | MessagesMsg
  | InspectorMsg
  | HuntResultMsg
  | ClusterSeriesMsg
  | AnalysisErrorMsg;
