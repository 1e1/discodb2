/**
 * Frontend data model — DESIGN.md §3.5.
 *
 * The §3.5 CORE (ByteOrder / Signal / FrameDef / Project) is now imported from
 * the CANONICAL frontend/shared/protocol.ts and RE-EXPORTED here, so there is a
 * single source of truth (P3 dedupe). The shapes were already byte-identical, so
 * this consolidation is the "no-op rename" the original standalone copy
 * anticipated. The cockpit-only DECODE EXTENSIONS (the `signed` flag and the
 * EditableSignal alias) and the id/factory HELPERS stay here — they are not part
 * of the §3.5 wire/DBC core and so do not belong in shared.
 */

import type { ByteOrder, Signal, FrameDef as CoreFrameDef, Project as CoreProject } from '@shared/protocol.ts';
import type { SpanType, FieldRunInput } from '@shared/analysis/field-run.ts';

export type { ByteOrder, Signal };
export type { SpanType };

/**
 * FrameDef, extended with cockpit-only fields that are NOT part of the §3.5
 * wire/DBC core (so the shared shape stays exact). Like `EditableSignal`, this
 * is the shape the cockpit actually edits/reads; it is structurally compatible
 * with the core `FrameDef` and serializes with the project for free (it lives on
 * `project.frames`).
 *
 *   • `messageIdAuto` — the per-frame "Message ID" MODE flag (the friendly
 *     high-level control in the Inspector). Tri-state via this single optional:
 *       - undefined / true ⇒ AUTO (default): a detector proposes a discriminator
 *         byte and only splits when confident.
 *       - false            ⇒ NONE: plain frame, one message, full data.
 *     The FORCED mode is NOT a value here — it is expressed by the frame having
 *     a MULTIPLEXOR signal (see `multiplexorSignal`), which takes precedence and
 *     round-trips to DBC. `messageIdAuto` only distinguishes Auto vs None when
 *     there is no multiplexor.
 */
export interface FrameDef extends CoreFrameDef {
  messageIdAuto?: boolean;
  /**
   * Free-text description (DBC `CM_ BO_`). Cockpit-only (not §3.5), preserved on
   * import and round-tripped on export; surfaced as help/tooltip in the UI.
   */
  comment?: string;
}

/**
 * Project, extended with cockpit-only VIEWS (the "frame list" tabs). The
 * §3.5 wire/DBC core (`name`, `frames`) is untouched; `views` is an OPTIONAL
 * cockpit addition so old project JSON (no `views`) still loads — `ensureViews`
 * back-fills the canonical view on load. Views serialize with the project, so
 * export/import carries the user's tabs for free.
 */
export interface Project extends CoreProject {
  views?: FrameView[];
  /**
   * PER-FRAME "Custom" formulas, keyed by `frameKey`. Each turns a frame's raw
   * bytes into a human value, shown in the table's "Custom" column. Cockpit-only
   * (not part of §3.5 / DBC), serialized with the project.
   */
  frameFormulas?: Record<string, FormulaDef>;
  /**
   * DERIVED ("computed") signals, keyed by `frameKey` — the Signal column's
   * "2nd formula flavour": an expr over the frame's DECODED signal VALUES (by
   * name), e.g. `engine_rpm * inner_engine_torque`. Distinct from a
   * `frameFormulas` Custom formula (which runs over raw bytes). Cockpit-only,
   * serialized with the project; absent ⇒ none.
   */
  derivedSignals?: Record<string, DerivedSignalDef[]>;
  /**
   * CUSTOM MESSAGE NAMES for the master-detail Message list, keyed by
   * `messageKey(frameKey, muxValue)` (mux value `null` ⇒ the frame's single
   * non-mux message). Shown as a colored badge in the Message list. Cockpit-only
   * (not part of §3.5 / DBC), serialized with the project like `frameFormulas`.
   */
  messageNames?: Record<string, string>;
  /**
   * LOGBOOK ("carnet de chasse") scenarios — reusable, scripted stimulus-response
   * experiments. Cockpit-only (not §3.5/DBC), serialized with the project;
   * `ensureLogbook` back-fills `[]` on load so old project JSON still opens.
   */
  scenarios?: LogbookScenario[];
  /**
   * LOGBOOK findings — signals promoted from a run, with provenance, accumulating
   * across sessions (the cross-session knowledge base). Cockpit-only, serialized.
   */
  findings?: LogbookFinding[];
  /**
   * MARKHUNT field runs — the bottom-up sibling of a scenario (docs/markhunt-spec.md):
   * record-and-paint spans live, assign their meaning afterward. Cockpit-only,
   * serialized; `ensureLogbook` back-fills `[]` so old project JSON still loads.
   */
  fieldRuns?: FieldRun[];
}

