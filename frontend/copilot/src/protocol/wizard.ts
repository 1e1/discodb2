// Wizard control-channel relay (DESIGN §3.3) — the copilot is a VIEWER.
//
// The backend FANS OUT these text frames verbatim between clients and never
// interprets them (zero compute, safe on a Pi 1). Two messages:
//
//   host (cockpit) → viewers : {"type":"wizard", ...}        (state + candidates)
//   any device     → host    : {"type":"trialFeedback", ...} (operator verdict)
//
// DESIGN §3.3 pins the wizard payload's CONTENTS ("current Wizard state: phase,
// rep/good/target, silence, top candidates, cue mode") but leaves the exact
// field layout to the host. The host run-loop is built in the cockpit; until it
// lands, THIS is the canonical shape the copilot consumes. We reuse the shared
// FSM/cue vocabulary (WizardPhase, CueMode) so there is ONE source of truth and
// parse defensively: unknown/extra fields are ignored, missing fields fall back,
// so a forward-compatible host can add detail without breaking the viewer.

import type { WizardPhase } from "@shared/wizard-fsm.ts";
import type { CueMode } from "@shared/cue-config.ts";

/** The operator's per-trial verdict (DESIGN §3.3 trialFeedback.action). */
export type TrialAction = "success" | "fail" | "abandon" | "skip";

/**
 * One ranked candidate as carried in the relay — a glance-sized SUBSET of the
 * cockpit's RankedCandidate (the copilot never recomputes; it only displays the
 * top one or two). All fields optional except a stable `id` + `label` so the
 * viewer can key and show SOMETHING even from a sparse host.
 */
export interface RelayCandidate {
  /** Stable id for keying/selection. */
  id: string;
  /** Short human label, e.g. "0x1F0 · B2 b3" (already formatted by the host). */
  label: string;
  /** Higher = stronger evidence; set-relative. */
  score?: number;
  /** One-line rationale ("toggled on each of 3 presses"). */
  rationale?: string;
}

/** Why a series ended early (host-derived, WIZARD.md "Abandon reason"). */
export type AbandonReason = "guard" | "explicit" | null;

/**
 * The relayed Wizard state (host → viewers), normalized for the viewer. The
 * field set is the UNION of what the cockpit host emits today (its
 * `WizardRelayPayload`: phase, repIndex, good, `target`, silence, silenceGuard,
 * cueMode, `label`, `abandonReason`) and forward-compatible extras the host MAY
 * add later (top `candidates`, a `cueSeq` for re-cue detection). The parser
 * accepts the host's real names and is tolerant of the rest, so the viewer
 * interoperates with the cockpit as built AND survives shape evolution.
 */
export interface WizardRelay {
  type: "wizard";
  /** FSM phase — drives the entire glance UI. */
  phase: WizardPhase;
  /** Test (repetition attempt) index, 0-based. */
  repIndex: number;
  /** Confirmed GOOD trials so far. */
  good: number;
  /** Target GOOD trials (host `target` / config.repetitions). */
  repetitions: number;
  /** Consecutive silences toward the guard-rail. */
  silence: number;
  /** Auto-abandon threshold (config.silenceGuard) — countdown denominator. */
  silenceGuard: number;
  /** Which cue preset the viewer must play locally on each `cueing` phase. */
  cueMode: CueMode;
  /** Human label of the maneuver under test (host `label`; driver-facing). */
  maneuver?: string;
  /**
   * Host-derived abandon reason on terminal `abandoned` (the cockpit sends this
   * explicitly). When absent we fall back to deriving it from state
   * (`silence === silenceGuard`) per WIZARD.md.
   */
  abandonReason?: AbandonReason;
  /** Top 3–5 candidates if the host includes them; the glance shows the leader. */
  candidates?: RelayCandidate[];
  /**
   * Optional monotonic counter the host may bump on every cue (re)start. The
   * viewer plays a fresh beep each time it changes while phase==="cueing", so a
   * silent REPLAY (same repIndex) still re-cues. Absent ⇒ fall back to repIndex.
   */
  cueSeq?: number;
}

/** trialFeedback message (any device → host, DESIGN §3.3). */
export interface TrialFeedbackMsg {
  type: "trialFeedback";
  action: TrialAction;
  /** Backend monotonic µs of the verdict (best-effort; host re-stamps if absent). */
  at: number;
}

