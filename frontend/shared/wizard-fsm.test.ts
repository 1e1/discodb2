// Unit tests for the Wizard PER-TRIAL FEEDBACK finite-state machine (wizard-fsm.ts).
//
// No test framework: Node's built-in `node:test` + `node:assert/strict`, run
// with `node --test --experimental-strip-types` (same tooling as
// protocol.test.ts / analysis/*.test.ts) — zero deps.
//
// SOURCE OF TRUTH: docs/WIZARD.md → "Per-trial feedback (FSM)". Every rule in
// that section gets a pinning test here:
//   - happy path: SUCCESS × repetitions → done.
//   - FAIL (<7 s) → REPLAY the same test, silence stays 0 (NO guard tick).
//   - FEEDBACK_TIMEOUT (no input @7 s) → retryPrompt.
//   - RETRY_TIMEOUT (no input @3 s) → silence++ and REPLAY current.
//   - silence == silenceGuard CONSECUTIVE → auto-abandon.
//   - ANY manifestation resets silence to 0.
//   - SKIP (the Skip button) marks not-completed and ADVANCES (never increments good).
//   - ABANDON ends the series.
// The FSM is PURE: no timers, no DOM — the host feeds *_TIMEOUT events. These
// tests therefore just drive event sequences and assert states/effects/counters.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  step,
  initialState,
  type WizardState,
  type WizardEvent,
  type WizardEffect,
} from "./wizard-fsm.ts";
import { WIZARD_DEFAULTS, type WizardConfig } from "./wizard-config.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** A small config so tests reach `done` / the guard quickly and explicitly. */
const CFG: WizardConfig = {
  ...WIZARD_DEFAULTS,
  repetitions: 3,
  silenceGuard: 5,
};

/**
 * Drive a sequence of events through the machine from a given start state,
 * returning the final state and the FLATTENED list of effects emitted along
 * the way (in order). The reducer is pure, so this is just a fold.
 */
