// Wizard cue sound presets, tuned in tools/cue-tone-editor.html.
// The active preset is chosen by the experiment's action timing:
//   "during" — act WHILE the low beep plays (long low tone = reaction window)
//   "after"  — act once the cue ends (short low tone = a "go" marker)
// All connected devices play the same preset from this shared config.

export type Waveform = 'sine' | 'square' | 'triangle' | 'sawtooth';
export type CueMode = 'during' | 'after';

export interface CueTone {
  note: string; // human-readable, e.g. "D6" (informational)
  hz: number; // the value actually used
  durationMs: number;
}

export interface CuePreset {
  waveform: Waveform;
  high: CueTone & { count: number };
  low: CueTone;
  gapMs: number;
}

export const CUE_PRESETS: Record<CueMode, CuePreset> = {
  during: {
    waveform: 'sine',
    high: { note: 'D6', hz: 1174.7, durationMs: 90, count: 3 },
    low: { note: 'D3', hz: 146.8, durationMs: 1000 },
    gapMs: 233,
  },
  after: {
    waveform: 'sawtooth',
    high: { note: 'F#6', hz: 1480, durationMs: 90, count: 3 },
    low: { note: 'F#3', hz: 185, durationMs: 333 },
    gapMs: 233,
  },
};

/** Total cue length in ms (count high beeps + gaps + the low beep). */
export function cueTotalMs(p: CuePreset): number {
  return p.high.count * (p.high.durationMs + p.gapMs) + p.low.durationMs;
}
