/**
 * Application state — the glue between the protocol client, the two workers
 * (parser + analysis), the session clock, and the §3.5 project model.
 *
 * Uses Svelte stores so components stay dumb. The hot path (binary batches) does
 * NOT flow through Svelte reactivity per-frame and is NOT parsed on the main
 * thread: each batch is fanned (transferred) to both workers, which post back
 * throttled results — `frameRows` (parser) and `messages`/`inspectorData`/
 * `ringStats` (analysis). The main thread owns no ring (DESIGN §6.1.2).
 */

import { derived, get, writable, type Readable, type Writable } from 'svelte/store';

import { ProtocolClient, type ConnectionState } from '../protocol/client';
import type { HealthStatus, LogbookCmdMsg, TrialFeedbackMsg } from '../protocol/types';
import { SessionClock } from '../protocol/sessionClock';
import {
  canonicalView,
  emptyFilter,
  emptyProject,
  ensureViews,
  ensureLogbook,
  frameKey,
  makeScenario,
  makeSignal,
  messageKey,
  newId,
  type EditableSignal,
  type FormulaDef,
  type FrameDef,
  type FrameFilter,
  type FrameView,
  type LogbookFinding,
  type LogbookScenario,
  type Project,
} from '../protocol/datamodel';
import { decodeSignal, formatValue } from '../protocol/decode';
import { evalFormula } from '../protocol/formula';
import type { FromWorkerMsg, FrameRow, ToWorkerMsg } from '../worker/workerApi';
import ParserWorker from '../worker/parser.worker?worker';
import type { ClusterTarget, FromAnalysisMsg, ToAnalysisMsg, HuntScanReq, HuntResult } from '../worker/analysisApi';
import AnalysisWorker from '../worker/analysis.worker?worker';
import type { EffectiveMessageId, MessageRow } from '../protocol/messages';
import type { DiagDecodeReassembled } from '@shared/diagnostic.ts';

// The filter model (FrameFilter / emptyFilter) now lives in datamodel.ts beside
// the view/project model it belongs to. Re-export so existing importers (the
// FilterBar) keep importing it from the store.
export { emptyFilter, type FrameFilter };

// ── stores ─────────────────────────────────────────────────────────────────

export const connectionState: Writable<ConnectionState> = writable('idle');
export const connectionDetail: Writable<string> = writable('');
export const wsUrl: Writable<string> = writable(defaultWsUrl());
export const health: Writable<HealthStatus | null> = writable(null);
export const serverFiles: Writable<string[]> = writable([]);
export const lastError: Writable<string> = writable('');

export const frameRows: Writable<FrameRow[]> = writable([]);
/**
 * The per-message rows for the selected frame (master-detail DETAIL pane),
 * computed in the analysis worker and posted on its cadence. MessageList binds
 * this instead of recomputing from the ring on the main thread (DESIGN §6.1.2).
 */
export const messages: Writable<MessageRow[]> = writable([]);

/**
 * The selected frame's Inspector derivations, computed in the analysis worker
 * over its recent (~10 s) window (DESIGN §6.1.2): the unified effective
 * Message-ID, multi-frame diagnostic reassembly, distinct-payload history, and
 * the first-signal sparkline. `history`/`spark` carry RAW backend µs — the
 * Inspector maps them to relative seconds via the SessionClock. Null = no
 * selection.
 */
export interface InspectorData {
  eff: EffectiveMessageId | null;
  diagReassembled: DiagDecodeReassembled | null;
  history: { tUs: number; hex: string }[];
  spark: { tUs: number[]; values: number[]; label: string };
}
export const inspectorData: Writable<InspectorData | null> = writable(null);
export const busFps: Writable<number> = writable(0);
export const totalFrames: Writable<number> = writable(0);
export const maxTUs: Writable<number> = writable(0);
export const isReplay: Writable<boolean> = writable(false);

export const project: Writable<Project> = writable(emptyProject('sharan'));

/** Currently inspected id (and extended flag), or null. The PRIMARY selection. */
export const selected: Writable<{ id: number; isExtended: boolean } | null> =
  writable(null);

/**
 * Multi-selection: the set of frame keys highlighted in the table (Ctrl/⌘-click,
 * Shift-range, Ctrl/⌘-A). Drag onto a tab moves this whole set when the dragged
 * row is part of it. `selected` is the primary (last-clicked) row for the
 * Inspector; `selection` is the bulk set for tagging/drag.
 */
export const selection: Writable<Set<string>> = writable(new Set());

/**
 * The selected SUB-MESSAGE within the primary frame (master-detail Message
 * list). When a frame has a multiplexor, this is the chosen mux VALUE; `null`
 * means either the non-mux single message OR "no sub-message selected" (the
 * frame itself). Ephemeral UI state — NOT persisted. Selecting a DIFFERENT
 * frame resets it to `null` (wired below).
 */
export const selectedMux: Writable<number | null> = writable(null);

// Reset the selected sub-message whenever the PRIMARY frame changes, so a stale
// mux value never leaks across frames. Tracks the last frame key seen.
let _lastSelKey: string | null = null;
selected.subscribe((s) => {
  const key = s ? frameKey(s.id, s.isExtended) : null;
  if (key !== _lastSelKey) {
    _lastSelKey = key;
    selectedMux.set(null);
  }
});

