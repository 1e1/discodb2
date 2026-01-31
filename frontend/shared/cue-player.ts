// discodb2 Wizard — CUE PLAYER (frontend/shared/cue-player.ts).
//
// SOURCE OF TRUTH for timing: cue-config.ts (CuePreset / CUE_PRESETS /
// cueTotalMs). The sequencing here is the same one proven in
// tools/cue-tone.js `sequence()` — N high beeps, each (durationMs + gapMs)
// apart, then the low beep — re-expressed as a PURE schedule builder.
//
// Pure & framework-free, like protocol.ts / analysis/*.ts: NO Svelte, NO Vite,
// NO DOM-only deps. In particular it does NOT reference AudioContext or any
// browser global, so the shared package keeps typechecking WITHOUT the DOM lib.
// `buildCueSchedule` mutates nothing and allocates fresh output.
//
// The actual Web-Audio playback (which DOES need the browser globals) is NOT
// live code in this file — it lives only as a documented reference snippet in
// the trailing comment block, for the cockpit/copilot to lift into the UI phase
// where the DOM lib is available.

import type { CuePreset } from './cue-config.ts';

/**
 * One scheduled beep in the cue, relative to the cue's start.
 *   atMs  — onset, in ms from the start of the cue (the first high beep is 0)
 *   freq  — oscillator frequency in Hz (the preset's high.hz / low.hz)
 *   durMs — how long the tone sounds, in ms
 *   kind  — 'hi' for the lead-in beeps, 'lo' for the single low beep
 */
export interface Beep {
  atMs: number;
  freq: number;
  durMs: number;
  kind: 'hi' | 'lo';
}

/**
 * Build the cue's beep schedule from a preset — the PURE core shared by every
 * device so they all play an identical cue.
 *
 * Layout (mirrors tools/cue-tone.js): `preset.high.count` high beeps, the first
 * at 0 ms and each subsequent one advanced by (high.durationMs + gapMs); then a
 * single low beep at the same running offset (i.e. one full gap after the last
 * high beep starts, past its duration). The returned beeps are in onset order
 * and number `preset.high.count + 1`.
 *
 * The end time of the last beep (low.atMs + low.durationMs) equals
 * `cueTotalMs(preset)` from cue-config.ts.
 */
export function buildCueSchedule(preset: CuePreset): Beep[] {
  const beeps: Beep[] = [];
  let t = 0;
  for (let i = 0; i < preset.high.count; i++) {
    beeps.push({ atMs: t, freq: preset.high.hz, durMs: preset.high.durationMs, kind: 'hi' });
    t += preset.high.durationMs + preset.gapMs;
  }
  beeps.push({ atMs: t, freq: preset.low.hz, durMs: preset.low.durationMs, kind: 'lo' });
  return beeps;
}

/* ===========================================================================
 * REFERENCE ONLY — Web Audio player (NOT live code in this DOM-free package).
 *
 * The cockpit/copilot will lift this into the UI phase, where the DOM lib (and
 * thus AudioContext / GainNode) is available. It is intentionally a comment so
 * the shared package still typechecks WITHOUT the DOM lib. Drop it into a
 * .ts/.svelte file that has the DOM lib, import { buildCueSchedule } and the
 * preset, then call playCue(ctx, preset).
 *
 *   import type { CuePreset } from './cue-config.ts';
 *   import { buildCueSchedule } from './cue-player.ts';
 *
 *   // Plays the cue on an already-running AudioContext, starting ~60 ms out so
 *   // every scheduled onset is in the future. Returns the cue's total length in
 *   // ms (=== cueTotalMs(preset)) so callers can time the action/feedback window.
 *   export function playCue(ctx: AudioContext, preset: CuePreset): number {
 *     const t0 = ctx.currentTime + 0.06; // small lead so onsets are in the future
 *     let endMs = 0;
 *     for (const b of buildCueSchedule(preset)) {
 *       const at = t0 + b.atMs / 1000;
 *       const dur = b.durMs / 1000;
 *       const osc = ctx.createOscillator();
 *       const g = ctx.createGain();
 *       osc.type = preset.waveform; // 'sine' | 'square' | 'triangle' | 'sawtooth'
 *       osc.frequency.value = b.freq;
 *       const atk = 0.004;
 *       const rel = 0.012;
 *       g.gain.setValueAtTime(0.0001, at);
 *       g.gain.exponentialRampToValueAtTime(0.85, at + atk);
 *       g.gain.setValueAtTime(0.85, at + Math.max(atk, dur - rel));
 *       g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
 *       osc.connect(g).connect(ctx.destination);
 *       osc.start(at);
 *       osc.stop(at + dur + 0.03);
 *       endMs = b.atMs + b.durMs;
 *     }
 *     return endMs;
 *   }
 * ======================================================================== */
