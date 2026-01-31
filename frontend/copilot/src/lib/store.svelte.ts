// Central app store (Svelte 5 runes). Owns the WS client, the active watches,
// their latest values, and the single gauge ring buffer.
//
// BOUNDED MEMORY (the whole point of the light client, §7):
//   • One LatestValue per watch — overwritten in place, never appended.
//   • One RingBuffer for the gauge — fixed capacity, oldest overwritten.
//   • Records are NOT stored; each is resolved into the watches and dropped.
//
// BOUNDED COMPUTE / iOS-friendly rendering:
//   • onRecord mutates plain (non-reactive) LatestValue objects at full bus
//     rate — cheap, no Svelte reactivity per frame.
//   • A single rAF loop bumps `tick` (a $state counter) at display rate; the UI
//     derives everything from `tick`, so the DOM updates ~60 Hz max regardless
//     of how many thousands of frames/s arrive. rAF pauses when backgrounded.

import { CanWsClient, type ConnState } from "../protocol/client";
import type { BatchMeta } from "../protocol/parse";
import type { CanRecord, Health } from "../protocol/types";
import type { TrialAction, WizardRelay } from "../protocol/wizard";
import { RingBuffer } from "./ring";
import { CuePlayer } from "./cuePlayer";
import {
  applyRecord,
  newLatest,
  type LatestValue,
  type Watch,
} from "./watches";

export const GAUGE_RING_CAPACITY = 120; // tiny rolling window for the gauge

export interface WatchEntry {
  watch: Watch;
  latest: LatestValue; // mutated in place, NOT reactive
}

function defaultWsUrl(): string {
  // A5: default the WebSocket to the backend's port 8765 on the SAME HOST that
  // served the page (§3.1), so opening the app from a phone connects straight to
  // ws://<served-host>:8765/ws with NO IP typing. The backend always listens on
  // 8765, and in dev/preview the Vite server (a different process/port) sits on
  // the same hostname — so deriving the port from `location.port` would point
  // the socket at the dev server, which has no backend. We therefore PIN :8765
  // rather than reusing the page's port.
  //
  // For a reverse-proxied / split deployment that fronts the backend on a
  // different host:port, pass ?ws=ws://host[:port]/ws to override.
  const params = new URLSearchParams(location.search);
  const override = params.get("ws");
  if (override) return override;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = location.hostname || "localhost";
  return `${proto}//${host}:8765/ws`;
}

function defaultHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

export class AppStore {
  // ── reactive UI-facing state ────────────────────────────────────────────
  tick = $state(0); // bumped each rAF; UI derives from this
  conn = $state<ConnState>("idle");
  health = $state<Health | null>(null);
  lastError = $state<string | null>(null);
  fps = $state(0); // observed records/sec (display-rate estimate)
  replay = $state(false);
  wakeHeld = $state(false);
  wakeSupported = $state(false);
  /** True briefly after a verdict/STOP tap that could NOT be sent (socket down). */
  feedbackUnsent = $state(false);
  private _unsentTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Latest relayed Wizard state (DESIGN §3.3), or null when no session is
   * active. BOUNDED: exactly ONE object, overwritten in place on each relay —
   * never a history. The viewer renders entirely from this.
   */
  wizard = $state<WizardRelay | null>(null);

  /**
   * Did the most-recent cue actually SOUND? (H1 audio guarantee.) False when the
   * AudioContext was still suspended (iOS, no gesture yet / re-backgrounded) or
   * audio is unsupported. The overlay always shows the VISUAL cue regardless;
   * when this is false it ALSO surfaces a "follow the screen" hint. null before
   * the first cue of a session. Reset when a session leaves the cue.
   */
  cueAudible = $state<boolean | null>(null);

  readonly wsUrl: string;
  readonly httpUrl: string;

  // ── non-reactive hot-path state ──────────────────────────────────────────
  private entries: WatchEntry[] = [];
  /** Gauge tracks ONE watch's value over time. */
  private gaugeKey: string | null = null;
  readonly gaugeRing = new RingBuffer(GAUGE_RING_CAPACITY);