/** A user formula: an expr-eval expression over the frame bytes, plus a unit. */
export interface FormulaDef {
  /** expr-eval expression over A..H / bytes / len (see protocol/formula.ts). */
  expr: string;
  /** Optional unit appended to a numeric result (e.g. "rpm", "°C"). */
  unit?: string;
}

/**
 * A DERIVED (computed) signal: an expr-eval expression over the frame's DECODED
 * signal VALUES, referenced by name (e.g. `engine_rpm / 1000`). The Signal
 * column's "2nd formula flavour" — a channel built from already-decoded signals.
 */
export interface DerivedSignalDef {
  id: string;
  name: string;
  /** expr-eval expression over the frame's decoded signal names (+ math helpers). */
  expr: string;
  /** Optional unit appended to a numeric result. */
  unit?: string;
}

/* ── the "frame list" view model (tabs over the frame table) ──────────────────
 *
 * A VIEW is a named tab: its own FILTER (predicate) plus a manual MEMBERSHIP set
 * — the frame keys the user has "tagged" into the tab (point 4/5: think of it as
 * labels on frames, stored on the view side). Display in a view = frames passing
 * the view's filter AND (for non-canonical views) present in `members`.
 *
 * The first view is CANONICAL ("All"): `locked` — it is undeletable, NOT
 * renamable, carries no membership (shows every frame passing its filter), and is
 * the safety net you can never accidentally empty. Custom views are positive
 * whitelists: created
 * empty (or seeded), grown with the per-frame assign menu or the per-view
 * "show all" (tag all currently-visible) / "hide all" (empty) actions.
 */

export interface FrameFilter {
  /** Inclusive id range. */
  idMin: number | null;
  idMax: number | null;
  /** Byte mask/value test: (data[byteIndex] & mask) === value. */
  byteIndex: number | null;
  byteMask: number; // 0..255
  byteValue: number; // 0..255
  /** Minimum estimated rate (fps). The `>=` end of the frequency band. */
  minRate: number | null;
  /**
   * Maximum estimated rate (fps). The `<=` end of the frequency band — set this
   * (low, e.g. ≤2) to ISOLATE one-shot / rare frames a min-rate filter can't
   * surface (a door-unlock that fires once is invisible under a `≥rate` filter).
   */
  maxRate: number | null;
  /** Case-insensitive substring of the frame NAME (from the project). */
  nameSubstr: string;
  /** Hide error frames. */
  hideErrors: boolean;
}

export function emptyFilter(): FrameFilter {
  return {
    idMin: null,
    idMax: null,
    byteIndex: null,
    byteMask: 0xff,
    byteValue: 0x00,
    minRate: null,
    maxRate: null,
    nameSubstr: '',
    hideErrors: false,
  };
}

/** One tab over the frame table. */
export interface FrameView {
  id: string;
  name: string;
  /** Canonical "All" view: undeletable, no membership (shows all). */
  locked?: boolean;
  /** Per-view predicate (the FilterBar state for this tab). */
  filter: FrameFilter;
  /** Tagged frame keys (see `frameKey`). Ignored when `locked`. */
  members: string[];
  /**
   * PER-TAB "Tab" formula — applied to every row shown in this tab and rendered
   * in the table's "Tab" column. Lets a whole tab share one interpretation
   * (e.g. a "temperatures" tab where every frame is `A - 40`).
   */
  formula?: FormulaDef;
}

/**
 * Stable per-frame key (id + extended flag). MUST match FrameTable's row key so
 * membership lines up with what's rendered: `s`=standard (11-bit), `e`=extended.
 */
export function frameKey(id: number, isExtended: boolean): string {
  return `${isExtended ? 'e' : 's'}${id}`;
}

