// Logbook control-channel relay (DESIGN §3.3) — the copilot is a VIEWER.
//
// The backend fans these text frames out verbatim between clients and never
// interprets them (zero compute, safe on a Pi 1). Two messages:
//
//   host (cockpit) → viewers : {"type":"logbook", ...}      (run state + library)
//   any device     → host    : {"type":"logbookCmd", ...}   (pick+start / stop / next)
//
// The HOST owns the run (the run engine + timers live in the cockpit); the copilot
// renders the relayed state read-only and may command start/stop/next. We parse
// DEFENSIVELY — unknown/extra fields are ignored, missing fields fall back — so a
// forward-compatible host can add detail without breaking the viewer.

/** Run lifecycle, mirroring the cockpit's RunUiStatus (+ `off` = session ended). */
export type LbStatus = 'off' | 'idle' | 'armed' | 'leadin' | 'running' | 'done' | 'stopped';

/** Phase roles (the controlled-experiment vocabulary). */
export type LbPhaseType = 'baseline' | 'noise' | 'wait' | 'stimulus' | 'observe' | 'recover';

/** One unrolled storyboard phase (loop expanded, rep# stamped). */
export interface LbPhase {
  type: LbPhaseType;
  name: string;
  durationS: number;
  /** 1-based for loop phases; 0 for the outer skeleton. */
  rep: number;
  /** "on input" step — awaits the operator's confirmation (no duration). */
  onInput: boolean;
}

/** A scenario as carried for the read-only picker. */
export interface LbLibraryEntry {
  id: string;
  objective: string;
  /** Phase count (a glance-sized size hint). */
  phases: number;
  done: boolean;
}

/** The relayed Logbook run state (host → viewers), normalized for the viewer. */
export interface LogbookRelay {
  type: 'logbook';
  status: LbStatus;
  /** Monotonic; bumped on each transition so the viewer cues exactly once. */
  seq: number;
  /** 3..1 during the lead-in, else 0. */
  leadIn: number;
  /** Index into `phases` of the current phase, or -1. */
  phaseIndex: number;
  awaitingInput: boolean;
  rep: number;
  /** Seconds left in the current timer phase (host-rounded; the viewer animates locally). */
  remainingS: number;
  /** Name of the upcoming phase (or 'finish'). */
  nextLabel: string;
  scenarioId: string | null;
  objective: string;
  phases: LbPhase[];
  library: LbLibraryEntry[];
}

/** Viewer → host command (pick+start / stop / advance an on-input phase). */
export interface LogbookCmdClientMsg {
  type: 'logbookCmd';
  command: 'start' | 'stop' | 'next';
  /** For 'start': which scenario to run. */
  scenarioId?: string;
}

const STATUSES: ReadonlyArray<LbStatus> = ['off', 'idle', 'armed', 'leadin', 'running', 'done', 'stopped'];
const PTYPES: ReadonlyArray<LbPhaseType> = ['baseline', 'noise', 'wait', 'stimulus', 'observe', 'recover'];

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown): boolean => v === true;

function parsePhase(v: unknown): LbPhase {
  const o = (v ?? {}) as Record<string, unknown>;
  const t = str(o.type) as LbPhaseType;
  return {
    type: PTYPES.includes(t) ? t : 'wait',
    name: str(o.name),
    durationS: Math.max(0, num(o.durationS)),
    rep: Math.max(0, Math.floor(num(o.rep))),
    onInput: bool(o.onInput),
  };
}

function parseLib(v: unknown): LbLibraryEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  return { id: str(o.id), objective: str(o.objective, '(untitled)'), phases: Math.max(0, Math.floor(num(o.phases))), done: bool(o.done) };
}

/**
 * Tolerant parse of an inbound frame into a LogbookRelay, or null if it is not a
 * logbook relay. Never throws: a malformed control frame is dropped, never wedges
 * the viewer.
 */
export function parseLogbookRelay(parsed: unknown): LogbookRelay | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'logbook') return null;
  const status = str(o.status, 'off') as LbStatus;
  return {
    type: 'logbook',
    status: STATUSES.includes(status) ? status : 'off',
    seq: num(o.seq),
    leadIn: Math.max(0, Math.floor(num(o.leadIn))),
    phaseIndex: Math.floor(num(o.phaseIndex, -1)),
    awaitingInput: bool(o.awaitingInput),
    rep: Math.max(0, Math.floor(num(o.rep))),
    remainingS: Math.max(0, num(o.remainingS)),
    nextLabel: str(o.nextLabel),
    scenarioId: typeof o.scenarioId === 'string' ? o.scenarioId : null,
    objective: str(o.objective),
    phases: Array.isArray(o.phases) ? o.phases.map(parsePhase) : [],
    library: Array.isArray(o.library) ? o.library.map(parseLib) : [],
  };
}