  private client: CanWsClient | null = null;
  private rafId = 0;
  private recCountWindow = 0;
  private fpsWindowStart = 0;

  /**
   * Freshest backend-monotonic µs seen on the stream — the only legitimate
   * timestamp source (§4.2: wall clock is never trusted). Used to stamp
   * trialFeedback `at`. 0 until the first frame arrives (host re-stamps then).
   */
  private lastFrameTUs = 0;

  // ── Wizard cue (audio-led; the PRIMARY instruction channel) ───────────────
  readonly cue = new CuePlayer();
  /**
   * Identity of the cue last played, so we BEEP exactly once per cue. A cue is
   * (re)started whenever the host enters `cueing`; a silent REPLAY keeps the
   * same repIndex, so the host bumps `cueSeq` — we key on it when present and
   * fall back to (phase|repIndex) otherwise.
   */
  private lastCueKey: string | null = null;

  constructor() {
    this.wsUrl = defaultWsUrl();
    this.httpUrl = defaultHttpUrl(this.wsUrl);
  }

  // ── watch management ──────────────────────────────────────────────────────

  get watchEntries(): WatchEntry[] {
    return this.entries;
  }

  hasWatch(key: string): boolean {
    return this.entries.some((e) => e.watch.key === key);
  }

  addWatch(w: Watch): void {
    if (this.hasWatch(w.key)) return;
    this.entries.push({ watch: w, latest: newLatest() });
    // First watch added becomes the gauge subject by default.
    if (this.gaugeKey === null && w.kind !== "frame") this.setGauge(w.key);
    this.tick++; // structural change → re-render tile list
  }

  removeWatch(key: string): void {
    const i = this.entries.findIndex((e) => e.watch.key === key);
    if (i >= 0) this.entries.splice(i, 1);
    if (this.gaugeKey === key) {
      this.gaugeKey = null;
      this.gaugeRing.clear();
      // Promote the next gauge-able watch, if any.
      const next = this.entries.find((e) => e.watch.kind !== "frame");
      if (next) this.setGauge(next.watch.key);
    }
    this.tick++;
  }

  setGauge(key: string): void {
    if (this.gaugeKey === key) return;
    this.gaugeKey = key;
    this.gaugeRing.clear();
    this.tick++;
  }

  get gaugeWatchKey(): string | null {
    return this.gaugeKey;
  }