const WIZARD_PHASES: readonly WizardPhase[] = [
  "idle",
  "cueing",
  "feedback",
  "retryPrompt",
  "done",
  "abandoned",
];

const CUE_MODES: readonly CueMode[] = ["during", "after"];

function asFiniteInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function asNonNegInt(v: unknown, fallback: number): number {
  const n = asFiniteInt(v, fallback);
  return n < 0 ? fallback : n;
}

/**
 * Parse a relayed `{type:"wizard"}` payload into a typed WizardRelay, or null if
 * it is not a wizard frame. TOLERANT by design (the backend never validated it
 * and a forward-compatible host may add fields): unknown phases/modes and bad
 * numbers fall back to safe defaults rather than throwing — a viewer must never
 * wedge on a malformed control frame.
 */
export function parseWizardRelay(obj: unknown): WizardRelay | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "wizard") return null;

  const phase = (WIZARD_PHASES as readonly string[]).includes(o.phase as string)
    ? (o.phase as WizardPhase)
    : "idle";
  const cueMode = (CUE_MODES as readonly string[]).includes(o.cueMode as string)
    ? (o.cueMode as CueMode)
    : "during";

  let candidates: RelayCandidate[] | undefined;
  if (Array.isArray(o.candidates)) {
    candidates = [];
    for (const c of o.candidates) {
      if (typeof c !== "object" || c === null) continue;
      const cc = c as Record<string, unknown>;
      const id = typeof cc.id === "string" ? cc.id : undefined;
      const label = typeof cc.label === "string" ? cc.label : undefined;
      if (id === undefined || label === undefined) continue;
      candidates.push({
        id,
        label,
        score: typeof cc.score === "number" && Number.isFinite(cc.score) ? cc.score : undefined,
        rationale: typeof cc.rationale === "string" ? cc.rationale : undefined,
      });
    }
  }

  // The cockpit host emits `target` (reps) and `label` (maneuver); accept those
  // first, then our forward-compatible aliases `repetitions` / `maneuver`.
  const repetitions = asNonNegInt(
    o.target !== undefined ? o.target : o.repetitions,
    0,
  );
  const maneuver =
    typeof o.label === "string"
      ? o.label
      : typeof o.maneuver === "string"
        ? o.maneuver
        : undefined;

  // Host-sent abandon reason if present; otherwise leave undefined and let the
  // UI derive it from state (wasGuardRailAbandon).
  let abandonReason: AbandonReason | undefined;
  if (o.abandonReason === "guard" || o.abandonReason === "explicit") {
    abandonReason = o.abandonReason;
  } else if (o.abandonReason === null) {
    abandonReason = null;
  }

  return {
    type: "wizard",
    phase,
    repIndex: asNonNegInt(o.repIndex, 0),
    good: asNonNegInt(o.good, 0),
    repetitions,
    silence: asNonNegInt(o.silence, 0),
    silenceGuard: asNonNegInt(o.silenceGuard, 0),
    cueMode,
    maneuver,
    abandonReason,
    candidates,
    cueSeq:
      typeof o.cueSeq === "number" && Number.isFinite(o.cueSeq)
        ? o.cueSeq
        : undefined,
  };
}

/** True for the two phases that are NOT a running session (no overlay). */
export function isIdlePhase(phase: WizardPhase): boolean {
  return phase === "idle";
}

/** True for the two terminal phases. */
export function isTerminalPhase(phase: WizardPhase): boolean {
  return phase === "done" || phase === "abandoned";
}

/**
 * Distinguish the two abandon reasons (WIZARD.md "Abandon reason from state").
 * Prefer the host's explicit `abandonReason` when it sent one; otherwise DERIVE
 * it from state — `silence === silenceGuard` ⇒ the guard-rail auto-stopped, else
 * an explicit ABANDON. Only meaningful when phase === "abandoned".
 */
export function wasGuardRailAbandon(r: WizardRelay): boolean {
  if (r.abandonReason === "guard") return true;
  if (r.abandonReason === "explicit") return false;
  return r.silenceGuard > 0 && r.silence >= r.silenceGuard;
}