function run(
  start: WizardState,
  events: WizardEvent[],
  config: WizardConfig = CFG,
): { state: WizardState; effects: WizardEffect[] } {
  let state = start;
  const effects: WizardEffect[] = [];
  for (const ev of events) {
    const r = step(state, ev, config);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

/** Reach the `feedback` phase of the first test (START → CUE_DONE). */
function toFeedback(config: WizardConfig = CFG): WizardState {
  return run(initialState(), ["START", "CUE_DONE"], config).state;
}

/* ────────────────────────────────────────────────────────────────────────
 * START / CUE_DONE — the entry into a test
 * ──────────────────────────────────────────────────────────────────────── */

test("START (from idle) → cueing, emits playCue; counters untouched", () => {
  const r = step(initialState(), "START", CFG);
  assert.equal(r.state.phase, "cueing");
  assert.deepEqual(r.effects, ["playCue"]);
  assert.equal(r.state.repIndex, 0);
  assert.equal(r.state.good, 0);
  assert.equal(r.state.silence, 0);
});

test("CUE_DONE (from cueing) → feedback, arms the 7 s feedback timer", () => {
  const cueing = step(initialState(), "START", CFG).state;
  const r = step(cueing, "CUE_DONE", CFG);
  assert.equal(r.state.phase, "feedback");
  assert.deepEqual(r.effects, ["startTimer:feedback"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: SUCCESS (<7 s) → record good, advance to next test; silence ← 0
 * ──────────────────────────────────────────────────────────────────────── */

test("SUCCESS records a good trial, advances repIndex, re-cues; silence ← 0", () => {
  // Pretend some silences accrued earlier to prove SUCCESS resets them.
  const feedback: WizardState = { ...toFeedback(), silence: 2 };
  const r = step(feedback, "SUCCESS", CFG);

  assert.equal(r.state.phase, "cueing"); // straight into the next test's cue
  assert.equal(r.state.good, 1);
  assert.equal(r.state.repIndex, 1); // advanced
  assert.equal(r.state.silence, 0); // reset on manifestation
  assert.deepEqual(r.effects, ["recordTrial:good", "advance", "playCue"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: DONE when good count reaches config.repetitions (happy path to N good)
 * ──────────────────────────────────────────────────────────────────────── */

test("happy path: SUCCESS × repetitions reaches done with the right counts/effects", () => {
  let state = initialState();
  const effects: WizardEffect[] = [];

  state = applyAndCollect(state, "START", effects);
  for (let i = 0; i < CFG.repetitions; i++) {
    state = applyAndCollect(state, "CUE_DONE", effects);
    state = applyAndCollect(state, "SUCCESS", effects);
  }

  assert.equal(state.phase, "done");
  assert.equal(state.good, CFG.repetitions);
  assert.equal(state.silence, 0);

  // The LAST success emits `done` (terminal) with NO `advance`/`playCue` —
  // repIndex is not advanced past the final test, so the effect list matches.
  assert.deepEqual(effects, [
    "playCue", // START
    // rep 0
    "startTimer:feedback",
    "recordTrial:good",
    "advance",
    "playCue",
    // rep 1
    "startTimer:feedback",
    "recordTrial:good",
    "advance",
    "playCue",
    // rep 2 (final → done; no advance, no re-cue)
    "startTimer:feedback",
    "recordTrial:good",
    "done",
  ]);
});

test("the final SUCCESS goes to done (not cueing) and stops re-cueing", () => {
  // Two goods already banked; the third should finish the default-3 series.
  const onePending: WizardState = { phase: "feedback", repIndex: 2, good: 2, silence: 0 };
  const r = step(onePending, "SUCCESS", CFG);
  assert.equal(r.state.phase, "done");
  assert.equal(r.state.good, 3);
  assert.deepEqual(r.effects, ["recordTrial:good", "done"]);
  // done is terminal: further events are no-ops.
  const after = step(r.state, "SUCCESS", CFG);
  assert.equal(after.state.phase, "done");
  assert.deepEqual(after.effects, []);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: FAIL (<7 s) → REPLAY current test; silence ← 0; NO guard tick
 * ──────────────────────────────────────────────────────────────────────── */

test("FAIL replays the SAME test (repIndex unchanged), records failed, NO guard tick", () => {
  const feedback: WizardState = { ...toFeedback(), repIndex: 1, good: 1, silence: 3 };
  const r = step(feedback, "FAIL", CFG);

  assert.equal(r.state.phase, "cueing"); // re-cue the same rep
  assert.equal(r.state.repIndex, 1); // NOT advanced — same test
  assert.equal(r.state.good, 1); // good is untouched by a fail
  assert.equal(r.state.silence, 0); // operator manifested → reset, and crucially not bumped
  assert.deepEqual(r.effects, ["recordTrial:failed", "replayCurrent", "playCue"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: FEEDBACK_TIMEOUT (no input @7 s) → retryPrompt (Abandon / Skip)
 * ──────────────────────────────────────────────────────────────────────── */

test("FEEDBACK_TIMEOUT escalates to retryPrompt, arms the 3 s retry timer; silence not yet ticked", () => {
  const feedback: WizardState = { ...toFeedback(), silence: 1 };
  const r = step(feedback, "FEEDBACK_TIMEOUT", CFG);

  assert.equal(r.state.phase, "retryPrompt");
  assert.deepEqual(r.effects, ["startTimer:retry"]);
  assert.equal(r.state.silence, 1); // the feedback timeout itself does NOT tick the guard
  assert.equal(r.state.repIndex, feedback.repIndex); // still the same test
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule (retryPrompt): RETRY_TIMEOUT (no input @3 s) → silence++ and REPLAY current
 * ──────────────────────────────────────────────────────────────────────── */

test("RETRY_TIMEOUT bumps silence and replays the current test (repIndex unchanged)", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 2, good: 1, silence: 1 };
  const r = step(retry, "RETRY_TIMEOUT", CFG);

  assert.equal(r.state.phase, "cueing"); // hands-free re-run
  assert.equal(r.state.silence, 2); // ++
  assert.equal(r.state.repIndex, 2); // same test
  assert.equal(r.state.good, 1); // unchanged
  assert.deepEqual(r.effects, ["replayCurrent", "playCue"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: silence == silenceGuard CONSECUTIVE → auto-abandon
 * ──────────────────────────────────────────────────────────────────────── */

test("silenceGuard: the silenceGuard-th consecutive RETRY_TIMEOUT auto-abandons", () => {
  // Drive the full guard loop from a fresh feedback phase using only timeouts.
  // Each round: FEEDBACK_TIMEOUT → retryPrompt → RETRY_TIMEOUT (silence++ + replay)
  // → CUE_DONE → feedback. The silenceGuard-th RETRY_TIMEOUT must abandon.
  let state = toFeedback();
  const effects: WizardEffect[] = [];

  for (let i = 1; i <= CFG.silenceGuard; i++) {
    state = applyAndCollect(state, "FEEDBACK_TIMEOUT", effects);
    assert.equal(state.phase, "retryPrompt");
    state = applyAndCollect(state, "RETRY_TIMEOUT", effects);

    if (i < CFG.silenceGuard) {
      // Not yet the guard: silence bumped, replaying.
      assert.equal(state.phase, "cueing", `round ${i} should replay`);
      assert.equal(state.silence, i, `round ${i} silence`);
      state = applyAndCollect(state, "CUE_DONE", effects); // host finishes the re-cue
      assert.equal(state.phase, "feedback");
    } else {
      // The guard-rail straw: auto-abandon.
      assert.equal(state.phase, "abandoned", "guard round should abandon");
      assert.equal(state.silence, CFG.silenceGuard);
    }
  }

  // The abandon emits exactly one `abandon` effect (and never a `done`).
  assert.equal(effects.filter((e) => e === "abandon").length, 1);
  assert.equal(effects.includes("done"), false);
  // abandoned is terminal.
  const after = step(state, "RETRY_TIMEOUT", CFG);
  assert.equal(after.state.phase, "abandoned");
  assert.deepEqual(after.effects, []);
});

test("silenceGuard honors a custom config value (guard = 2)", () => {
  const cfg2: WizardConfig = { ...CFG, silenceGuard: 2 };
  // First silence → replay; second silence → abandon.
  const retry1: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: 0 };
  const a = step(retry1, "RETRY_TIMEOUT", cfg2);
  assert.equal(a.state.phase, "cueing");
  assert.equal(a.state.silence, 1);
  assert.deepEqual(a.effects, ["replayCurrent", "playCue"]);

  const retry2: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: 1 };
  const b = step(retry2, "RETRY_TIMEOUT", cfg2);
  assert.equal(b.state.phase, "abandoned");
  assert.equal(b.state.silence, 2);
  assert.deepEqual(b.effects, ["abandon"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule: ANY manifestation resets silence to 0
 * ──────────────────────────────────────────────────────────────────────── */

test("reset-on-manifestation: a SUCCESS after several silences clears the guard counter", () => {
  // Accumulate silenceGuard-1 silences (one short of the guard), then succeed.
  let state = toFeedback();
  for (let i = 1; i < CFG.silenceGuard; i++) {
    state = step(state, "FEEDBACK_TIMEOUT", CFG).state;
    state = step(state, "RETRY_TIMEOUT", CFG).state; // silence++ + replay
    state = step(state, "CUE_DONE", CFG).state; // back to feedback
  }
  assert.equal(state.silence, CFG.silenceGuard - 1);
  assert.equal(state.phase, "feedback");

  // A manifestation (SUCCESS) must zero the silence counter.
  const r = step(state, "SUCCESS", CFG);
  assert.equal(r.state.silence, 0);
  // …and a subsequent lone RETRY_TIMEOUT no longer trips the guard.
  const t = run(r.state, ["CUE_DONE", "FEEDBACK_TIMEOUT", "RETRY_TIMEOUT"], CFG);
  assert.equal(t.state.phase, "cueing"); // replayed, not abandoned
  assert.equal(t.state.silence, 1);
});

test("reset-on-manifestation: FAIL clears silence WITHOUT bumping it (no guard tick)", () => {
  const feedback: WizardState = { ...toFeedback(), silence: CFG.silenceGuard - 1 };
  const r = step(feedback, "FAIL", CFG);
  assert.equal(r.state.silence, 0);
  assert.equal(r.state.phase, "cueing");
});

test("reset-on-manifestation: SKIP and ABANDON both clear silence", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: CFG.silenceGuard - 1 };
  const skipped = step(retry, "SKIP", CFG);
  assert.equal(skipped.state.silence, 0);
  const abandoned = step(retry, "ABANDON", CFG);
  assert.equal(abandoned.state.silence, 0);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule (retryPrompt): SKIP (the Skip button) → mark not-completed, ADVANCE (no good++)
 * ──────────────────────────────────────────────────────────────────────── */

test("SKIP marks not-completed, advances to the next test, never increments good", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 1, good: 1, silence: 4 };
  const r = step(retry, "SKIP", CFG);

  assert.equal(r.state.phase, "cueing"); // straight into the next test
  assert.equal(r.state.repIndex, 2); // advanced
  assert.equal(r.state.good, 1); // NOT incremented — skip is not a good trial
  assert.equal(r.state.silence, 0); // manifestation → reset
  assert.deepEqual(r.effects, ["recordTrial:skipped", "advance", "playCue"]);
});

test("SKIP alone never reaches done (good count gates completion)", () => {
  // Even skipping past `repetitions` tests never completes the series; only good
  // trials (or ABANDON / the guard) end it.
  let state: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: 0 };
  for (let i = 0; i < CFG.repetitions + 2; i++) {
    const r = step(state, "SKIP", CFG);
    assert.notEqual(r.state.phase, "done");
    // back to retryPrompt via the timeout path for the next skip
    state = run(r.state, ["CUE_DONE", "FEEDBACK_TIMEOUT"], CFG).state;
    assert.equal(state.phase, "retryPrompt");
  }
  assert.equal(state.good, 0);
});

/* ────────────────────────────────────────────────────────────────────────
 * Rule (retryPrompt): ABANDON → end the series
 * ──────────────────────────────────────────────────────────────────────── */

test("ABANDON ends the series (terminal abandoned), emits abandon, never done", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 1, good: 1, silence: 0 };
  const r = step(retry, "ABANDON", CFG);

  assert.equal(r.state.phase, "abandoned");
  assert.deepEqual(r.effects, ["abandon"]);
  assert.equal(r.state.good, 1); // banked goods are preserved on the way out

  // terminal: further events are no-ops.
  for (const ev of ["SUCCESS", "FAIL", "RETRY_TIMEOUT", "SKIP", "START"] as WizardEvent[]) {
    const after = step(r.state, ev, CFG);
    assert.equal(after.state.phase, "abandoned");
    assert.deepEqual(after.effects, []);
  }
});

test("ABANDON is a universal escape: it ends the series from cueing and feedback too", () => {
  const cueing = step(initialState(), "START", CFG).state;
  const a = step(cueing, "ABANDON", CFG);
  assert.equal(a.state.phase, "abandoned");
  assert.deepEqual(a.effects, ["abandon"]);

  const fb = step(toFeedback(), "ABANDON", CFG);
  assert.equal(fb.state.phase, "abandoned");
  assert.deepEqual(fb.effects, ["abandon"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Purity / totality: stale or out-of-phase events are safe no-ops
 * ──────────────────────────────────────────────────────────────────────── */

test("out-of-phase events are no-ops (button press racing a phase change is safe)", () => {
  // SUCCESS while cueing (cue not done yet) is ignored.
  const cueing = step(initialState(), "START", CFG).state;
  const a = step(cueing, "SUCCESS", CFG);
  assert.equal(a.state.phase, "cueing");
  assert.deepEqual(a.effects, []);

  // RETRY_TIMEOUT while in feedback (stale 3 s timer) is ignored.
  const b = step(toFeedback(), "RETRY_TIMEOUT", CFG);
  assert.equal(b.state.phase, "feedback");
  assert.deepEqual(b.effects, []);

  // (ABANDON is a UNIVERSAL escape now — exercised in its own test below.)

  // CUE_DONE in retryPrompt is ignored.
  const retry: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: 0 };
  const d = step(retry, "CUE_DONE", CFG);
  assert.equal(d.state.phase, "retryPrompt");
  assert.deepEqual(d.effects, []);

  // START once already running is ignored.
  const e = step(cueing, "START", CFG);
  assert.equal(e.state.phase, "cueing");
  assert.deepEqual(e.effects, []);
});

test("step is pure: it does not mutate the input state object", () => {
  const before: WizardState = { phase: "feedback", repIndex: 1, good: 1, silence: 2 };
  const snapshot = { ...before };
  const r = step(before, "SUCCESS", CFG);
  // input untouched…
  assert.deepEqual(before, snapshot);
  // …and a fresh object was returned.
  assert.notEqual(r.state, before);
});

test("step defaults to WIZARD_DEFAULTS when no config is passed", () => {
  // With the defaults (repetitions = 3) a single SUCCESS should NOT finish.
  const feedback: WizardState = { phase: "feedback", repIndex: 0, good: 0, silence: 0 };
  const r = step(feedback, "SUCCESS"); // no config arg
  assert.equal(r.state.phase, "cueing");
  assert.equal(r.state.good, 1);
  assert.equal(WIZARD_DEFAULTS.repetitions, 3);
});

test("repetitions <= 0: START goes straight to done (no cue, no recorded trial)", () => {
  const r = step(initialState(), "START", { ...CFG, repetitions: 0 });
  assert.equal(r.state.phase, "done");
  assert.deepEqual(r.effects, ["done"]); // no playCue, no recordTrial
  assert.equal(r.state.good, 0);
});

test("retryPrompt: a racing SUCCESS or FAIL is a no-op (only ABANDON/SKIP/RETRY_TIMEOUT apply)", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 1, good: 1, silence: 2 };
  for (const ev of ["SUCCESS", "FAIL"] as WizardEvent[]) {
    const r = step(retry, ev, CFG);
    assert.equal(r.state.phase, "retryPrompt", `${ev} ignored in retryPrompt`);
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.silence, 2); // untouched
  }
});

test("silenceGuard = 1: the first RETRY_TIMEOUT abandons immediately", () => {
  const retry: WizardState = { phase: "retryPrompt", repIndex: 0, good: 0, silence: 0 };
  const r = step(retry, "RETRY_TIMEOUT", { ...CFG, silenceGuard: 1 });
  assert.equal(r.state.phase, "abandoned");
  assert.equal(r.state.silence, 1);
  assert.deepEqual(r.effects, ["abandon"]);
});

/* ────────────────────────────────────────────────────────────────────────
 * Local fold helper (kept after the tests that use it for readability)
 * ──────────────────────────────────────────────────────────────────────── */

/** Apply one event, push its effects onto `sink`, return the next state. */
function applyAndCollect(
  state: WizardState,
  event: WizardEvent,
  sink: WizardEffect[],
  config: WizardConfig = CFG,
): WizardState {
  const r = step(state, event, config);
  sink.push(...r.effects);
  return r.state;
}