/**
 * History window (seconds) for the master-detail MESSAGE list — how far back the
 * detail pane looks when grouping a frame into its messages. Ephemeral UI state,
 * NOT persisted. `0` = "All" (everything still in the ring buffer for that id).
 * Default 10 s.
 */
export const messageWindowSeconds: Writable<number> = writable(10);

/**
 * EPHEMERAL filter for the master-detail MESSAGE list — a single GLOBAL lens over
 * the selected frame's split sub-messages (NOT persisted, NOT per-tab). Reuses
 * the `FrameFilter` shape: `idMin/idMax` test the message-ID (mux) value,
 * `byteIndex/byteMask/byteValue` the payload, `minRate/maxRate` the per-message
 * rate, `nameSubstr` the custom message name. `hideErrors` is unused here.
 */
export const messageFilter: Writable<FrameFilter> = writable(emptyFilter());

// ── views (the "frame list" tabs) ────────────────────────────────────────────
// Views live INSIDE the project (project.views) so they serialize with
// export/import. `activeViewId` is ephemeral UI state (which tab is open) and is
// NOT persisted.

/** Id of the currently-open view tab. Defaults to the canonical view. */
export const activeViewId: Writable<string> = writable(canonicalView().id);

// ── top-level workspace mode ─────────────────────────────────────────────────
/**
 * Workspace MODE by scope: 'explore' (frame table + the per-frame / per-tab
 * right pane), 'hunt' (the GLOBAL detection Wizard, full-width), 'logbook'
 * (the carnet de chasse — scripted stimulus-response experiments, full-width),
 * or 'cluster' (the decoded-signals dashboard / instrument cluster, full-width:
 * one card per decoded signal / Custom formula — Name + live value + sparkline).
 * Ephemeral UI state, NOT persisted. It lives here (not local to App) so the
 * switch can sit in the ProjectBar while App reacts to it.
 */
export const uiMode: Writable<'explore' | 'hunt' | 'logbook' | 'cluster'> = writable('explore');

/** Lookback window (seconds) for the Cluster dashboard sparklines. Ephemeral. */
export const clusterWindowSeconds: Writable<number> = writable(10);

/**
 * The Cluster sparkline series, keyed by `ClusterCard.key`, traced in the
 * analysis worker over `clusterWindowSeconds` and posted on its cadence while
 * Cluster mode is active. Raw backend µs + values; the panel maps µs to relative
 * seconds for the chart. Empty between sessions / when not watching.
 */
export const clusterSeries: Writable<Map<string, { tUs: number[]; values: number[] }>> =
  writable(new Map());

// ── Logbook scenario state + CRUD ────────────────────────────────────────────
/** The scenario currently open in the Logbook editor (id), or null. Ephemeral. */
export const selectedScenarioId: Writable<string | null> = writable(null);

/** Append a scenario to the project and select it. */
export function addScenario(s: LogbookScenario): void {
  project.update((p) => ({ ...p, scenarios: [...(p.scenarios ?? []), s] }));
  selectedScenarioId.set(s.id);
}

/** Create a fresh scenario from the standard skeleton and select it. */
export function newScenario(objective = 'New objective…'): void {
  addScenario(makeScenario(objective));
}

/** Delete a scenario; keep the selection valid. */
export function deleteScenario(id: string): void {
  project.update((p) => ({ ...p, scenarios: (p.scenarios ?? []).filter((s) => s.id !== id) }));
  if (get(selectedScenarioId) === id) selectedScenarioId.set(null);
}

/**
 * Edit a scenario in place via a mutator. We clone the scenario, let `fn` mutate
 * the clone (the editor's nested edits read naturally), then swap it in
 * immutably so Svelte stores react. Other scenarios are untouched.
 */
export function mutateScenario(id: string, fn: (s: LogbookScenario) => void): void {
  project.update((p) => ({
    ...p,
    scenarios: (p.scenarios ?? []).map((s) => {
      if (s.id !== id) return s;
      const clone = structuredClone(s);
      fn(clone);
      return clone;
    }),
  }));
}

/** Move a scenario to a new index (manual library ordering). */
export function reorderScenario(fromId: string, toIndex: number): void {
  project.update((p) => {
    const list = [...(p.scenarios ?? [])];
    const from = list.findIndex((s) => s.id === fromId);
    if (from < 0) return p;
    const [m] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, m);
    return { ...p, scenarios: list };
  });
}

// ── Logbook findings (the cross-session knowledge base) ──────────────────────
/** Promote a finding into the project (a run result the operator confirmed). */
export function addFinding(f: LogbookFinding): void {
  project.update((p) => ({ ...p, findings: [...(p.findings ?? []), f] }));
}

/** Edit a finding in place (status / exclude / rename) via a mutator + immutable swap. */
export function mutateFinding(id: string, fn: (f: LogbookFinding) => void): void {
  project.update((p) => ({
    ...p,
    findings: (p.findings ?? []).map((f) => {
      if (f.id !== id) return f;
      const clone = structuredClone(f);
      fn(clone);
      return clone;
    }),
  }));
}

/** Delete a finding from the knowledge base. */
export function deleteFinding(id: string): void {
  project.update((p) => ({ ...p, findings: (p.findings ?? []).filter((f) => f.id !== id) }));
}

