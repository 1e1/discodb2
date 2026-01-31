// discodb2 — the Wizard PER-TRIAL FEEDBACK finite-state machine.
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Per-trial feedback (FSM)" (the exact
// 7 s / 3 s / silence-guard loop) and frontend/shared/wizard-config.ts
// (feedbackTimeoutMs, retryPromptTimeoutMs, silenceGuard, repetitions).
//
// PURE & FRAMEWORK-FREE (like protocol.ts / analysis/*.ts): no Svelte / Vite /
// DOM, and crucially NO TIMERS inside. The HOST drives the wall-clock timers
// (it knows it is on a real device with a screen) and feeds back the
// *_TIMEOUT events when a window elapses with no operator input. This module
// is a single pure reducer:
//
//     step(state, event, config?) -> { state, effects }
//
// It mutates nothing and allocates a fresh next-state + effect list every call,
// so it is trivially testable and replayable (Node test runner, a Web Worker,
// the cockpit, a viewer — all the same). The effects are an ordered to-do list
// the host carries out (play a sound, arm a timer, persist a trial, advance the
// series, …); the FSM never performs side effects itself.
//
// THE LOOP, per test (= one repetition) in a series — verbatim from WIZARD.md:
//   1. Play the cue, then show the feedback request for `feedbackTimeoutMs` (7 s).
//      - ✓ Success (SUCCESS, <7 s) → trial GOOD → next test; silence ← 0.
//      - ✗ Fail    (FAIL,    <7 s) → REPEAT this test; silence ← 0
//                                     (the operator manifested — no guard tick).
//      - no input at 7 s (FEEDBACK_TIMEOUT) → retryPrompt for `retryPromptTimeoutMs` (3 s):
//          - Abandon (ABANDON)           → end the series.
//          - Skip    (SKIP)              → mark this rep not-completed → next test.
//          - no input at 3 s (RETRY_TIMEOUT) → silence++ and REPLAY current test.
//   2. silence == `silenceGuard` (5) CONSECUTIVE → auto-abandon (guard-rail).
//   3. ANY manifestation (✓ / ✗ / Abandon / Skip) resets silence to 0.
//   4. DONE when the GOOD-trial count reaches `config.repetitions`.

import { WIZARD_DEFAULTS, type WizardConfig } from "./wizard-config.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The phases of one signal's series.
 *
 *   idle        before START; nothing is on screen.
 *   cueing      the cue is playing; we are waiting for it to finish (CUE_DONE).
 *   feedback    the big ✓ Success / ✗ Fail request is up for `feedbackTimeoutMs`.
 *   retryPrompt the [ Abandon ] [ Skip ] escalation is up for `retryPromptTimeoutMs`.
 *   done        the series reached `config.repetitions` good trials (success).
 *   abandoned   the series ended early (explicit ABANDON or the silence guard).
 *
 * `done` and `abandoned` are TERMINAL: further events are no-ops.
 */
export type WizardPhase =
  | "idle"
  | "cueing"
  | "feedback"
  | "retryPrompt"
  | "done"
  | "abandoned";

/**
 * The full machine state. Immutable by convention — `step` never mutates its
 * input; it returns a fresh object.
 */
export interface WizardState {
  /** Current phase of the per-trial loop. */
  phase: WizardPhase;
  /** Index of the test (repetition attempt) currently being run, 0-based. */
  repIndex: number;
  /** Count of GOOD (confirmed ✓) trials so far. Target = `config.repetitions`. */
  good: number;
  /**
   * Consecutive silences (no manifestation). Bumped only by RETRY_TIMEOUT;
   * reset to 0 by ANY manifestation. Reaching `config.silenceGuard` auto-abandons.
   */
  silence: number;
}

/**
 * Events the host feeds the machine.
 *
 *   START            begin the series (from idle): play the first cue.
 *   CUE_DONE         the cue finished playing → show the feedback request.
 *   SUCCESS          ✓ Success pressed within the 7 s window.
 *   FAIL             ✗ Fail pressed within the 7 s window.
 *   FEEDBACK_TIMEOUT the 7 s feedback window elapsed with no input.
 *   RETRY_TIMEOUT    the 3 s retry-prompt window elapsed with no input.
 *   ABANDON          Abandon / Stop — a UNIVERSAL escape (works in any
 *                    non-terminal phase: cueing, feedback, or retryPrompt).
 *   SKIP             Skip pressed in the retry prompt (mark rep not-completed).
 */