/**
 * Stable per-MESSAGE key for the master-detail Message list, used to key custom
 * message names in `Project.messageNames`. Form: `"<frameKey>#<muxValue>"`, e.g.
 * `"s256#3"`. A `null` mux value (the frame has no multiplexor → exactly one
 * message representing the frame itself) uses the empty suffix `"<frameKey>#"`.
 */
export function messageKey(frameKey: string, muxValue: number | null): string {
  return `${frameKey}#${muxValue ?? ''}`;
}

/** The canonical, undeletable, non-renamable "All" view. */
export function canonicalView(): FrameView {
  return { id: 'view_all', name: 'All', locked: true, filter: emptyFilter(), members: [] };
}

/**
 * Guarantee a project has the canonical view as its FIRST view (in place).
 * Old project JSON with no `views` gets a single canonical view; a project whose
 * views somehow lack a locked one gets it prepended. Returns the same object.
 */
export function ensureViews(project: Project): Project {
  if (!project.views || project.views.length === 0) {
    project.views = [canonicalView()];
  } else if (!project.views.some((v) => v.locked)) {
    project.views.unshift(canonicalView());
  }
  return project;
}

/* ────────────────────────────────────────────────────────────────────────
 * LOGBOOK ("carnet de chasse") — scripted stimulus-response experiments.
 * The SCENARIO is the editable template; a RUN (the run engine, separate) stamps
 * actual µs windows and feeds the analyzer (shared/analysis/logbook.ts). A FINDING
 * is a promoted signal, persisted across sessions.
 * ──────────────────────────────────────────────────────────────────────── */

/** Phase roles, mirroring the analyzer's controlled-experiment vocabulary. */
export type LogbookPhase = 'baseline' | 'noise' | 'wait' | 'stimulus' | 'observe' | 'recover';

/** One storyboard step. `advance` = how the run leaves it. */
export interface LogbookStep {
  type: LogbookPhase;
  /** Operator label (the stimulus name is objective-specific). */
  name: string;
  /** Nominal duration in SECONDS (also the timeline band width for an input step). */
  durationS: number;
  /** 'timer' → auto-advance after `durationS`; 'input' → wait for operator Next/Space. */
  advance: 'timer' | 'input';
}

/** The editable LOOP body + its repetition count. */
export interface LogbookLoop {
  count: number;
  steps: LogbookStep[];
}

/**
 * A scenario = the FIXED experiment skeleton (baseline → noise → wait → loop →
 * recover). The four outer steps are structural (only their duration is editable);
 * only the loop's steps can be added/removed/reordered — enforced here by SHAPE.
 */
export interface LogbookScenario {
  id: string;
  objective: string;
  /** Operator-set: objective fulfilled (shown checked in the library). */
  done: boolean;
  /** Expected response type, to bias the analyzer (optional). */
  expectedType?: 'pulse' | 'level' | 'trend' | 'auto';
  baseline: LogbookStep;
  noise: LogbookStep;
  wait: LogbookStep;
  loop: LogbookLoop;
  recover: LogbookStep;
}

/** A signal promoted from a run, persisted in the project's knowledge base. */
export interface LogbookFinding {
  id: string;
  /** Human label / meaning. */
  name: string;
  frameId: number;
  isExtended: boolean;
  byteIndex: number;
  /** Bit within the byte for a 1-bit flag; undefined for a whole byte / multi-byte field. */
  bit?: number;
  /** Detected response type. */
  kind?: 'pulse' | 'level' | 'delayed' | 'trend';
  status: 'hypothesis' | 'confirmed';
  /** When confirmed, excluded from future hunts (the discrimination of known signals). */
  excludeFromHunt: boolean;
  /** Provenance: which scenario produced it, and when. */
  scenarioId?: string;
  foundAt?: string;
  /** Suggested synonyms (behavioral correlation / reference-DBC matches). */
  synonyms?: string[];
}

/** One unrolled phase of a scenario (loop expanded, rep# stamped). */
export interface LogbookRunPhase {
  type: LogbookPhase;
  name: string;
  durationS: number;
  advance: 'timer' | 'input';
  /** Repetition number for loop phases (1-based); 0 for the outer skeleton steps. */
  rep: number;
}

