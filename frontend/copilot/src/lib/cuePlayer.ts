// Wizard CUE PLAYER (copilot side) — the audio HALF of the instruction.
//
// AUDIO GUARANTEE (H1): the cue beep must NEVER be silently dropped. Two parts
// work together and the player owns the first:
//   1. We unlock/resume the AudioContext on EVERY user gesture (the store wires
//      a non-`once` listener), not just the first tap, so an iOS context that
//      was re-suspended by backgrounding is brought back the next time the
//      driver touches anything. resume() is also fired opportunistically right
//      before each cue (cheap if already running).
//   2. play() REPORTS whether it actually produced audio (returns `audible`),
//      so the UI can always render the big VISUAL cue and, when the speaker is
//      still muted, surface a "follow the screen" hint. The instruction is thus
//      audio+visual, never audio-only-that-failed.
//
// This lifts the reference Web-Audio player documented in
// frontend/shared/cue-player.ts into live code, building the beep schedule from
// the SHARED pure core (buildCueSchedule) + the SHARED presets (CUE_PRESETS) so
// every device plays an identical cue. Browser-runtime concerns the shared
// (DOM-free) module omits live here. We ALSO fire a Vibration pulse where
// supported as extra reinforcement (iOS Safari has none — there the VISUAL cue
// is the guaranteed non-audio channel). Bounded: one shared AudioContext,
// oscillators are fire-and-forget and stop themselves; nothing is retained.

import { buildCueSchedule } from "@shared/cue-player.ts";
import {
  CUE_PRESETS,
  cueTotalMs,
  type CueMode,
  type CuePreset,
} from "@shared/cue-config.ts";

type WindowWithWebkitAudio = Window &
  typeof globalThis & { webkitAudioContext?: typeof AudioContext };

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as WindowWithWebkitAudio;
  return w.AudioContext ?? w.webkitAudioContext;
}

/** What a cue attempt achieved — so the UI can guarantee the VISUAL half. */
export interface CueResult {
  /** Nominal cue length in ms (=== cueTotalMs(preset)); host owns completion. */
  totalMs: number;
  /** True iff the AudioContext was running and we scheduled audible tones. */
  audible: boolean;
}

export class CuePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  readonly supported: boolean;

  constructor() {
    this.supported = audioContextCtor() !== undefined;
  }

  /**
   * Create/resume the AudioContext. MUST be called from within a user gesture at
   * least once on iOS (the overlay's first tap / the START handshake) or the
   * context stays suspended and no beep is audible. Idempotent and cheap.
   */
  async unlock(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* will retry on next gesture */
      }
    }
  }

  /** True once the context exists and is actively running (audible). */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /**
   * Play the cue for a given mode. Returns {totalMs, audible}: the nominal cue
   * length (the HOST owns actual completion — it relays the phase change) plus
   * whether audio actually sounded. When NOT audible the caller MUST rely on the
   * visual cue (H1); we still fire a vibration burst where supported.
   */
  playMode(mode: CueMode): CueResult {
    return this.play(CUE_PRESETS[mode]);
  }

  play(preset: CuePreset): CueResult {
    const totalMs = cueTotalMs(preset);
    // Opportunistic resume (no await — fire the schedule immediately so onsets
    // line up; if the context is still suspended the tones are simply silent and
    // the VISUAL cue + vibration fallback below cover it).
    void this.unlock();

    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== "running") {
      this.vibrateFallback(preset);
      return { totalMs, audible: false };
    }

    const t0 = ctx.currentTime + 0.06; // small lead so every onset is in the future
    for (const b of buildCueSchedule(preset)) {
      const at = t0 + b.atMs / 1000;
      const dur = b.durMs / 1000;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = preset.waveform;
      osc.frequency.value = b.freq;
      const atk = 0.004;
      const rel = 0.012;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.85, at + atk);
      g.gain.setValueAtTime(0.85, at + Math.max(atk, dur - rel));
      g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
      osc.connect(g).connect(master);
      osc.start(at);
      osc.stop(at + dur + 0.03);
    }
    // Belt-and-braces: a short haptic on the low ("go") beep too, if available.
    this.vibrateFallback(preset);
    return { totalMs, audible: true };
  }

  /**
   * Non-audio fallback / reinforcement: a vibration pattern roughly mirroring
   * the cue (short pulses for the high beeps, a long pulse for the low "go"
   * beep). No-op where Vibration is unsupported (iOS Safari has no Vibration —
   * there the audio path is the only channel, hence unlock() matters most).
   */
  private vibrateFallback(preset: CuePreset): void {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }
    const pattern: number[] = [];
    for (let i = 0; i < preset.high.count; i++) {
      pattern.push(40, preset.gapMs); // pulse, gap
    }
    pattern.push(Math.min(400, preset.low.durationMs)); // the long "go"
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }

  /** Release the AudioContext (app teardown). */
  async destroy(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}