/** All confirmed findings' "id:byteIndex" slots — excluded from new hunts/analyses. */
export function excludedSlots(p: Project): string[] {
  return (p.findings ?? [])
    .filter((f) => f.excludeFromHunt)
    .map((f) => `${f.frameId}:${f.byteIndex}`);
}

/** All views of the current project (canonical first), reactive. */
export const views: Readable<FrameView[]> = derived(project, ($p) => $p.views ?? []);

/** The currently-open view (falls back to the first view, then a fresh one). */
export const activeView: Readable<FrameView> = derived(
  [project, activeViewId],
  ([$p, $id]) => {
    const vs = $p.views ?? [];
    return vs.find((v) => v.id === $id) ?? vs[0] ?? canonicalView();
  },
);

/** Just the active view's filter (the read side of the `filter` proxy). */
const activeViewFilter: Readable<FrameFilter> = derived(activeView, ($v) => $v.filter);

/**
 * The FILTER store — a proxy over the ACTIVE view's filter. Reads emit the open
 * tab's filter; writes mutate that tab's filter inside the project. This keeps
 * the FilterBar (which imports `filter`) unchanged while making the filter
 * per-tab. Switching tabs re-emits the new tab's filter.
 */
export const filter: Writable<FrameFilter> = {
  subscribe: activeViewFilter.subscribe,
  set: (f: FrameFilter) => mutateActiveFilter(() => f),
  update: (fn: (f: FrameFilter) => FrameFilter) => mutateActiveFilter(fn),
};

function mutateActiveFilter(fn: (f: FrameFilter) => FrameFilter): void {
  const id = get(activeViewId);
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === id);
    if (v) v.filter = fn(v.filter);
    return p;
  });
}

/** Ring buffer stats, refreshed on each snapshot. */
export const ringStats = writable({ capacity: 0, size: 0, oldestTUs: null as number | null, newestTUs: null as number | null });

// ── non-reactive singletons (the heavy machinery) ─────────────────────────────

// The raw analysis ring now lives in the analysis worker (DESIGN §6.1.2); the
// main thread keeps no ring and never parses batches — it only fans the raw
// buffer to the two workers and consumes their posted results/stores.
let sessionClock = new SessionClock();
let worker: Worker | null = null;
// The dedicated analysis worker (DESIGN §6.1.2). During the migration it owns a
// PARALLEL ring fed the same batches; `ringStats` is sourced from it. Subsequent
// sub-steps move detection / message model / Hunt scans here, then the
// main-thread `ring` above is deleted.
let analysisWorker: Worker | null = null;
let client: ProtocolClient | null = null;

export function getSessionClock(): SessionClock {
  return sessionClock;
}

function spawnWorker(): Worker {
  const w = new ParserWorker();
  w.onmessage = (ev: MessageEvent<FromWorkerMsg>) => {
    const msg = ev.data;
    if (msg.type === 'snapshot') {
      frameRows.set(msg.rows);
      busFps.set(msg.busFps);
      totalFrames.set(msg.totalFrames);
      maxTUs.set(msg.maxTUs);
      if (msg.lastBatch) isReplay.set(msg.lastBatch.isReplay);
      sessionClock.observe(msg.maxTUs);
    } else if (msg.type === 'error') {
      lastError.set(msg.message);
    }
  };
  const cfg: ToWorkerMsg = { type: 'config', snapshotIntervalMs: 100 };
  w.postMessage(cfg);
  return w;
}

/**
 * Spawn the dedicated ANALYSIS worker (DESIGN §6.1.2). It owns the analysis ring;
 * `ringStats` is now sourced from it (the old `ring.stats()` read on the parser
 * snapshot is gone). Detection / message model / Hunt scans migrate here next.
 */
function spawnAnalysisWorker(): Worker {
  const w = new AnalysisWorker();
  w.onmessage = (ev: MessageEvent<FromAnalysisMsg>) => {
    const msg = ev.data;
    if (msg.type === 'ringStats') {
      ringStats.set(msg.stats);
    } else if (msg.type === 'messages') {
      messages.set(msg.rows);
    } else if (msg.type === 'inspector') {
      inspectorData.set({
        eff: msg.eff,
        diagReassembled: msg.diagReassembled,
        history: msg.history,
        spark: msg.spark,
      });
    } else if (msg.type === 'huntResult') {
      _huntPending.get(msg.reqId)?.(msg.result);
      _huntPending.delete(msg.reqId);
    } else if (msg.type === 'clusterSeries') {
      const map = new Map<string, { tUs: number[]; values: number[] }>();
      for (const s of msg.series) map.set(s.key, { tUs: s.tUs, values: s.values });
      clusterSeries.set(map);
    } else if (msg.type === 'error') {
      lastError.set(msg.message);
    }
  };
  return w;
}

// ── on-demand Hunt scans (run in the analysis worker, awaited by the panel) ────
let _huntSeq = 0;
const _huntPending = new Map<number, (r: HuntResult) => void>();

/**
 * Run a Hunt computation (guided experiment / passive scans / correlation re-run)
 * in the analysis worker and resolve with its result (DESIGN §6.1.2). The caller
 * narrows the `HuntResult` union by `kind`. Rejects if the worker is not up.
 */
