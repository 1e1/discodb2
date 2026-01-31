/**
 * Wizard HOST runtime (cockpit) — DESIGN §9 + docs/WIZARD.md "Distributed
 * execution" / "Per-trial feedback (FSM)" / "UI obligations".
 *
 * The cockpit is the HOST: it holds the buffer + analysis and DRIVES the
 * per-trial feedback loop with REAL wall-clock timers, plays the cue, and relays
 * its state to viewers. The decision logic itself is the SHARED, pure reducer
 * (frontend/shared/wizard-fsm.ts): `step(state, event, config)`. This class is
 * the host the FSM's docstring describes — it owns the timers, the audio, the
 * trial ledger, and the control-channel relay; the reducer stays pure.
 *
 * It is the host's job (the FSM is logic-only) to honour the WIZARD.md "UI
 * obligations". Those that are HOST responsibilities live here:
 *   • Cue watchdog: the `cueing` phase only escapes on CUE_DONE; we arm a timer
 *     at cueTotalMs (+ margin) that synthesizes CUE_DONE so an audio stall can
 *     never wedge the operator. (A visible STOP control is exposed via abandon().)
 *   • Real timers feed the *_TIMEOUT events: feedbackTimeoutMs -> FEEDBACK_TIMEOUT,
 *     retryPromptTimeoutMs -> RETRY_TIMEOUT.
 *   • Abandon reason from state: silence === silenceGuard ⇒ guard-rail, else
 *     explicit ABANDON — surfaced in the snapshot for honest copy.
 *   • Progress from state + the recordTrial:* stream (NOT the `advance` effect):
 *     the trial ledger below counts good/failed/skipped from the effects.
 *   • Re-entry by reinstantiation: start() always begins from initialState().
 *
 * The remaining obligations (a11y SUCCESS-only default, FAIL a smaller control,
 * silence countdown, big feedback request) are the panel's and live in the UI.
 */

import {
  step,
  initialState,
  type WizardState,
  type WizardEvent,
  type WizardEffect,
} from '@shared/wizard-fsm.ts';
import { WIZARD_DEFAULTS, type WizardConfig } from '@shared/wizard-config.ts';
import { cueTotalMs, CUE_PRESETS, playCue, ensureAudioReady, type CueMode } from './cuePlayer';

/** One persisted trial outcome, the honest "N good / M total" corpus. */
export type TrialOutcome = 'good' | 'failed' | 'skipped';

export interface TrialRecord {
  /** 0-based test index this outcome belongs to. */
  repIndex: number;
  outcome: TrialOutcome;
}

/** Why a series ended early, derived from FSM state (WIZARD.md "Abandon reason"). */
export type AbandonReason = 'guard' | 'explicit' | null;

/**
 * The host's full view, published to subscribers (the panel) and — in a compact
 * form — relayed to viewers as a {type:"wizard"} control message.
 */
export interface WizardHostState {
  /** Whether a series is active (idle/done/abandoned with a target signal). */
  active: boolean;
  /** The pure FSM state. */
  fsm: WizardState;
  /** Config in force (timeouts, repetitions, silenceGuard). */
  config: WizardConfig;
  /** Cue mode for this signal ("during" = act while the low tone plays). */
  cueMode: CueMode;
  /** Human label of the signal/target under test. */
  target: string;
  /** Persisted trial outcomes so far (drives progress, honest counts). */
  ledger: TrialRecord[];
  /** Good trials confirmed (mirror of fsm.good; convenience for the UI). */
  good: number;
  /** Failed (✗ Fail) trials — distinct from skipped. */
  failed: number;
  /** Skipped (SKIP) trials — not-completed, distinct from failed. */
  skipped: number;
  /** Target good count for completion. */
  target_reps: number;
  /** Set on terminal `abandoned`: guard-rail vs explicit. */
  abandonReason: AbandonReason;
}

type Listener = (s: WizardHostState) => void;

