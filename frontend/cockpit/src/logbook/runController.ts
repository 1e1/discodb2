/**
 * LOGBOOK run CONTROLLER — the thin shell that drives the pure run engine
 * (runEngine.ts) with REAL timers + the audio cues, and exposes Svelte stores the
 * Run UI renders. All the transition logic / window stamping is in the engine; this
 * adds only the wall-clock loop, the lead-in, the audio, and the analysis call.
 *
 * RUN CLOCK: the operator experiences wall time, but the windows must be stamped in
 * the FRAME clock (backend µs) so the worker can slice its ring. We anchor at the
 * latest frame time captured at run start and add the wall delta — smooth like wall
 * time, aligned to the frame domain. (On an idle/disconnected bus there are simply
 * no frames to analyze; the run still progresses for rehearsal.)
 */

import { writable, get, type Readable } from 'svelte/store';
import { createRunEngine, type RunEngine } from './runEngine';
import { analyzeLogbookRun, type LogbookAnalysis } from './analysis';
import { createLogbookAudio, type LogbookAudio, type SonifVoice } from './audio';
import { scenarioPhases, type LogbookScenario, type LogbookRunPhase } from '../protocol/datamodel';
import { maxTUs, project, excludedSlots } from '../state/store';
import type { RunWindow } from '@shared/analysis/logbook.ts';

export type RunUiStatus = 'idle' | 'armed' | 'leadin' | 'running' | 'done' | 'stopped';

export interface RunUiState {
  status: RunUiStatus;
  /** 3..1 during the lead-in, else 0. */
  leadIn: number;
  phase: LogbookRunPhase | null;
  phaseIndex: number;
  totalPhases: number;
  elapsedS: number;
  /** Seconds left for a TIMER phase (0 for an "on input" phase). */
  remainingS: number;
  awaitingInput: boolean;
  rep: number;
  /** Name of the upcoming phase (or 'finish'). */
  nextLabel: string;
  windows: RunWindow[];
}

const IDLE: RunUiState = {
  status: 'idle', leadIn: 0, phase: null, phaseIndex: -1, totalPhases: 0,
  elapsedS: 0, remainingS: 0, awaitingInput: false, rep: 0, nextLabel: '', windows: [],
};

export interface RunController {
  state: Readable<RunUiState>;
  result: Readable<LogbookAnalysis | null>;
  analyzing: Readable<boolean>;
  audio: LogbookAudio;
  /** Load a scenario and arm the run (status 'armed'); does not start the clock. */
  arm(scenario: LogbookScenario): void;
  /** Begin: a 3·2·1 lead-in, then the run clock starts. */
  start(): void;
  /** Operator confirmation of an "on input" phase (Next / Space). */
  next(): void;
  /** Abort: stamp the partial window and analyze what was captured. */
  stop(): void;
  /** Tear down timers + audio (component teardown). */
  dispose(): void;
}

/** A variable 8–12 s gap between awaiting-input cues — variability defeats habituation. */
const awaitGap = (): number => 8000 + Math.random() * 4000;

/**
 * Map a phase to its sonification VOICE (the per-phase audio treatment): the noise
 * floor → 'noise'; any "on input" phase → 'awaiting'; a stimulus → 'stimulus';
 * everything else (baseline / wait / observe / recover) → the calm 'observe' bed.
 */
const voiceFor = (p: LogbookRunPhase): SonifVoice =>
  p.type === 'noise' ? 'noise' : p.advance === 'input' ? 'awaiting' : p.type === 'stimulus' ? 'stimulus' : 'observe';