export function huntScan(req: HuntScanReq): Promise<HuntResult> {
  return new Promise((resolve, reject) => {
    if (!analysisWorker) {
      reject(new Error('analysis worker not started'));
      return;
    }
    const reqId = ++_huntSeq;
    _huntPending.set(reqId, resolve);
    analysisWorker.postMessage({ type: 'huntScan', reqId, req } satisfies ToAnalysisMsg);
  });
}

/**
 * Push the message-list selection to the analysis worker whenever the selection,
 * its FrameDef, or the rate window changes. Deduped on a serialized key so an
 * unrelated project edit (another frame's name/signal) does not force a needless
 * re-detect in the worker. The worker replies with `messages` (→ the `messages`
 * store) on its cadence.
 */
let _lastSelectKey = '';
function postSelect(): void {
  if (!analysisWorker) return;
  const sel = get(selected);
  const def = sel ? frameDefFor(sel.id, sel.isExtended) : undefined;
  const windowSeconds = get(messageWindowSeconds);
  const key = JSON.stringify({ sel, def, windowSeconds });
  if (key === _lastSelectKey) return;
  _lastSelectKey = key;
  analysisWorker.postMessage({ type: 'select', sel, def, windowSeconds } satisfies ToAnalysisMsg);
}

// Re-post on any input change. `frameDefFor` reads `project`, so subscribing to
// `project` covers a FrameDef edit on the selected frame (deduped above).
selected.subscribe(postSelect);
messageWindowSeconds.subscribe(postSelect);
project.subscribe(postSelect);

/**
 * Fan a raw batch to BOTH workers — the parser worker (per-id aggregates → the
 * live table) and the analysis worker (the ring + detection + message model +
 * Hunt). The main thread does NOT parse and owns NO ring (DESIGN §6.1.2): each
 * worker gets its own transferred copy so the hot path stays zero-copy per side.
 * The session clock is observed from the parser worker's snapshot `maxTUs`.
 */
function onBatch(buffer: ArrayBuffer): void {
  if (worker) {
    const copy = buffer.slice(0);
    worker.postMessage({ type: 'ingest', buffer: copy } satisfies ToWorkerMsg, [copy]);
  }
  if (analysisWorker) {
    const copy = buffer.slice(0);
    analysisWorker.postMessage({ type: 'ingest', buffer: copy } satisfies ToAnalysisMsg, [copy]);
  }
}

export function getClient(): ProtocolClient {
  if (!client) connect(get(wsUrl));
  // connect() always assigns client; assert for the type system.
  return client as ProtocolClient;
}

// ── Wizard control-channel bridge (host ↔ backend relay) ──────────────────────
// The Wizard host (Hunt panel) registers a trialFeedback sink so a verdict
// relayed from a viewer (copilot) drives the host FSM. Kept module-level (not a
// store) because it is a one-listener command sink, not reactive state.
let trialFeedbackSink: ((m: TrialFeedbackMsg) => void) | null = null;

/** Register the host's trialFeedback handler (returns an unsubscribe). */
export function onTrialFeedback(fn: (m: TrialFeedbackMsg) => void): () => void {
  trialFeedbackSink = fn;
  return () => {
    if (trialFeedbackSink === fn) trialFeedbackSink = null;
  };
}

/** Relay a Wizard state snapshot to viewers (best-effort; §3.3). */
export function sendWizard(payload: Record<string, unknown>): void {
  client?.sendWizard(payload);
}

// The Logbook host (LogbookPanel) registers a command sink so a copilot's
// pick+start / stop / next drives the run controller. One-listener command sink.
let logbookCmdSink: ((m: LogbookCmdMsg) => void) | null = null;

/** Register the host's logbookCmd handler (returns an unsubscribe). */
export function onLogbookCmd(fn: (m: LogbookCmdMsg) => void): () => void {
  logbookCmdSink = fn;
  return () => {
    if (logbookCmdSink === fn) logbookCmdSink = null;
  };
}

/** Relay the Logbook run state to viewers (best-effort; §3.3). */
export function sendLogbook(payload: Record<string, unknown>): void {
  client?.sendLogbook(payload);
}

/** (Re)connect to the backend WS, (re)spawning the worker + clock. */
export function connect(url?: string): void {
  const target = url ?? get(wsUrl);
  wsUrl.set(target);

  // Fresh session: capture the absolute start from the browser clock NOW (§4.2)
  // and reset relative-time origin + both workers' state (aggregates + ring).
  sessionClock = new SessionClock();
  if (!worker) worker = spawnWorker();
  worker.postMessage({ type: 'reset' } satisfies ToWorkerMsg);
  if (!analysisWorker) analysisWorker = spawnAnalysisWorker();
  analysisWorker.postMessage({ type: 'reset' } satisfies ToAnalysisMsg);
  // Re-establish the current selection on the freshly-reset worker (reset cleared
  // its selState); force a re-post past the dedupe guard.
  _lastSelectKey = '';
  postSelect();
  frameRows.set([]);
  messages.set([]);
  inspectorData.set(null);

  client?.disconnect();
  client = new ProtocolClient(
    { url: target, client: 'cockpit' },
    {
      onState: (s, detail) => {
        connectionState.set(s);
        connectionDetail.set(detail ?? '');
      },
      onBatch,
      onStatus: (s) => health.set(s),
      onFiles: (files) => serverFiles.set(files),
      onError: (m) => lastError.set(m),
      onOpen: () => lastError.set(''),
      // A verdict relayed from a viewer (copilot) drives the host's feedback FSM.
      onTrialFeedback: (m) => trialFeedbackSink?.(m),
      // A Logbook command relayed from a viewer drives the host's run controller.
      onLogbookCmd: (m) => logbookCmdSink?.(m),
    },
  );
  client.connect();
}