export interface WizardHostOptions {
  config?: WizardConfig;
  /** Called on every transition with a compact snapshot to relay to viewers. */
  onRelay?: (payload: WizardRelayPayload) => void;
}

/** The compact opaque payload relayed to viewers (docs/WIZARD.md contract). */
export interface WizardRelayPayload {
  type: 'wizard';
  phase: WizardState['phase'];
  repIndex: number;
  good: number;
  target: number;
  silence: number;
  silenceGuard: number;
  cueMode: CueMode;
  label: string;
  abandonReason: AbandonReason;
}

/** Margin past cueTotalMs before the watchdog force-fires CUE_DONE. */
const CUE_WATCHDOG_MARGIN_MS = 500;

export class WizardHost {
  private state: WizardState = initialState();
  private config: WizardConfig;
  private cueMode: CueMode = 'during';
  private target = '';
  private ledger: TrialRecord[] = [];
  private abandonReason: AbandonReason = null;
  private active = false;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private cueWatchdog: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Set<Listener>();
  private readonly onRelay?: (p: WizardRelayPayload) => void;

  constructor(opts: WizardHostOptions = {}) {
    this.config = opts.config ?? WIZARD_DEFAULTS;
    this.onRelay = opts.onRelay;
  }

  /* ── Svelte-store contract: subscribe(fn) -> unsubscribe ─────────────────── */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /** Current immutable snapshot (also what subscribers receive). */
  snapshot(): WizardHostState {
    let failed = 0;
    let skipped = 0;
    for (const t of this.ledger) {
      if (t.outcome === 'failed') failed++;
      else if (t.outcome === 'skipped') skipped++;
    }
    return {
      active: this.active,
      fsm: this.state,
      config: this.config,
      cueMode: this.cueMode,
      target: this.target,
      ledger: this.ledger.slice(),
      good: this.state.good,
      failed,
      skipped,
      target_reps: this.config.repetitions,
      abandonReason: this.abandonReason,
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
    this.relay();
  }

  private relay(): void {
    this.onRelay?.({
      type: 'wizard',
      phase: this.state.phase,
      repIndex: this.state.repIndex,
      good: this.state.good,
      target: this.config.repetitions,
      silence: this.state.silence,
      silenceGuard: this.config.silenceGuard,
      cueMode: this.cueMode,
      label: this.target,
      abandonReason: this.abandonReason,
    });
  }

  /* ── lifecycle ───────────────────────────────────────────────────────────── */

  /**
   * Begin a FRESH series for `target` (WIZARD.md "Re-entry by reinstantiation":
   * always a new initialState). `cueMode` picks the cue preset; `config` lets
   * the caller override repetitions/timeouts for this run.
   */
  start(target: string, cueMode: CueMode = 'during', config?: WizardConfig): void {
    this.clearTimers();
    this.state = initialState();
    this.config = config ?? this.config;
    this.cueMode = cueMode;
    this.target = target;
    this.ledger = [];
    this.abandonReason = null;
    this.active = true;
    // Resume audio under the user gesture that called start().
    void ensureAudioReady();
    this.dispatch('START');
  }

  /** Operator pressed ✓ Success (a11y default; Enter/Space map here). */
  success(): void {
    this.dispatch('SUCCESS');
  }
  /** Operator pressed ✗ Fail (smaller, deliberate control). */
  fail(): void {
    this.dispatch('FAIL');
  }
  /** ABANDON in the retry prompt — also the visible cue-watchdog stop. */
  abandon(): void {
    this.dispatch('ABANDON');
  }
  /** SKIP in the retry prompt (mark this rep not-completed). */
  skip(): void {
    this.dispatch('SKIP');
  }

  /** Stop & reset to idle without recording (panel close / new target). */
  reset(): void {
    this.clearTimers();
    this.state = initialState();
    this.ledger = [];
    this.abandonReason = null;
    this.active = false;
    this.emit();
  }

  destroy(): void {
    this.clearTimers();
    this.listeners.clear();
  }

  /* ── the dispatch core: pure reducer + impure effects ────────────────────── */

  /**
   * Feed one event to the pure reducer, apply the resulting effects (timers,
   * audio, ledger, relay), then publish. Total/safe: a stale event in the wrong
   * phase is a no-op in the reducer, so racing a button against a timeout is
   * harmless (the reducer returns the same state with no effects).
   */
  private dispatch(event: WizardEvent): void {
    const before = this.state;
    const { state, effects } = step(before, event, this.config);
    this.state = state;

    // A button manifestation cancels the timer that was waiting for it; a
    // *_TIMEOUT fired because its own timer already elapsed. Clearing the
    // generic timer before re-arming keeps exactly one feedback/retry timer live.
    if (event !== 'FEEDBACK_TIMEOUT' && event !== 'RETRY_TIMEOUT' && event !== 'CUE_DONE') {
      this.clearTimer();
    }

    for (const eff of effects) this.applyEffect(eff);

    // Terminal: capture the honest abandon reason from state (WIZARD.md).
    if (state.phase === 'abandoned') {
      this.abandonReason = state.silence >= this.config.silenceGuard ? 'guard' : 'explicit';
    }
    if (state.phase === 'done' || state.phase === 'abandoned') {
      this.clearTimers();
    }

    this.emit();
  }

  private applyEffect(eff: WizardEffect): void {
    switch (eff) {
      case 'playCue':
        this.armCue();
        break;
      case 'startTimer:feedback':
        this.armTimer(this.config.feedbackTimeoutMs, 'FEEDBACK_TIMEOUT');
        break;
      case 'startTimer:retry':
        this.armTimer(this.config.retryPromptTimeoutMs, 'RETRY_TIMEOUT');
        break;
      case 'recordTrial:good':
        this.ledger.push({ repIndex: this.state.repIndex, outcome: 'good' });
        break;
      case 'recordTrial:failed':
        this.ledger.push({ repIndex: this.state.repIndex, outcome: 'failed' });
        break;
      case 'recordTrial:skipped':
        this.ledger.push({ repIndex: this.state.repIndex, outcome: 'skipped' });
        break;
      // `advance` / `replayCurrent` mutate repIndex IN THE FSM STATE already;
      // progress is driven from state + the ledger (WIZARD.md), so these need no
      // host action. `done` / `abandoned` are handled at the terminal check.
      case 'advance':
      case 'replayCurrent':
      case 'done':
      case 'abandon':
        break;
    }
  }

  /* ── timers ──────────────────────────────────────────────────────────────── */

  /**
   * Play the cue and arm the cue WATCHDOG. The `cueing` phase has no escape but
   * CUE_DONE; firing it at cueTotalMs is the normal "audio finished" signal, and
   * the +margin guarantees we still escape if audio stalled (WIZARD.md cue
   * watchdog — never wedge the operator).
   */
  private armCue(): void {
    this.clearCueWatchdog();
    let totalMs: number;
    try {
      totalMs = playCue(this.cueMode);
    } catch {
      // Audio unavailable (no Web Audio / blocked): fall back to the schedule's
      // nominal length so the FSM still advances on time.
      totalMs = cueTotalMs(CUE_PRESETS[this.cueMode]);
    }
    const fireAt = Math.max(totalMs, cueTotalMs(CUE_PRESETS[this.cueMode])) + CUE_WATCHDOG_MARGIN_MS;
    this.cueWatchdog = setTimeout(() => {
      this.cueWatchdog = null;
      this.dispatch('CUE_DONE');
    }, fireAt);
  }

  private armTimer(ms: number, event: WizardEvent): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch(event);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearCueWatchdog(): void {
    if (this.cueWatchdog !== null) {
      clearTimeout(this.cueWatchdog);
      this.cueWatchdog = null;
    }
  }

  private clearTimers(): void {
    this.clearTimer();
    this.clearCueWatchdog();
  }
}