export function createRunController(): RunController {
  const state = writable<RunUiState>({ ...IDLE });
  const result = writable<LogbookAnalysis | null>(null);
  const analyzing = writable(false);
  const audio = createLogbookAudio();

  let engine: RunEngine | null = null;
  let scenario: LogbookScenario | null = null;
  let phases: LogbookRunPhase[] = [];

  let mainTimer: ReturnType<typeof setInterval> | null = null;
  let leadTimer: ReturnType<typeof setInterval> | null = null;

  let baseTUs = 0;
  let baseWall = 0;
  const nowTUs = (): number => baseTUs + (performance.now() - baseWall) * 1000;

  // transition trackers (reset per run / per phase)
  let lastIndex = -1;
  let lastCountdownSec = 99;
  let nextAwaitAt = 0;
  let wasAwaiting = false; // edge detector: fire the await double-beep at duration-end
  let finished = false;

  function clearTimers(): void {
    if (mainTimer) { clearInterval(mainTimer); mainTimer = null; }
    if (leadTimer) { clearInterval(leadTimer); leadTimer = null; }
  }

  function publish(extra: Partial<RunUiState> = {}): void {
    if (!engine) { state.set({ ...IDLE, ...extra }); return; }
    const st = engine.state();
    const phase = st.phase;
    // Seconds-left for a TIMER phase (the HUD/timeline render "on input" phases as
    // a pulsing ◉ with no duration, so their countdown is never shown).
    const remainingS = phase && !st.awaitingInput ? Math.max(0, phase.durationS - st.elapsedS) : 0;
    const idx = st.phaseIndex;
    const next = idx >= 0 && idx + 1 < phases.length ? phases[idx + 1].name : 'finish';
    state.set({
      status: st.status as RunUiStatus,
      leadIn: 0,
      phase,
      phaseIndex: idx,
      totalPhases: phases.length,
      elapsedS: st.elapsedS,
      remainingS,
      awaitingInput: st.awaitingInput,
      rep: phase?.rep ?? 0,
      nextLabel: next,
      windows: st.windows,
      ...extra,
    });
  }

  /** Fire the audio cues for whatever the engine state just became. */
  function cues(st: ReturnType<RunEngine['state']>): void {
    if (st.status !== 'running') return;
    const phase = st.phase;
    if (st.phaseIndex !== lastIndex) {
      lastIndex = st.phaseIndex;
      lastCountdownSec = 99;
      if (phase) {
        // EVERY phase entry gets the transition tone (phase 0 is the exception:
        // beginRun seeds lastIndex = 0, so the opening CONNECT chirp stands in for
        // it), PLUS the per-phase sonification voice so the operator hears which
        // phase they are in.
        audio.transition();
        audio.setVoice(voiceFor(phase));
      }
    }
    // Last-2s countdown — TIMER phases only (an "on input" phase carries no
    // duration in the UI model: it pulses ◉ and awaits, with no countdown).
    if (phase && phase.advance !== 'input') {
      const remaining = phase.durationS - st.elapsedS;
      const sec = Math.ceil(remaining);
      if (remaining > 0 && remaining <= 2 && sec < lastCountdownSec) { audio.countdown(); lastCountdownSec = sec; }
    }
    // Await double-beep on the false→true EDGE (the duration-end, when the UI starts
    // waiting for Next); then sparse, irregular reminders nudge thereafter.
    if (st.awaitingInput && !wasAwaiting) {
      audio.awaitBeep();
      nextAwaitAt = performance.now() + awaitGap();
    } else if (st.awaitingInput && performance.now() >= nextAwaitAt) {
      audio.awaitBeep();
      nextAwaitAt = performance.now() + awaitGap();
    }
    wasAwaiting = st.awaitingInput;
  }

  function loop(): void {
    if (!engine) return;
    engine.tick(nowTUs());
    const st = engine.state();
    cues(st);
    publish();
    if (st.status === 'done') finish('done');
  }

  function beginRun(): void {
    if (!engine) return;
    if (mainTimer) { clearInterval(mainTimer); mainTimer = null; } // defensive: never two loops
    baseTUs = get(maxTUs);
    baseWall = performance.now();
    finished = false;
    lastIndex = 0; // baseline entry is the CONNECT chirp, not a transition cue
    lastCountdownSec = 99;
    wasAwaiting = false;
    result.set(null);
    engine.start(nowTUs());
    audio.connect(); // CONNECT (C5→G5) — the very first run sound
    mainTimer = setInterval(loop, 100);
    publish({ status: 'running' });
  }

  function finish(status: 'done' | 'stopped'): void {
    if (finished) return;
    finished = true;
    clearTimers();
    audio.setVoice(null);
    if (status === 'done') audio.disconnect(); // DISCONNECT (G5→C5) — the very last run sound
    if (!engine) return;
    const run = engine.result();
    analyzing.set(true);
    const excluded = excludedSlots(get(project));
    analyzeLogbookRun(run, { excluded })
      .then((r) => result.set(r))
      .catch(() => result.set({ mode: 'none', candidates: [], framesAnalyzed: 0, note: 'analysis failed', hardened: false }))
      .finally(() => analyzing.set(false));
    // Reflect the terminal status (loop already published 'done'; stop publishes 'stopped').
    if (status === 'stopped') publish({ status: 'stopped' });
  }

  return {
    state, result, analyzing, audio,
    arm(s: LogbookScenario) {
      clearTimers();
      audio.setVoice(null);
      scenario = s;
      engine = createRunEngine(s);
      phases = scenarioPhases(s);
      finished = false;
      lastIndex = -1; lastCountdownSec = 99; wasAwaiting = false;
      result.set(null);
      publish({ status: 'armed', phase: null, phaseIndex: -1, leadIn: 0 });
    },
    start() {
      if (!scenario) return;
      clearTimers();
      audio.setVoice(null);
      // fresh engine so a re-run starts clean
      engine = createRunEngine(scenario);
      phases = scenarioPhases(scenario);
      finished = false;
      result.set(null);
      let n = 3;
      audio.leadIn();
      publish({ status: 'leadin', leadIn: n, phase: null, phaseIndex: -1 });
      leadTimer = setInterval(() => {
        n -= 1;
        if (n >= 1) { audio.leadIn(); publish({ status: 'leadin', leadIn: n, phase: null, phaseIndex: -1 }); }
        else { if (leadTimer) { clearInterval(leadTimer); leadTimer = null; } beginRun(); }
      }, 1000);
    },
    next() {
      if (!engine) return;
      engine.confirm(nowTUs());
      const st = engine.state();
      cues(st);
      publish();
      if (st.status === 'done') finish('done');
    },
    stop() {
      if (!engine) return;
      clearTimers();
      audio.setVoice(null);
      engine.stop(nowTUs());
      publish({ status: 'stopped' });
      finish('stopped');
    },
    dispose() {
      clearTimers();
      audio.dispose();
    },
  };
}