export function disconnect(): void {
  client?.disconnect();
}

// ── project / signal editing helpers ──────────────────────────────────────────

/** Look up the FrameDef for an id in the current project (or undefined). */
export function frameDefFor(id: number, isExtended: boolean): FrameDef | undefined {
  return get(project).frames.find((f) => f.id === id && f.isExtended === isExtended);
}

/** Rename a frame (creating its FrameDef if absent). */
export function renameFrame(id: number, isExtended: boolean, name: string): void {
  project.update((p) => {
    let def = p.frames.find((f) => f.id === id && f.isExtended === isExtended);
    if (!def) {
      def = { id, isExtended, name, signals: [] };
      p.frames.push(def);
    } else {
      def.name = name;
    }
    return p;
  });
}

export function addSignal(id: number, isExtended: boolean, sig: EditableSignal): void {
  project.update((p) => {
    let def = p.frames.find((f) => f.id === id && f.isExtended === isExtended);
    if (!def) {
      def = { id, isExtended, name: defaultName(id, isExtended), signals: [] };
      p.frames.push(def);
    }
    def.signals.push(sig);
    return p;
  });
}

export function updateSignal(updated: EditableSignal): void {
  project.update((p) => {
    const def = p.frames.find(
      (f) => f.id === updated.frameId && f.isExtended === updated.isExtended,
    );
    if (def) {
      const idx = def.signals.findIndex((s) => s.id === updated.id);
      if (idx >= 0) def.signals[idx] = updated;
    }
    return p;
  });
}

/**
 * Mark exactly one signal of a frame as the MULTIPLEXOR (the sub-message
 * selector), clearing the flag on the frame's other signals; pass null to clear
 * it entirely. At most one multiplexor per frame (B2 · point 2).
 */
export function setMultiplexor(
  frameId: number,
  isExtended: boolean,
  signalId: string | null,
): void {
  project.update((p) => {
    const def = p.frames.find((f) => f.id === frameId && f.isExtended === isExtended);
    if (def) {
      for (const s of def.signals) {
        (s as EditableSignal).isMultiplexor = s.id === signalId;
      }
    }
    return p;
  });
}

/**
 * Set the high-level "Message ID" MODE for a frame (the friendly Inspector
 * control). The three modes are wired onto the SAME low-level state the
 * SignalEditor "multiplexor" checkbox edits, so the two stay consistent:
 *
 *   • 'auto'   → remove any multiplexor signal + clear the None flag
 *                (`messageIdAuto` left undefined ⇒ Auto, the default).
 *   • 'forced' → create (or reuse) a multiplexor signal at byte `byteIndex`
 *                (bitStart = byteIndex*8, bitLength = 8) and mark it the mux, so
 *                it round-trips to DBC. Clears the None flag.
 *   • 'none'   → remove any multiplexor signal + set `messageIdAuto = false`.
 *
 * `byteIndex` is only read for 'forced' (defaults to 0). Reuses `makeSignal` for
 * the Forced signal shape and the same per-frame mux invariant as
 * `setMultiplexor` (at most one multiplexor).
 */
export function setMessageIdMode(
  id: number,
  isExtended: boolean,
  mode: 'auto' | 'forced' | 'none',
  byteIndex = 0,
): void {
  project.update((p) => {
    let core = p.frames.find((f) => f.id === id && f.isExtended === isExtended);
    if (!core) {
      core = { id, isExtended, name: defaultName(id, isExtended), signals: [] };
      p.frames.push(core);
    }
    // `p.frames` is the §3.5 CORE FrameDef[]; the cockpit-only `messageIdAuto`
    // lives on the extended FrameDef (datamodel.ts) and serializes for free.
    const def = core as FrameDef;

    if (mode === 'forced') {
      const bitStart = Math.max(0, Math.floor(byteIndex)) * 8;
      const existing = def.signals.find((s) => (s as EditableSignal).isMultiplexor) as
        | EditableSignal
        | undefined;
      if (existing) {
        // Re-point the existing multiplexor at the chosen byte (keep its name).
        existing.bitStart = bitStart;
        existing.bitLength = 8;
        existing.byteOrder = 'little';
      } else {
        def.signals.push(
          makeSignal(id, isExtended, {
            name: 'message_id',
            bitStart,
            bitLength: 8,
            byteOrder: 'little',
            isMultiplexor: true,
          }),
        );
      }
      // Enforce the single-multiplexor invariant.
      for (const s of def.signals) {
        const es = s as EditableSignal;
        if (es.isMultiplexor && !(es.bitStart === bitStart && es.bitLength === 8)) {
          es.isMultiplexor = false;
        }
      }
      def.messageIdAuto = undefined;
    } else {
      // Auto or None: there is no forced multiplexor — clear it everywhere.
      for (const s of def.signals) (s as EditableSignal).isMultiplexor = false;
      def.messageIdAuto = mode === 'none' ? false : undefined;
    }
    return p;
  });
}

