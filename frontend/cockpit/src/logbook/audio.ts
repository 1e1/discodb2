/**
 * LOGBOOK audio cues (Web Audio) — ported from the validated mockup. Pure sound,
 * no run logic: the run controller calls these on phase transitions, lead-in, and
 * the last-3-second countdown. A single, lazily-created AudioContext (so it is
 * only spun up on the user gesture that starts a run); `setMuted` gates every cue
 * and tears down the noise ambient.
 *
 * The awaiting-input cue is a DOUBLE beep, not a pitch shift: a rhythm pattern is
 * more discriminable than pitch alone in a noisy cabin (UX note in the design).
 *
 * Live frame SONIFICATION is shaped PER PHASE TYPE (see `setVoice`) so the operator
 * hears which phase they are in — ported from `tools/cue-tone.js` (the `sv*` chain
 * + the validated `SONIF` table): one BiquadFilter + shared tremolo/vibrato LFOs +
 * a light drive WaveShaper. Today the melody is a placeholder (random notes from a
 * fixed scale); the real CAN-frame→pitch mapping is a separate follow-up.
 */

/** The sonification VOICE = the per-phase audio treatment (filter + effect + density). */
export type SonifVoice = 'noise' | 'stimulus' | 'observe' | 'awaiting';

export interface LogbookAudio {
  /** Last-3s countdown tick. */
  countdown(): void;
  /** Phase change. */
  transition(): void;
  /** Sequence finished — a DOUBLE transition tone to announce completion. */
  complete(): void;
  /** Awaiting operator input — two identical C5 notes on the short→long rhythm. */
  awaitBeep(): void;
  /** Session opened — a C5→G5 rising chirp (the very first run sound). */
  connect(): void;
  /** Session closed — a G5→C5 falling chirp (the very last run sound). */
  disconnect(): void;
  /** One lead-in pip (3·2·1). */
  leadIn(): void;
  /** Run start ("go") — unused since CONNECT became the first run sound. */
  go(): void;
  /**
   * Start (or retune) the per-phase frame sonification; `null` silences it. Each
   * voice retunes the filter, the tremolo/vibrato/drive effect, and the note-
   * scheduler interval (the validated `SONIF` table). `setMuted` still gates it.
   */
  setVoice(v: SonifVoice | null): void;
  setMuted(m: boolean): void;
  muted(): boolean;
  dispose(): void;
}

/** Per-phase sonification settings (the user's final cue-tone-editor values). */
type SonifSetting = {
  wave: OscillatorType;
  filter: BiquadFilterType | 'none';
  cutoff: number;
  fx: 'none' | 'tremolo' | 'vibrato' | 'detune' | 'drive';
  intervalMs: number;
};
const SONIF: Record<SonifVoice, SonifSetting> = {
  noise: { wave: 'triangle', filter: 'bandpass', cutoff: 600, fx: 'none', intervalMs: 190 },
  stimulus: { wave: 'square', filter: 'highpass', cutoff: 700, fx: 'vibrato', intervalMs: 150 },
  observe: { wave: 'sine', filter: 'lowpass', cutoff: 1400, fx: 'tremolo', intervalMs: 280 },
  awaiting: { wave: 'sine', filter: 'lowpass', cutoff: 420, fx: 'tremolo', intervalMs: 230 },
};
/** Stand-in scale for the placeholder melody (real frame→pitch mapping is separate). */
const FX_NOTES = [196, 220, 247, 262, 294, 330, 392, 440];