  gaugeEntry(): WatchEntry | undefined {
    if (this.gaugeKey === null) return undefined;
    return this.entries.find((e) => e.watch.key === this.gaugeKey);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  connect(autoStartSim = true): void {
    if (this.client) return;
    this.fpsWindowStart = performance.now();
    this.client = new CanWsClient({
      url: this.wsUrl,
      client: "copilot",
      autoStart: autoStartSim
        ? { type: "start", source: "sim", bitrate: 500000, listen_only: true }
        : undefined,
      handlers: {
        onRecord: (rec, meta) => this.onRecord(rec, meta),
        onHealth: (h) => {
          this.health = h;
        },
        onFiles: () => {},
        onError: (m) => {
          this.lastError = m;
        },
        onState: (s) => {
          this.conn = s;
        },
        onWizard: (relay) => this.onWizard(relay),
      },
    });
    this.client.connect();
    this.startRaf();
  }

  /** (Re)issue a start for a specific source (e.g. switch sim↔replay). */
  startSource(
    source: "sim" | "socketcan" | "gs_usb" | "slcan" | "replay",
    file?: string,
  ): void {
    this.client?.start({
      source,
      bitrate: 500000,
      listen_only: true,
      ...(file ? { file } : {}),
    });
  }

  disconnect(): void {
    this.client?.close();
    this.client = null;
    this.stopRaf();
    void this.cue.destroy();
  }

  // ── Wizard relay (VIEWER) ──────────────────────────────────────────────────

  /**
   * Ingest a relayed Wizard state. The copilot NEVER computes the experiment; it
   * just mirrors the host and plays the cue locally when the host says to. We
   * keep only this single latest object (bounded memory).
   */
  private onWizard(relay: WizardRelay): void {
    this.wizard = relay;
    this.maybePlayCue(relay);
  }

  /**
   * BEEP once per cue. The host owns cue completion (it relays the phase change
   * to `feedback`); we just sound the local speaker so the eyes-on-road driver
   * hears the instruction. Keyed so a silent replay (same repIndex, bumped
   * cueSeq) still re-cues, and so re-receiving the same `cueing` relay (a dup
   * fan-out) does NOT double-beep.
   */
  private maybePlayCue(relay: WizardRelay): void {
    if (relay.phase !== "cueing") {
      // Leaving the cue clears the key so the NEXT cueing phase always fires,
      // even if it happens to reuse the same repIndex/cueSeq. Audibility is a
      // per-cue fact; forget it once we leave the cue.
      this.lastCueKey = null;
      this.cueAudible = null;
      return;
    }
    const key =
      relay.cueSeq !== undefined
        ? `seq:${relay.cueSeq}`
        : `rep:${relay.repIndex}`;
    if (key === this.lastCueKey) return;
    this.lastCueKey = key;
    // Best-effort audio; the VISUAL cue (overlay) is the guarantee. Record
    // whether it actually sounded so the UI can flag a muted speaker.
    this.cueAudible = this.cue.playMode(relay.cueMode).audible;
  }

  /**
   * Send the operator's per-trial verdict to the host (DESIGN §3.3). Stamps with
   * the freshest backend-monotonic µs we have seen on the stream (the host
   * re-stamps if it must); we never invent a wall clock (§4.2). Also (re)unlocks
   * audio — these calls happen inside the verdict tap, the iOS gesture we need.
   */
  sendFeedback(action: TrialAction): void {
    void this.cue.unlock();
    const sent = this.client?.sendTrialFeedback(action, this.lastFrameTUs) ?? false;
    if (sent) {
      // Confirm: one short buzz so an eyes-on-road operator feels it took.
      navigator.vibrate?.(25);
    } else {
      // Safety: a verdict tap with the socket DOWN must NOT be a silent no-op.
      // A distinct error buzz + a brief visible flag tells the operator to retry
      // instead of assuming it registered.
      navigator.vibrate?.([60, 40, 60]);
      this.feedbackUnsent = true;
      if (this._unsentTimer) clearTimeout(this._unsentTimer);
      this._unsentTimer = setTimeout(() => {
        this.feedbackUnsent = false;
      }, 2200);
    }
  }

  /** Unlock audio from a user gesture (iOS requires this before any beep). */
  unlockAudio(): void {
    void this.cue.unlock();
  }

  /**
   * Dismiss a TERMINAL wizard overlay locally (done/abandoned) to return to the
   * live glance view. Viewer-only: it does NOT message the host — the series has
   * already ended host-side; this just stops showing its result on THIS device.
   * The next series the host starts re-shows the overlay via a fresh relay.
   */
  dismissWizard(): void {
    if (this.wizard && (this.wizard.phase === "done" || this.wizard.phase === "abandoned")) {
      this.wizard = null;
      this.lastCueKey = null;
    }
  }

  // ── hot path (NOT reactive) ────────────────────────────────────────────────

  private onRecord(rec: CanRecord, meta: BatchMeta): void {
    this.recCountWindow++;
    this.lastFrameTUs = rec.tUs; // freshest backend µs (for trialFeedback stamps)
    // Track replay flag from the batch header without per-frame reactivity.
    if (meta.isReplay !== this.replay) this.replay = meta.isReplay;

    for (const e of this.entries) {
      const matched = applyRecord(e.watch, e.latest, rec);
      if (matched && e.watch.key === this.gaugeKey && isFinite(e.latest.value)) {
        this.gaugeRing.push(e.latest.value);
      }
    }
  }

  // ── display-rate render loop ───────────────────────────────────────────────

  private startRaf(): void {
    if (this.rafId) return;
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      // ~1 Hz fps estimate.
      const now = performance.now();
      const dt = now - this.fpsWindowStart;
      if (dt >= 1000) {
        this.fps = Math.round((this.recCountWindow * 1000) / dt);
        this.recCountWindow = 0;
        this.fpsWindowStart = now;
      }
      this.tick++; // drive the UI at the browser's frame cadence
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRaf(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}
