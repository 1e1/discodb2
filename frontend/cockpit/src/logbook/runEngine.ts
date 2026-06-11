/**
 * LOGBOOK run engine — the storyboard EXECUTOR's pure state machine.
 *
 * Drives a scenario's phases (from `scenarioPhases`) and STAMPS the executed,
 * timestamped windows that become the analyzer's labels (see
 * shared/analysis/logbook.ts). A TIMER phase runs its `durationS` then
 * auto-advances; an "on input" phase carries NO duration — it AWAITS the operator's
 * confirmation (Next/Space) from the moment it is ENTERED. Actions take variable
 * time, so the recorded input window is the ACTUAL one (entry → confirm), not a
 * planned one. (`awaitingInput` therefore flips true on entry for an input phase.)
 *
 * This module is PURE LOGIC: it is driven by `tick(nowTUs)` + `confirm(nowTUs)` on
 * the backend µs clock, with NO timers, audio, or DOM. The cockpit run UI wires
 * real timers + the audio cues to these calls and renders `state()`; the Copilot
 * reads the same state. That keeps the transitions / window stamping unit-testable
 * and lets the (separate) run UI stay a thin shell.
 *
 * The completed/aborted run's `windows` feed the analysis seam
 * (logbook/analysis.ts → analyzeRun). A partial run (stopped) still yields valid
 * labels for whatever was captured.
 */

import { scenarioPhases, type LogbookScenario, type LogbookRunPhase } from '../protocol/datamodel';
import type { RunWindow } from '@shared/analysis/logbook.ts';

export type RunStatus = 'idle' | 'running' | 'done' | 'stopped';

export interface RunState {
  status: RunStatus;
  /** Index into the expanded phase list, or -1 when idle/done. */
  phaseIndex: number;
  /** The current phase, or null when not running. */
  phase: LogbookRunPhase | null;
  /** Seconds elapsed within the current phase. */
  elapsedS: number;
  /** True when the current phase is "on input" and waiting for the operator. */
  awaitingInput: boolean;
  /** Windows stamped so far (one per phase that has STARTED), newest last. */
  windows: RunWindow[];
}

export interface RunEngine {
  state(): RunState;
  /** Begin the run at `nowTUs` (enters phase 0 = baseline). */
  start(nowTUs: number): void;
  /** Advance the clock to `nowTUs`; a timer phase auto-advances when its time is up. */
  tick(nowTUs: number): void;
  /** Operator confirmation — advances an "on input" phase (no-op otherwise). */
  confirm(nowTUs: number): void;
  /** Abort: close the current window at `nowTUs` and stop. */
  stop(nowTUs: number): void;
  /** The run as the analyzer's input: the stamped windows + how to read the stimulus. */
  result(): { windows: RunWindow[]; stimulusKind: 'event' | 'trend' };
}

/** Create a run engine for a scenario. State starts idle until `start`. */
export function createRunEngine(scenario: LogbookScenario): RunEngine {
  const phases = scenarioPhases(scenario);
  const stimulusKind: 'event' | 'trend' = scenario.expectedType === 'trend' ? 'trend' : 'event';

  let status: RunStatus = 'idle';
  let phaseIndex = -1;
  let phaseStartTUs = 0;
  let nowTUsLast = 0;
  const windows: RunWindow[] = [];

  const cur = (): LogbookRunPhase | null =>
    status === 'running' && phaseIndex >= 0 && phaseIndex < phases.length ? phases[phaseIndex] : null;

  // An input phase carries NO duration: it awaits the operator from ENTRY (Next
  // appears immediately, and the run holds until confirm). Its `durationS` is
  // ignored for execution — the recorded window is the actual entry→confirm span.
  const awaiting = (): boolean => {
    const p = cur();
    return !!p && p.advance === 'input';
  };

  /** Close the current phase's window at `endTUs` (stamp it). */
  function stamp(endTUs: number): void {
    const p = phases[phaseIndex];
    if (!p) return;
    windows.push({ role: p.type, startTUs: phaseStartTUs, endTUs, rep: p.rep });
  }

  /**
   * Advance to the next phase, closing the current one at `endTUs` (its stamped
   * end AND the next phase's start). A timer phase passes its SCHEDULED boundary
   * (`start + duration`) so chained fast-forwards don't drift; confirm/stop pass
   * the actual `nowTUs`.
   */
  function advance(endTUs: number): void {
    stamp(endTUs);
    phaseIndex += 1;
    phaseStartTUs = endTUs;
    if (phaseIndex >= phases.length) {
      status = 'done';
      phaseIndex = -1;
    }
  }

  return {
    state(): RunState {
      const p = cur();
      return {
        status,
        phaseIndex: status === 'running' ? phaseIndex : -1,
        phase: p,
        elapsedS: p ? Math.max(0, (nowTUsLast - phaseStartTUs) / 1e6) : 0,
        awaitingInput: awaiting(),
        windows: [...windows],
      };
    },
    start(nowTUs: number): void {
      windows.length = 0;
      status = 'running';
      phaseIndex = 0;
      phaseStartTUs = nowTUs;
      nowTUsLast = nowTUs;
    },
    tick(nowTUs: number): void {
      nowTUsLast = nowTUs;
      if (status !== 'running') return;
      // A timer phase may close and the next may too within one tick (fast-forward
      // or a long gap): loop until the current phase isn't yet due.
      let guard = phases.length + 1;
      while (status === 'running' && guard-- > 0) {
        const p = phases[phaseIndex];
        if (!p) break;
        if (p.advance === 'input') break; // input phase → AWAIT from entry (no duration)
        const endTUs = phaseStartTUs + p.durationS * 1e6;
        if (nowTUs < endTUs) break; // timer phase still running its duration window
        advance(endTUs); // timer → auto-advance at its scheduled boundary
      }
    },
    confirm(nowTUs: number): void {
      nowTUsLast = nowTUs;
      if (status === 'running' && awaiting()) advance(nowTUs);
    },
    stop(nowTUs: number): void {
      nowTUsLast = nowTUs;
      if (status === 'running') {
        stamp(nowTUs); // keep the partial window — still a valid label
        status = 'stopped';
        phaseIndex = -1;
      }
    },
    result() {
      return { windows: [...windows], stimulusKind };
    },
  };
}