export function removeSignal(frameId: number, isExtended: boolean, signalId: string): void {
  project.update((p) => {
    const def = p.frames.find((f) => f.id === frameId && f.isExtended === isExtended);
    if (def) def.signals = def.signals.filter((s) => s.id !== signalId);
    return p;
  });
}

export function loadProject(p: Project): void {
  ensureViews(p); // back-fill the canonical view for old project JSON.
  ensureLogbook(p); // back-fill the Logbook arrays (scenarios/findings) for old JSON.
  project.set(p);
  // Open the canonical view (the freshly-loaded project's tabs are unknown to
  // the user; the safety-net tab is always a valid landing spot).
  const canonical = (p.views ?? []).find((v) => v.locked) ?? (p.views ?? [])[0];
  if (canonical) activeViewId.set(canonical.id);
}

function defaultName(id: number, isExtended: boolean): string {
  return `0x${id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0')}`;
}

// ── view CRUD + membership (the tab operations) ───────────────────────────────

/** Open a tab. */
export function setActiveView(id: string): void {
  activeViewId.set(id);
}

/**
 * Create a new view (whitelist tab), seeded with `seedKeys` (e.g. the frames
 * visible in the current tab). Opens it. Returns the new view's id.
 */
export function createView(name: string, seedKeys: string[] = []): string {
  const id = newId('view');
  project.update((p) => {
    (p.views ??= [canonicalView()]).push({
      id,
      name: name.trim() || `Tab ${p.views.length}`,
      filter: emptyFilter(),
      members: [...new Set(seedKeys)],
    });
    return p;
  });
  activeViewId.set(id);
  return id;
}

/** Delete a view (never the canonical/locked one). Falls back to canonical. */
export function deleteView(id: string): void {
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === id);
    if (!v || v.locked) return p;
    p.views = (p.views ?? []).filter((view) => view.id !== id);
    return p;
  });
  if (get(activeViewId) === id) {
    const p = get(project);
    const canonical = (p.views ?? []).find((v) => v.locked) ?? (p.views ?? [])[0];
    if (canonical) activeViewId.set(canonical.id);
  }
}

/** Rename a custom view. The canonical (locked) view's name is frozen. */
export function renameView(id: string, name: string): void {
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === id);
    if (v && !v.locked) v.name = name.trim() || v.name;
    return p;
  });
}

/** Whether a frame is tagged into a view (locked views contain everything). */
export function isFrameInView(view: FrameView, id: number, isExtended: boolean): boolean {
  if (view.locked) return true;
  return view.members.includes(frameKey(id, isExtended));
}

/** Add/remove a frame's membership in a view (no-op on locked views). */
export function setFrameInView(
  viewId: string,
  id: number,
  isExtended: boolean,
  member: boolean,
): void {
  const key = frameKey(id, isExtended);
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (!v || v.locked) return p;
    const has = v.members.includes(key);
    if (member && !has) v.members = [...v.members, key];
    else if (!member && has) v.members = v.members.filter((k) => k !== key);
    return p;
  });
}

/** Add/remove MANY frame keys at once (drag-drop, Ctrl+A bulk). No-op on locked. */
export function setFramesInView(viewId: string, keys: string[], member: boolean): void {
  if (keys.length === 0) return;
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (!v || v.locked) return p;
    if (member) {
      v.members = [...new Set([...v.members, ...keys])];
    } else {
      const drop = new Set(keys);
      v.members = v.members.filter((k) => !drop.has(k));
    }
    return p;
  });
}

/**
 * Add ONE MESSAGE's key (`messageKey(frameKey, mux)`) to a view's membership
 * (the "→ tab" affordance in the Message list). A view's `members` is a plain
 * `string[]` that already holds FRAME keys (`frameKey`); a MESSAGE member is the
 * richer `"<frameKey>#<mux>"` form. No-op on the locked (canonical) view, which
 * carries no membership. v1 display semantics: a message member implies its
 * FRAME is shown in the tab (see `frameKeyOfMember` / `filteredRows`).
 */
export function assignMessageToView(
  viewId: string,
  id: number,
  isExtended: boolean,
  mux: number | null,
): void {
  const key = messageKey(frameKey(id, isExtended), mux);
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (!v || v.locked) return p;
    if (!v.members.includes(key)) v.members = [...v.members, key];
    return p;
  });
}

/**
 * The FRAME key implied by a view member. Frame members are already frame keys;
 * a MESSAGE member `"<frameKey>#<mux>"` implies its frame key (everything before
 * the `#`). Lets membership built from message keys still gate the frame table.
 */
export function frameKeyOfMember(member: string): string {
  const hash = member.indexOf('#');
  return hash === -1 ? member : member.slice(0, hash);
}

/** "Show all": tag every frame that passes the view's filter into it. */
export function tagAllVisible(viewId: string): void {
  const rows = get(frameRows);
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (!v || v.locked) return p;
    const keys = rows.filter((r) => passesFilter(v.filter, r)).map((r) => frameKey(r.id, r.isExtended));
    v.members = [...new Set([...v.members, ...keys])];
    return p;
  });
}