/** Flatten a scenario into its ordered phase sequence (loop unrolled). */
export function scenarioPhases(s: LogbookScenario): LogbookRunPhase[] {
  const out: LogbookRunPhase[] = [];
  const push = (st: LogbookStep, rep: number) =>
    out.push({ type: st.type, name: st.name, durationS: st.durationS, advance: st.advance, rep });
  push(s.baseline, 0);
  push(s.noise, 0);
  push(s.wait, 0);
  for (let r = 1; r <= s.loop.count; r++) for (const st of s.loop.steps) push(st, r);
  push(s.recover, 0);
  return out;
}

/** A fresh scenario on the standard skeleton. `loopSteps` defaults to stimulus→observe. */
export function makeScenario(objective: string, loopSteps?: LogbookStep[]): LogbookScenario {
  return {
    id: newId('scn'),
    objective,
    done: false,
    expectedType: 'auto',
    baseline: { type: 'baseline', name: 'Idle', durationS: 20, advance: 'timer' },
    noise: { type: 'noise', name: 'Noise', durationS: 30, advance: 'timer' },
    wait: { type: 'wait', name: 'Settle', durationS: 5, advance: 'timer' },
    loop: {
      count: 3,
      steps: loopSteps ?? [
        { type: 'stimulus', name: 'Stimulus', durationS: 3, advance: 'input' },
        { type: 'observe', name: 'After-effect', durationS: 5, advance: 'timer' },
      ],
    },
    recover: { type: 'recover', name: 'Return to baseline', durationS: 10, advance: 'timer' },
  };
}

/** Back-fill the Logbook arrays so old project JSON (no `scenarios`/`findings`) loads. */
export function ensureLogbook(project: Project): Project {
  if (!project.scenarios) project.scenarios = [];
  if (!project.findings) project.findings = [];
  if (!project.fieldRuns) project.fieldRuns = [];
  return project;
}

/* ────────────────────────────────────────────────────────────────────────
 * MARKHUNT ("free-run / highlighter") — the bottom-up sibling of a scenario.
 * docs/markhunt-spec.md. The operator prepares neutral LABELS, paints non-
 * overlapping SPANS live during a free recording, then assigns each span a
 * MEANING (a SpanType) and inter-span "≈" links afterward. The pure analyzer
 * (shared/analysis/field-run.ts) consumes the mapped `FieldRunInput`; the shapes
 * below are the EDITABLE/persisted model (like LogbookScenario vs LogbookRun).
 * ──────────────────────────────────────────────────────────────────────── */

/** A reusable "highlighter": a named/colored marker the operator paints with. */
export interface MarkLabel {
  id: string;
  /** Operator's free text — "stable", "accel", "marker 1"… */
  name: string;
  /** Hex color, for the painter buttons + the timeline bands. */
  color: string;
}

/**
 * One painted segment: a [start,end] window stamped with ONE label. The same
 * `labelId` may recur across a run (repetitions). `type`/`equivalentTo` are
 * assigned a posteriori (Phase 3) and are absent right after painting.
 */
export interface MarkSpan {
  id: string;
  labelId: string;
  startTUs: number;
  endTUs: number;
  /** Assigned meaning (Phase 3); undefined ⇒ not yet annotated (treated as 'ignore'). */
  type?: SpanType;
  /** Ids of OTHER spans this one is asserted to hold the same value as ("≈"). */
  equivalentTo?: string[];
}

/**
 * A field run: the library envelope (id/objective/done — shared with the Logbook
 * library) plus the prepared labels and the painted spans.
 */
export interface FieldRun {
  id: string;
  objective: string;
  /** Operator-set: objective fulfilled (shown checked in the library). */
  done: boolean;
  labels: MarkLabel[];
  spans: MarkSpan[];
}

/** Default highlighter palette for a fresh field run (mirrors the Logbook phase hues). */
const DEFAULT_MARK_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Stable', color: '#4fa3ff' },
  { name: 'Action', color: '#ff6b6b' },
];

/** A fresh field run with a starter pair of labels and no spans yet. */
export function makeFieldRun(objective = 'New field run'): FieldRun {
  return {
    id: newId('frun'),
    objective,
    done: false,
    labels: DEFAULT_MARK_LABELS.map((l) => ({ id: newId('lbl'), name: l.name, color: l.color })),
    spans: [],
  };
}

/**
 * Map a (persisted) field run to the pure analyzer's input: each span becomes a
 * TypedSpan with its assigned type, or `'ignore'` when not yet annotated. Spans
 * are emitted in chronological order (the analyzer is order-independent, but it
 * keeps `≈`/between-span math predictable).
 */
