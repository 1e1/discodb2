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

import type { ByteOrder, Signal, FrameDef, Project as CoreProject } from '@shared/protocol.ts';

export type { ByteOrder, Signal, FrameDef };

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
}

/** A user formula: an expr-eval expression over the frame bytes, plus a unit. */
export interface FormulaDef {
  /** expr-eval expression over A..H / bytes / len (see protocol/formula.ts). */
  expr: string;
  /** Optional unit appended to a numeric result (e.g. "rpm", "°C"). */
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

/** Whether a signal is interpreted as signed two's-complement. */
export interface SignalSignedness {
  /**
   * §3.5 does not carry a signed flag. We default unsigned and expose an
   * optional extension flag here (kept out of the wire/DBC-mapped core so the
   * §3.5 shape stays exact). Decode honours it when present.
   */
  signed?: boolean;
}

/** A Signal plus cockpit-only decode extensions that are not part of §3.5. */
export type EditableSignal = Signal & SignalSignedness;

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
  return { name, frames: [], views: [canonicalView()] };
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