export function createLogbookAudio(): LogbookAudio {
  let actx: AudioContext | null = null;
  let isMuted = false;

  // ── per-phase sonification chain (lazily built; one BiquadFilter + shared LFOs) ─
  let svVoice: SonifVoice = 'noise';
  let svTimer: ReturnType<typeof setInterval> | null = null;
  let svFilter: BiquadFilterNode | null = null;
  let svMaster: GainNode | null = null;
  let svTremGain: GainNode | null = null; // tremolo LFO → master gain
  let svVibGain: GainNode | null = null; // vibrato LFO → (per-note) detune
  let svShaper: WaveShaperNode | null = null;

  const ac = (): AudioContext => {
    if (!actx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      actx = new Ctor();
    }
    return actx;
  };

  /** One enveloped tone; an exponential decay so cues don't click. */
  function tone(freq: number, dur: number, type: OscillatorType, gain: number): void {
    if (isMuted) return;
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = c.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur);
  }

  /** Soft-clip curve for the "drive" effect (cheap waveshaper). */
  function driveCurve(k: number): Float32Array<ArrayBuffer> {
    const n = 256;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /** Build the persistent sonification nodes once (filter → shaper → master → out). */
  function svChain(): void {
    if (svMaster) return;
    const c = ac();
    svMaster = c.createGain();
    svMaster.gain.value = 0.85;
    svFilter = c.createBiquadFilter();
    svFilter.type = 'lowpass';
    svFilter.frequency.value = 12000;
    svShaper = c.createWaveShaper();
    svShaper.curve = null;
    svFilter.connect(svShaper);
    svShaper.connect(svMaster);
    svMaster.connect(c.destination);
    // shared tremolo LFO → master gain; shared vibrato LFO → (per-note) detune.
    svTremGain = c.createGain();
    svTremGain.gain.value = 0;
    const trem = c.createOscillator();
    trem.frequency.value = 6;
    trem.connect(svTremGain);
    svTremGain.connect(svMaster.gain);
    trem.start();
    svVibGain = c.createGain();
    svVibGain.gain.value = 0;
    const vib = c.createOscillator();
    vib.frequency.value = 5.5;
    vib.connect(svVibGain);
    vib.start();
  }

  /** Push the current voice's filter + effect settings onto the chain. */
  function svApply(): void {
    if (!svFilter || !svTremGain || !svVibGain || !svShaper) return;
    const v = SONIF[svVoice];
    const t = ac().currentTime;
    svFilter.type = v.filter === 'none' ? 'allpass' : v.filter;
    if (v.filter !== 'none') svFilter.frequency.setTargetAtTime(v.cutoff, t, 0.05);
    svFilter.Q.value = v.filter === 'bandpass' || v.filter === 'notch' ? 4 : 0.7;
    svTremGain.gain.setTargetAtTime(v.fx === 'tremolo' ? 0.5 : 0, t, 0.05);
    svVibGain.gain.setTargetAtTime(v.fx === 'vibrato' ? 14 : 0, t, 0.05); // detune cents
    svShaper.curve = v.fx === 'drive' ? driveCurve(8) : null;
  }

  /** Schedule one note of the placeholder melody through the current voice. */
  function svNote(): void {
    if (isMuted || !svFilter || !svVibGain) return;
    const c = ac();
    const v = SONIF[svVoice];
    const base = FX_NOTES[(Math.random() * FX_NOTES.length) | 0];
    const freq = base * (v.fx === 'detune' ? 0.84 : 1);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = v.wave;
    o.frequency.value = freq;
    if (v.fx === 'vibrato') svVibGain.connect(o.detune);
    const at = c.currentTime + 0.01;
    const dur = Math.min(0.16, (v.intervalMs / 1000) * 0.7);
    // Half volume for every phase EXCEPT the "on input" (awaiting) voice — the
    // await is the moment the operator must act, so it stays full.
    const peak = svVoice === 'awaiting' ? 0.16 : 0.08;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(svFilter);
    o.start(at);
    o.stop(at + dur + 0.03);
  }

  function stopSonif(): void {
    if (svTimer) {
      clearInterval(svTimer);
      svTimer = null;
    }
  }

  /** The phase-change tone (a low → high two-note); reused doubled for completion. */
  function transition(): void {
    tone(330, 0.16, 'sine', 0.18);
    setTimeout(() => tone(523, 0.16, 'sine', 0.15), 70);
  }

  return {
    countdown: () => tone(880, 0.07, 'square', 0.12),
    transition,
    // Sequence done: the SAME transition tone, played twice (~300 ms apart) so the
    // operator hears "end of run" as a distinct double of a familiar cue.
    complete: () => {
      transition();
      setTimeout(transition, 300);
    },
    // The awaiting-input cue → two IDENTICAL C5 notes on the short→long rhythm
    // (70 ms · 8 ms gap · 160 ms; sine; gain 0.18). Tuned in cue-tone-editor.html.
    awaitBeep: () => {
      tone(523.3, 0.07, 'sine', 0.18);
      setTimeout(() => tone(523.3, 0.16, 'sine', 0.18), 78);
    },
    // Session chirps, same rhythm family as the await double-beep.
    connect: () => {
      tone(523.3, 0.07, 'sine', 0.18);
      setTimeout(() => tone(784, 0.16, 'sine', 0.18), 78); // C5 → G5 rise
    },
    disconnect: () => {
      tone(784, 0.07, 'sine', 0.18);
      setTimeout(() => tone(523.3, 0.16, 'sine', 0.18), 78); // G5 → C5 fall
    },
    leadIn: () => tone(660, 0.09, 'square', 0.1),
    go: () => {
      tone(523, 0.12, 'sine', 0.18);
      setTimeout(() => tone(784, 0.18, 'sine', 0.16), 90);
    },
    setVoice(v: SonifVoice | null) {
      if (v === null) {
        stopSonif();
        return;
      }
      svVoice = v;
      if (isMuted) return; // remembered; the timer (re)starts when unmuted via a later setVoice
      svChain();
      svApply();
      stopSonif();
      svTimer = setInterval(svNote, SONIF[v].intervalMs);
    },
    setMuted(m: boolean) {
      isMuted = m;
      if (m) stopSonif();
    },
    muted: () => isMuted,
    dispose() {
      stopSonif();
      if (actx) {
        actx.close().catch(() => {});
        actx = null;
      }
    },
  };
}