/** Set (or clear, with null) the PER-FRAME "Custom" formula for a frame. */
export function setFrameFormula(
  id: number,
  isExtended: boolean,
  def: FormulaDef | null,
): void {
  const key = frameKey(id, isExtended);
  project.update((p) => {
    const map = { ...(p.frameFormulas ?? {}) };
    if (def && def.expr.trim()) map[key] = def;
    else delete map[key];
    p.frameFormulas = map;
    return p;
  });
}

/**
 * Set (or clear, with empty) the CUSTOM NAME of one sub-message in the
 * master-detail Message list. `mux` is the message's mux value (null for the
 * non-mux single message). An empty/blank name clears the entry. Persisted in
 * `Project.messageNames`, serialized with the project like `frameFormulas`.
 */
export function setMessageName(
  id: number,
  isExtended: boolean,
  mux: number | null,
  name: string,
): void {
  const key = messageKey(frameKey(id, isExtended), mux);
  project.update((p) => {
    const map = { ...(p.messageNames ?? {}) };
    const trimmed = name.trim();
    if (trimmed) map[key] = trimmed;
    else delete map[key];
    p.messageNames = map;
    return p;
  });
}

/** Set (or clear, with null) the PER-TAB "Tab" formula for a view. */
export function setViewFormula(viewId: string, def: FormulaDef | null): void {
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (v) v.formula = def && def.expr.trim() ? def : undefined;
    return p;
  });
}

/** "Hide all": empty a view's membership. */
export function clearViewMembers(viewId: string): void {
  project.update((p) => {
    const v = (p.views ?? []).find((view) => view.id === viewId);
    if (!v || v.locked) return p;
    v.members = [];
    return p;
  });
}

// ── derived: the FILTERED frame table (the FilterBar feeds this) ──────────────

/** A frame row decorated with its project name for display + filtering. */
export interface DisplayRow extends FrameRow {
  name: string;
}

/**
 * Pure predicate: does a frame row pass a filter? (NAME-substring excluded — it
 * needs the project to resolve the name, so it's applied separately.) Reused by
 * `filteredRows` and by `tagAllVisible` ("show all" tags exactly the rows
 * that pass the view's filter).
 */
function passesFilter(f: FrameFilter, r: FrameRow): boolean {
  if (f.hideErrors && r.isError) return false;
  if (f.idMin !== null && r.id < f.idMin) return false;
  if (f.idMax !== null && r.id > f.idMax) return false;
  if (f.minRate !== null && r.rate < f.minRate) return false;
  if (f.maxRate !== null && r.rate > f.maxRate) return false;
  if (f.byteIndex !== null && f.byteIndex >= 0) {
    // Byte filter set: a row too short to contain that byte can't match.
    if (f.byteIndex >= r.data.length) return false;
    if ((r.data[f.byteIndex] & f.byteMask) !== (f.byteValue & f.byteMask)) return false;
  }
  return true;
}

export const filteredRows: Readable<DisplayRow[]> = derived(
  [frameRows, project, activeViewId],
  ([$rows, $project, $activeId]) => {
    const vs = $project.views ?? [];
    const view = vs.find((v) => v.id === $activeId) ?? vs[0] ?? canonicalView();
    const f = view.filter;
    const needle = f.nameSubstr.trim().toLowerCase();
    // Custom (non-locked) views also gate on manual membership; the canonical
    // view shows every frame passing its filter. Members can be FRAME keys or
    // MESSAGE keys (`<frameKey>#<mux>`); a message member implies its FRAME is
    // shown, so we gate on the frame key of every member (v1 semantics).
    const memberOf = view.locked
      ? null
      : new Set(view.members.map(frameKeyOfMember));

    const nameOf = (id: number, ext: boolean): string => {
      const def = $project.frames.find((d) => d.id === id && d.isExtended === ext);
      return def ? def.name : '';
    };

    const out: DisplayRow[] = [];
    for (const r of $rows) {
      if (!passesFilter(f, r)) continue;
      if (memberOf && !memberOf.has(frameKey(r.id, r.isExtended))) continue;
      const name = nameOf(r.id, r.isExtended);
      if (needle && !name.toLowerCase().includes(needle)) continue;
      out.push({ ...r, name });
    }
    return out;
  },
);

// ── derived: the CLUSTER cards (decoded-signals dashboard) ────────────────────

/**
 * One card in the Cluster dashboard: a single decoded value to display as
 * Name + current value (+ sparkline in phase 2). Two sources, same shape:
 *   - `signal`  — a project signal decoded against its frame's latest payload
 *                 (the rich, multi-per-frame artefact: name + unit + geometry);
 *   - `formula` — a frame's per-frame "Custom" formula evaluated on that payload.
 * The multiplexor signal itself is excluded (it's a selector, not a value).
 */
export interface ClusterCard {
  /** Stable key for keyed rendering + phase-2 series lookup. */
  key: string;
  /** Card title (signal name, or frame name for a formula card). */
  name: string;
  unit: string;
  frameId: number;
  isExtended: boolean;
  /** The frame's human name (for the sub-label / navigation). */
  frameName: string;
  kind: 'signal' | 'formula';
  /** Current numeric value, or null when the frame is not (yet) on the bus. */
  value: number | null;
  /** Formatted current value (+ unit, or the matched enum label). */
  display: string;
  /** Whether the frame is currently present in the live table (`frameRows`). */
  present: boolean;
  /** The frame's current rate (fps), or 0 when absent. */
  rate: number;
  /** Signal geometry (kind === 'signal') — also the phase-2 worker decode target. */
  sig?: EditableSignal;
  /** Formula expression (kind === 'formula') — also the phase-2 worker target. */
  expr?: string;
}