export type WizardEvent =
  | "START"
  | "CUE_DONE"
  | "SUCCESS"
  | "FAIL"
  | "FEEDBACK_TIMEOUT"
  | "RETRY_TIMEOUT"
  | "ABANDON"
  | "SKIP";

/**
 * The ordered side-effect to-do list emitted alongside each transition. The
 * host executes them in order; the FSM itself stays pure.
 *
 *   playCue            play the cue preset for the current test.
 *   startTimer:feedback  arm the `feedbackTimeoutMs` (7 s) window.
 *   startTimer:retry     arm the `retryPromptTimeoutMs` (3 s) window.
 *   recordTrial:good     persist the current rep as a GOOD trial.
 *   recordTrial:failed   persist the current rep as a MISS (✗ Fail).
 *   recordTrial:skipped  persist the current rep as NOT-COMPLETED (Skip).
 *   advance              move on to the NEXT test (repIndex advanced in state).
 *   replayCurrent        re-run the SAME test (repIndex unchanged in state).
 *   abandon              end the series early (explicit or guard-rail).
 *   done                 the series is complete (reached `config.repetitions` good).
 */
export type WizardEffect =
  | "playCue"
  | "startTimer:feedback"
  | "startTimer:retry"
  | "recordTrial:good"
  | "recordTrial:failed"
  | "recordTrial:skipped"
  | "advance"
  | "replayCurrent"
  | "abandon"
  | "done";

