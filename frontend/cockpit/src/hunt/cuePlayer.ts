/**
 * Wizard CUE PLAYER (cockpit) — Web Audio playback of the shared cue schedule.
 *
 * The cue SHAPE is the framework-free schedule from frontend/shared
 * (buildCueSchedule over CUE_PRESETS / cueTotalMs). That module is DOM-free on
 * purpose, so the actual Web-Audio playback (which needs AudioContext) is lifted
 * here from its documented reference snippet — every connected device thus plays
 * an identical cue from the same shared config (docs/WIZARD.md).
 */

import { CUE_PRESETS, cueTotalMs, type CueMode, type CuePreset } from '@shared/cue-config.ts';
import { buildCueSchedule } from '@shared/cue-player.ts';

export { CUE_PRESETS, cueTotalMs, type CueMode, type CuePreset };

/**
 * Lazily-created shared AudioContext. Browsers require a user gesture to start
 * audio; the Hunt panel resumes it on the first START click.
 */
let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API unavailable');
    ctx = new Ctor();
  }
  return ctx;
}

/** Resume the audio context (call from a user gesture so cues are audible). */
export async function ensureAudioReady(): Promise<void> {
  const c = audioContext();
  if (c.state === 'suspended') {
    try {
      await c.resume();
    } catch {
      /* ignore — playback will still schedule, just may be silent until gesture */
    }
  }
}

/**
 * Play the cue for `mode` on the shared AudioContext and return the cue's total
 * length in ms (=== cueTotalMs(preset)) so the host can arm the cue watchdog.
 *
 * Lifted verbatim (modulo the preset lookup) from the reference player in
 * frontend/shared/cue-player.ts: N high beeps then the low beep, each scheduled
 * ~60 ms out so every onset is in the future.
 */
export function playCue(mode: CueMode): number {
  const preset: CuePreset = CUE_PRESETS[mode];
  const c = audioContext();
  const t0 = c.currentTime + 0.06; // small lead so onsets are in the future
  let endMs = 0;
  for (const b of buildCueSchedule(preset)) {
    const at = t0 + b.atMs / 1000;
    const dur = b.durMs / 1000;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = preset.waveform;
    osc.frequency.value = b.freq;
    const atk = 0.004;
    const rel = 0.012;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.85, at + atk);
    g.gain.setValueAtTime(0.85, at + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
    osc.connect(g).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.03);
    endMs = b.atMs + b.durMs;
  }
  return endMs;
}

/**
 * A single short beep, used by the TREND (user-driven capture) flow for its
 * START / STOP markers (docs/WIZARD.md → "Interaction differs by mode": trend
 * is a start-cue / stop-cue capture, NOT the event-mode repetition loop). Uses
 * the same envelope as {@link playCue} so it sits in the same sonic family.
 */
export function playBeep(freq: number, durMs = 160, waveform: CuePreset['waveform'] = 'sine'): void {
  const c = audioContext();
  const at = c.currentTime + 0.02;
  const dur = durMs / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = waveform;
  osc.frequency.value = freq;
  const atk = 0.004;
  const rel = 0.012;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.85, at + atk);
  g.gain.setValueAtTime(0.85, at + Math.max(atk, dur - rel));
  g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.03);
}

/** Rising START marker for a trend capture (a brisk "go"). */
export function playStartBeep(): void {
  playBeep(880, 150, 'sine');
}

/** Falling STOP marker that closes a trend capture window. */
export function playStopBeep(): void {
  playBeep(440, 220, 'sine');
}