/**
 * All Cluster cards, derived from the project's decoded signals + Custom
 * formulas and the live frame table. CURRENT values are decoded on the main
 * thread against each frame's latest payload (`FrameRow.data`) — no worker round
 * trip; the worker is only needed for the windowed sparkline series (phase 2).
 *
 * NOTE (v1): a multiplexed signal is decoded against whatever payload is latest,
 * regardless of the active mux — fine for the common non-mux case (mux is rare
 * in broadcast). A mux-aware gate is a later refinement.
 */
export const clusterCards: Readable<ClusterCard[]> = derived(
  [frameRows, project],
  ([$rows, $project]) => {
    const rowByKey = new Map<string, FrameRow>();
    for (const r of $rows) rowByKey.set(frameKey(r.id, r.isExtended), r);

    const nameOf = (id: number, ext: boolean): string =>
      $project.frames.find((d) => d.id === id && d.isExtended === ext)?.name ??
      defaultName(id, ext);

    const out: ClusterCard[] = [];

    // SIGNAL cards: every non-multiplexor signal across all frames.
    for (const def of $project.frames) {
      const fkey = frameKey(def.id, def.isExtended);
      const row = rowByKey.get(fkey);
      for (const s of def.signals) {
        const sig = s as EditableSignal;
        if (sig.isMultiplexor) continue;
        let value: number | null = null;
        let display = '—';
        if (row) {
          const dec = decodeSignal(row.data, sig);
          value = dec.value;
          const label = sig.valueLabels?.[Number(dec.raw)];
          display = label ?? formatValue(dec.value) + (sig.unit ? ` ${sig.unit}` : '');
        }
        out.push({
          key: `sig:${sig.id}`,
          name: sig.name,
          unit: sig.unit ?? '',
          frameId: def.id,
          isExtended: def.isExtended,
          frameName: def.name,
          kind: 'signal',
          value,
          display,
          present: !!row,
          rate: row?.rate ?? 0,
          sig,
        });
      }
    }

    // FORMULA cards: every frame carrying a "Custom" formula.
    const formulas = $project.frameFormulas ?? {};
    for (const [fkey, fdef] of Object.entries(formulas)) {
      if (!fdef.expr.trim()) continue;
      const row = rowByKey.get(fkey);
      // frameKey is `s<id>` / `e<id>`; recover id + extended for the card.
      const isExtended = fkey.startsWith('e');
      const id = Number(fkey.slice(1));
      let value: number | null = null;
      let display = '—';
      if (row) {
        const res = evalFormula(fdef.expr, row.data, fdef.unit);
        if (res.ok) {
          value = typeof res.value === 'number' ? res.value : null;
          display = res.display ?? '—';
        }
      }
      out.push({
        key: `fml:${fkey}`,
        name: nameOf(id, isExtended),
        unit: fdef.unit ?? '',
        frameId: id,
        isExtended,
        frameName: nameOf(id, isExtended),
        kind: 'formula',
        value,
        display,
        present: !!row,
        rate: row?.rate ?? 0,
        expr: fdef.expr,
      });
    }

    return out;
  },
);

/**
 * Register the Cluster watched set with the analysis worker so it traces the
 * sparkline series. Posts the TARGET SET (identity + decode geometry) only —
 * never the live values — and only while Cluster mode is active; leaving the
 * mode posts an empty set so the worker stops tracing. Deduped on a signature so
 * the 10 Hz value churn in `clusterCards` does not re-post an unchanged set.
 */
let _lastClusterWatchKey = '';
function postClusterWatch(): void {
  if (!analysisWorker) return;
  const active = get(uiMode) === 'cluster';
  const windowSeconds = get(clusterWindowSeconds);
  const targets: ClusterTarget[] = active
    ? get(clusterCards).map((c) =>
        c.kind === 'signal'
          ? { key: c.key, id: c.frameId, isExtended: c.isExtended, kind: 'signal', sig: c.sig! }
          : { key: c.key, id: c.frameId, isExtended: c.isExtended, kind: 'formula', expr: c.expr!, unit: c.unit || undefined },
      )
    : [];
  const key = JSON.stringify({ windowSeconds, targets });
  if (key === _lastClusterWatchKey) return;
  _lastClusterWatchKey = key;
  analysisWorker.postMessage({ type: 'clusterWatch', targets, windowSeconds } satisfies ToAnalysisMsg);
}

// Re-register on mode / window / target-set change. `project` drives the target
// SET (signals + formulas); the dedupe above absorbs `clusterCards`' value churn.
uiMode.subscribe(postClusterWatch);
clusterWindowSeconds.subscribe(postClusterWatch);
project.subscribe(postClusterWatch);

// ── url helpers ───────────────────────────────────────────────────────────────

function defaultWsUrl(): string {
  // DESIGN §3.1 default ws://<host>:8765/ws. In dev we point at the backend
  // host directly; if served behind the same origin, use that origin's host.
  if (typeof location !== 'undefined' && location.hostname) {
    return `ws://${location.hostname}:8765/ws`;
  }
  return 'ws://localhost:8765/ws';
}