/** The pure result of one transition: the next state + the effect to-do list. */
export interface StepResult {
  state: WizardState;
  effects: WizardEffect[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Constructors
 * ──────────────────────────────────────────────────────────────────────── */

/** The fresh, pre-START state of a series: idle, nothing recorded. */
export function initialState(): WizardState {
  return { phase: "idle", repIndex: 0, good: 0, silence: 0 };
}

/* ────────────────────────────────────────────────────────────────────────
 * The reducer
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One pure transition. Given the current `state`, an `event` from the host,
 * and the tunable `config` (defaults to WIZARD_DEFAULTS), returns the next
 * state and the ordered effects the host must carry out.
 *
 * TOTAL & SAFE: events that do not apply in the current phase (e.g. SUCCESS
 * while still cueing, or anything once terminal) are no-ops — the same state
 * is returned with no effects. The host can therefore fire stale/late events
 * (a button press that races a timeout) without corrupting the machine.
 */
export function step(
  state: WizardState,
  event: WizardEvent,
  config: WizardConfig = WIZARD_DEFAULTS,
): StepResult {
  switch (state.phase) {
    case "idle":
      // Only START matters before the series begins.
      if (event === "START") {
        // A vacuous series (repetitions <= 0) is already complete: go straight
        // to done, with no cue played and no trial recorded.
        if (config.repetitions <= 0) {
          return { state: { ...state, phase: "done" }, effects: ["done"] };
        }
        return {
          state: { ...state, phase: "cueing" },
          effects: ["playCue"],
        };
      }
      return noop(state);

    case "cueing":
      // The cue is playing; CUE_DONE finishes it. ABANDON is a UNIVERSAL escape:
      // a visible Stop must work here too, so the operator is never wedged while
      // a cue plays / stalls (docs/WIZARD.md UI obligations).
      if (event === "CUE_DONE") {
        return {
          state: { ...state, phase: "feedback" },
          effects: ["startTimer:feedback"],
        };
      }
      if (event === "ABANDON") return abandon(state);
      return noop(state);

    case "feedback":
      switch (event) {
        // ✓ Success within 7 s → record GOOD, advance; silence ← 0.
        case "SUCCESS":
          return advanceAfterGood(state, config);
        // ✗ Fail within 7 s → record the miss, REPLAY the SAME test; silence ← 0
        // (operator manifested — explicitly NO guard-rail tick).
        case "FAIL":
          return replaySameTest(state, ["recordTrial:failed"]);
        // No input at 7 s → escalate to the Abandon / Skip prompt (no silence tick yet).
        case "FEEDBACK_TIMEOUT":
          return {
            state: { ...state, phase: "retryPrompt" },
            effects: ["startTimer:retry"],
          };
        // Universal escape: a visible Stop must work during feedback too.
        case "ABANDON":
          return abandon(state);
        default:
          return noop(state);
      }

    case "retryPrompt":
      switch (event) {
        // Abandon → end the series; this is a manifestation, silence ← 0.
        case "ABANDON":
          return abandon(state);
        // Skip → mark this rep not-completed, move to the next test; silence ← 0.
        case "SKIP":
          return advanceAfterSkip(state, config);
        // No input at 3 s → silence++ and REPLAY the current test, UNLESS this
        // is the guard-rail's final straw (silence reaches `silenceGuard`).
        case "RETRY_TIMEOUT": {
          const silence = state.silence + 1;
          if (silence >= config.silenceGuard) {
            // Guard-rail: too many consecutive silences → auto-abandon.
            return {
              state: { ...state, phase: "abandoned", silence },
              effects: ["abandon"],
            };
          }
          // Re-run the same test hands-free; repIndex unchanged.
          return {
            state: { ...state, phase: "cueing", silence },
            effects: ["replayCurrent", "playCue"],
          };
        }
        default:
          return noop(state);
      }

    // Terminal phases: nothing more happens.
    case "done":
    case "abandoned":
      return noop(state);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Transition helpers (private)
 * ──────────────────────────────────────────────────────────────────────── */

/** A non-transition: same state, no effects. Keeps the reducer total. */
function noop(state: WizardState): StepResult {
  return { state, effects: [] };
}

/** End the series early — a visible Stop / ABANDON from any non-terminal phase. */
function abandon(state: WizardState): StepResult {
  return { state: { ...state, phase: "abandoned", silence: 0 }, effects: ["abandon"] };
}

/**
 * SUCCESS path: record the GOOD trial, reset silence, then either FINISH the
 * series (good count reached `config.repetitions`) or advance to the next test
 * and start cueing it.
 */
function advanceAfterGood(state: WizardState, config: WizardConfig): StepResult {
  const good = state.good + 1;
  if (good >= config.repetitions) {
    // Target met → the series is complete. repIndex is NOT advanced past the
    // last test (`done` is terminal), so we do NOT emit "advance" here — the
    // host keys completion off "done", and the effect list matches the state.
    return {
      state: { ...state, phase: "done", good, silence: 0 },
      effects: ["recordTrial:good", "done"],
    };
  }
  return {
    state: {
      ...state,
      phase: "cueing",
      good,
      repIndex: state.repIndex + 1,
      silence: 0,
    },
    effects: ["recordTrial:good", "advance", "playCue"],
  };
}

/**
 * SKIP path (the Skip button): mark the rep NOT-COMPLETED (recordTrial:skipped —
 * distinct from a ✗ Fail miss, per WIZARD.md), reset silence, advance to the next test.
 * SKIP never increments `good`, so it can never complete the series on its own —
 * only SUCCESS (or the guard / ABANDON) ends it.
 */
function advanceAfterSkip(state: WizardState, _config: WizardConfig): StepResult {
  return {
    state: {
      ...state,
      phase: "cueing",
      repIndex: state.repIndex + 1,
      silence: 0,
    },
    effects: ["recordTrial:skipped", "advance", "playCue"],
  };
}

/**
 * Replay the SAME test (repIndex unchanged) and re-cue it. Used by FAIL (with a
 * `recordTrial:failed` prefix and silence reset) and could be reused elsewhere.
 * On a manifestation-driven replay silence is reset to 0; the only silent
 * replay (RETRY_TIMEOUT) is handled inline in the reducer so it can bump first.
 */
function replaySameTest(state: WizardState, prefix: WizardEffect[]): StepResult {
  return {
    state: { ...state, phase: "cueing", silence: 0 },
    effects: [...prefix, "replayCurrent", "playCue"],
  };
}