export function fieldRunToInput(run: FieldRun): FieldRunInput {
  return {
    spans: run.spans
      .slice()
      .sort((a, b) => a.startTUs - b.startTUs)
      .map((s) => ({
        id: s.id,
        startTUs: s.startTUs,
        endTUs: s.endTUs,
        type: s.type ?? 'ignore',
        equivalentTo: s.equivalentTo,
      })),
  };
}

/** Whether a signal is interpreted as signed two's-complement. */
export interface SignalSignedness {
  /**
   * §3.5 does not carry a signed flag. We default unsigned and expose an
   * optional extension flag here (kept out of the wire/DBC-mapped core so the
   * §3.5 shape stays exact). Decode honours it when present.
   */
  signed?: boolean;
}

/**
 * MULTIPLEXING extension (B2 · point 2). Like `signed`, kept OUT of the §3.5
 * core (shared/protocol.ts) so the wire/DBC-mapped shape stays exact; promote it
 * to the core if/when the DBC writer round-trips mux. DBC analogues:
 *   • isMultiplexor  → the `M` marker — this signal SELECTS the sub-message.
 *   • multiplexValue → the `m<N>` marker — this signal is present only when the
 *     multiplexor equals N. Undefined ⇒ always present (not mode-dependent).
 * At most one signal per frame is the multiplexor (enforced by the store's
 * `setMultiplexor`).
 */
export interface SignalMux {
  isMultiplexor?: boolean;
  multiplexValue?: number;
}

/**
 * VALUE-LABEL extension (DBC `VAL_`). Like `signed` / mux, kept OUT of the §3.5
 * core (shared/protocol.ts) so the wire/DBC-mapped shape stays exact. Maps a
 * raw (unscaled) integer value to an enum label, e.g. `{2: "Reverse"}`. The DBC
 * analogue is the `VAL_ <msgId> <signal> <int> "<label>" … ;` line, which
 * `importDbc` parses and `exportDbc` round-trips.
 */
export interface SignalValueLabels {
  valueLabels?: Record<number, string>;
}

/**
 * COMMENT extension (DBC `CM_ SG_`). Like the others, kept OUT of the §3.5 core.
 * Free-text signal description; `importDbc` attaches it and `exportDbc`
 * round-trips it. Surfaced as a tooltip in the signal editor.
 */
export interface SignalComment {
  comment?: string;
}

/** A Signal plus cockpit-only decode extensions that are not part of §3.5. */
export type EditableSignal = Signal &
  SignalSignedness &
  SignalMux &
  SignalValueLabels &
  SignalComment;

/** The frame's multiplexor signal (the sub-message selector), if any. */
export function multiplexorSignal(def: FrameDef | undefined): EditableSignal | undefined {
  return def?.signals.find((s) => (s as EditableSignal).isMultiplexor) as
    | EditableSignal
    | undefined;
}

// ── helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
/** Cheap unique id generator (crypto.randomUUID where available). */
export function newId(prefix = 'sig'): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}_${g.crypto.randomUUID()}`;
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export function emptyProject(name = 'untitled'): Project {
  return { name, frames: [], views: [canonicalView()], scenarios: [], findings: [] };
}

/** Find or create a FrameDef for an observed id. Mutates `project.frames`. */
export function ensureFrameDef(
  project: Project,
  id: number,
  isExtended: boolean,
): FrameDef {
  let def = project.frames.find((f) => f.id === id && f.isExtended === isExtended);
  if (!def) {
    def = { id, isExtended, name: defaultFrameName(id, isExtended), signals: [] };
    project.frames.push(def);
  }
  return def;
}

export function defaultFrameName(id: number, isExtended: boolean): string {
  const hex = id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0');
  return `0x${hex}`;
}

export function makeSignal(
  frameId: number,
  isExtended: boolean,
  partial: Partial<EditableSignal> = {},
): EditableSignal {
  return {
    id: newId(),
    frameId,
    isExtended,
    bitStart: 0,
    bitLength: 8,
    byteOrder: 'little',
    factor: 1,
    offset: 0,
    unit: '',
    name: 'new_signal',
    signed: false,
    ...partial,
  };
}
