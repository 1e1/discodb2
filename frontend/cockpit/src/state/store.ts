/**
 * Application state — the glue between the protocol client, the parser worker,
 * the raw ring buffer, the session clock, and the §3.5 project model.
 *
 * Uses Svelte stores so components stay dumb. The hot path (binary batches)
 * does NOT flow through Svelte reactivity per-frame: batches go client → worker
 * (transfer), and only throttled SnapshotMsgs update the `frameRows` store.
 */

import { derived, get, writable, type Readable, type Writable } from 'svelte/store';

import { ProtocolClient, type ConnectionState } from '../protocol/client';
import type { HealthStatus, TrialFeedbackMsg } from '../protocol/types';
import { SessionClock } from '../protocol/sessionClock';
import { RawFrameRing } from './ringBuffer';
import { parseBatch } from '../protocol/parseBatch';
import {
  canonicalView,
  emptyFilter,
  emptyProject,
  ensureViews,
  frameKey,
  newId,
  type EditableSignal,
  type FormulaDef,
  type FrameDef,
  type FrameFilter,
  type FrameView,
  type Project,
} from '../protocol/datamodel';
import type { FromWorkerMsg, FrameRow, ToWorkerMsg } from '../worker/workerApi';
import ParserWorker from '../worker/parser.worker?worker';

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

// ── views (the "frame list" tabs) ────────────────────────────────────────────
// Views live INSIDE the project (project.views) so they serialize with
// export/import. `activeViewId` is ephemeral UI state (which tab is open) and is
// NOT persisted.

/** Id of the currently-open view tab. Defaults to the canonical view. */
export const activeViewId: Writable<string> = writable(canonicalView().id);

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

const RING_CAPACITY = 1_000_000;
export const ring = new RawFrameRing(RING_CAPACITY);
let sessionClock = new SessionClock();
let worker: Worker | null = null;
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
      ringStats.set(ring.stats());
    } else if (msg.type === 'error') {
      lastError.set(msg.message);
    }
  };
  const cfg: ToWorkerMsg = { type: 'config', snapshotIntervalMs: 100 };
  w.postMessage(cfg);
  return w;
}

/** Feed a raw batch to BOTH the worker (aggregation) and the ring (history). */
function onBatch(buffer: ArrayBuffer): void {
  // Parse once on the main thread for the ring buffer (history must be
  // complete & ordered). The worker gets its OWN copy because postMessage with
  // a transfer would neuter the buffer we still need here. We copy then
  // transfer the copy so the hot path stays zero-GC on the worker side.
  try {
    const { frames } = parseBatch(buffer);
    ring.pushMany(frames);
    if (frames.length > 0) sessionClock.observe(frames[0].tUs);
  } catch (err) {
    lastError.set(err instanceof Error ? err.message : String(err));
  }

  if (worker) {
    const copy = buffer.slice(0);
    const msg: ToWorkerMsg = { type: 'ingest', buffer: copy };
    worker.postMessage(msg, [copy]);
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

/** (Re)connect to the backend WS, (re)spawning the worker + clock. */
export function connect(url?: string): void {
  const target = url ?? get(wsUrl);
  wsUrl.set(target);

  // Fresh session: capture the absolute start from the browser clock NOW (§4.2)
  // and reset relative-time origin + worker aggregates + ring history.
  sessionClock = new SessionClock();
  ring.clear();
  if (!worker) worker = spawnWorker();
  worker.postMessage({ type: 'reset' } satisfies ToWorkerMsg);
  frameRows.set([]);

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

export function removeSignal(frameId: number, isExtended: boolean, signalId: string): void {
  project.update((p) => {
    const def = p.frames.find((f) => f.id === frameId && f.isExtended === isExtended);
    if (def) def.signals = def.signals.filter((s) => s.id !== signalId);
    return p;
  });
}

export function loadProject(p: Project): void {
  ensureViews(p); // back-fill the canonical view for old project JSON.
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
    // view shows every frame passing its filter.
    const memberOf = view.locked ? null : new Set(view.members);

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

// ── url helpers ───────────────────────────────────────────────────────────────

function defaultWsUrl(): string {
  // DESIGN §3.1 default ws://<host>:8765/ws. In dev we point at the backend
  // host directly; if served behind the same origin, use that origin's host.
  if (typeof location !== 'undefined' && location.hostname) {
    return `ws://${location.hostname}:8765/ws`;
  }
  return 'ws://localhost:8765/ws';
}
