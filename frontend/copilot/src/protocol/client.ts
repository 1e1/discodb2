// discodb2 WebSocket client (§3.1–§3.4), implemented directly from DESIGN.md.
//
// One WebSocket: BINARY frames = CAN batch stream (hot path), TEXT frames =
// JSON control/status. Plus GET /health (JSON) used as a connectivity probe.
//
// LIGHT-CLIENT posture (§7):
//   • Binary batches are parsed on the MAIN THREAD (cheap, fixed-size records).
//   • No buffering of history — each record is pushed straight to the sink.
//   • Robust reconnect with capped exponential backoff + jitter.
//   • iOS backgrounding: Safari suspends the socket when the tab/screen sleeps
//     WITHOUT always firing onclose. We treat visibility/pageshow as a trigger
//     to verify liveness and force-reconnect a stale socket. A watchdog also
//     reconnects if no frame/status has arrived within a timeout while visible.

import { parseBatch, BatchParseError, type BatchMeta } from "./parse";
import type {
  CanRecord,
  ClientMsg,
  Health,
  HuntMarkClientMsg,
  ServerTextMsg,
  StartMsg,
  TrialFeedbackClientMsg,
} from "./types";
import { parseWizardRelay, type TrialAction, type WizardRelay } from "./wizard";
import { parseLogbookRelay, type LogbookCmdClientMsg, type LogbookRelay } from "./logbook";

export type ConnState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ClientHandlers {
  /** Per CAN record (called synchronously during batch parse; do not retain `rec.data`). */
  onRecord?: (rec: CanRecord, meta: BatchMeta) => void;
  /** Server status/health push (text frame carrying a `bus` field). */
  onHealth?: (h: Health) => void;
  /** {"type":"files",...} */
  onFiles?: (files: string[]) => void;
  /** {"type":"error","message":...} OR a local/transport error. */
  onError?: (message: string) => void;
  /** Connection lifecycle changes (drive the UI status pill from this). */
  onState?: (state: ConnState) => void;
  /**
   * §3.3 Wizard relay (host → viewers), fanned out by the backend. The copilot
   * is a VIEWER: it renders this and never recomputes it.
   */
  onWizard?: (relay: WizardRelay) => void;
  /**
   * §3.3 Logbook relay (host → viewers): the cockpit's run state, mirrored
   * read-only. Like the Wizard relay, the copilot renders it and never computes it.
   */
  onLogbook?: (relay: LogbookRelay) => void;
}

export interface ClientOptions {
  url: string;
  /** Identify as the light client (§3.3). */
  client?: "copilot" | "cockpit";
  /** Auto-send a `start` after `hello` (handy for sim). Omit to start manually. */
  autoStart?: StartMsg;
  handlers: ClientHandlers;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * If no message (binary or text) arrives within this window WHILE the page is
   * visible and the socket claims to be open, assume a silently-dead socket
   * (classic iOS background-suspend symptom) and force a reconnect.
   */
  stallTimeoutMs?: number;
}

const DEFAULTS = {
  minBackoffMs: 500,
  maxBackoffMs: 8000,
  stallTimeoutMs: 6000,
};

export class CanWsClient {
  private opts: Required<Omit<ClientOptions, "autoStart" | "client">> &
    Pick<ClientOptions, "autoStart" | "client">;
  private ws: WebSocket | null = null;
  private state: ConnState = "idle";
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastMsgAt = 0;
  private manualClose = false;
  private boundVisibility: () => void;
  private boundPageShow: () => void;
  private boundOnline: () => void;

  constructor(options: ClientOptions) {
    this.opts = {
      url: options.url,
      client: options.client ?? "copilot",
      autoStart: options.autoStart,
      handlers: options.handlers,
      minBackoffMs: options.minBackoffMs ?? DEFAULTS.minBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      stallTimeoutMs: options.stallTimeoutMs ?? DEFAULTS.stallTimeoutMs,
    };
    this.backoff = this.opts.minBackoffMs;
    this.boundVisibility = () => this.onVisibilityChange();
    this.boundPageShow = () => this.onPageShow();
    this.boundOnline = () => this.onOnline();
  }

  // ── public API ──────────────────────────────────────────────────────────

  connect(): void {
    this.manualClose = false;
    this.addLifecycleListeners();
    this.startStallWatchdog();
    this.open();
  }

  /** Send a JSON control message (§3.3). No-op (silently) if socket not open. */
  send(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  start(msg: Omit<StartMsg, "type">): boolean {
    return this.send({ type: "start", ...msg });
  }
  stop(): boolean {
    return this.send({ type: "stop" });
  }

  /**
   * §3.3 trialFeedback — the operator's per-trial verdict, sent to the host. The
   * backend relays it verbatim to the cockpit, which feeds its feedback FSM.
   * `at` is best-effort backend-monotonic µs; the host re-stamps if it must.
   * No-op (returns false) if the socket is not open — the host's silence guard
   * covers a dropped verdict (the operator can simply press again).
   */
  sendTrialFeedback(action: TrialAction, atUs: number): boolean {
    const msg: TrialFeedbackClientMsg = { type: "trialFeedback", action, at: atUs };
    return this.send(msg);
  }

  /**
   * §3.3 huntMark — the operator vetoes a CLOSED time span as contamination to
   * exclude from the active hunt. Sent ONCE when the exclusion window closes;
   * `from`/`to` are backend-monotonic µs (§4.2). The backend relays it verbatim
   * to the host, which owns the exclusion strategy. No-op (returns false) if the
   * socket is not open — the caller surfaces the miss (the span can be re-marked).
   */
  sendHuntMark(fromUs: number, toUs: number): boolean {
    const msg: HuntMarkClientMsg = { type: "huntMark", kind: "exclude", from: fromUs, to: toUs };
    return this.send(msg);
  }

  /**
   * §3.3 Logbook command — the copilot picks+starts a scenario, stops a run, or
   * advances an "on input" phase. The backend relays it verbatim to the cockpit,
   * which owns the run. No-op (returns false) if the socket is not open.
   */
  sendLogbookCmd(command: "start" | "stop" | "next", scenarioId?: string): boolean {
    const msg: LogbookCmdClientMsg = { type: "logbookCmd", command, ...(scenarioId ? { scenarioId } : {}) };
    return this.send(msg);
  }

  /** Tear down for good (user navigated away / app closing). */
  close(): void {
    this.manualClose = true;
    this.clearReconnect();
    this.stopStallWatchdog();
    this.removeLifecycleListeners();
    this.teardownSocket();
    this.setState("closed");
  }

  getState(): ConnState {
    return this.state;
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  private open(): void {
    this.teardownSocket();
    this.setState(this.backoff > this.opts.minBackoffMs ? "reconnecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.opts.handlers.onError?.(`WebSocket construct failed: ${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.lastMsgAt = Date.now();
      this.backoff = this.opts.minBackoffMs; // reset backoff on success
      this.setState("open");
      // §3.3 handshake.
      this.send({ type: "hello", client: this.opts.client ?? "copilot" });
      if (this.opts.autoStart) this.send(this.opts.autoStart);
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.lastMsgAt = Date.now();
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this.handleBinary(data);
      } else if (typeof data === "string") {
        this.handleText(data);
      } else if (data instanceof Blob) {
        // Defensive: binaryType should be arraybuffer, but if a Blob slips
        // through, convert without retaining it.
        data.arrayBuffer().then((b) => this.handleBinary(b));
      }
    };

    ws.onerror = () => {
      // The spec hides error detail; onclose follows and drives reconnect.
      this.opts.handlers.onError?.("websocket error");
    };

    ws.onclose = () => {
      if (this.manualClose) return;
      this.scheduleReconnect();
    };
  }

  private handleBinary(buf: ArrayBuffer): void {
    try {
      parseBatch(buf, (rec, meta) => this.opts.handlers.onRecord?.(rec, meta));
    } catch (e) {
      if (e instanceof BatchParseError) {
        // Drop the bad frame; never let it kill the connection.
        this.opts.handlers.onError?.(`bad batch: ${e.message}`);
      } else {
        throw e;
      }
    }
  }

  private handleText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.opts.handlers.onError?.("non-JSON text frame");
      return;
    }
    // §3.3 Wizard relay (host → viewers). Check FIRST: it carries a `type` the
    // §3.4 union below does not know about, and the copilot's whole job is to
    // render it. Tolerant parse — a malformed control frame is dropped, never
    // wedges the viewer.
    const relay = parseWizardRelay(parsed);
    if (relay) {
      this.opts.handlers.onWizard?.(relay);
      return;
    }
    // §3.3 Logbook relay (host → viewers) — same verbatim fan-out as the Wizard.
    const lb = parseLogbookRelay(parsed);
    if (lb) {
      this.opts.handlers.onLogbook?.(lb);
      return;
    }
    // Discriminate per §3.4. Status/Health has no `type` but carries `bus`.
    const msg = parsed as ServerTextMsg;
    if ("type" in msg && msg.type === "files") {
      this.opts.handlers.onFiles?.(msg.files);
    } else if ("type" in msg && msg.type === "error") {
      this.opts.handlers.onError?.(msg.message);
    } else if ("bus" in msg) {
      this.opts.handlers.onHealth?.(msg as Health);
    }
    // Unknown text frames are ignored (forward-compatible).
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.teardownSocket();
    this.setState("reconnecting");
    this.clearReconnect();
    // Capped exponential backoff with ±25% jitter.
    const jitter = this.backoff * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.open(), jitter);
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Force an immediate reconnect (e.g. resumed from background). */
  private forceReconnect(): void {
    if (this.manualClose) return;
    this.backoff = this.opts.minBackoffMs;
    this.clearReconnect();
    this.open();
  }

  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  // ── iOS-specific resume handling ──────────────────────────────────────────

  private addLifecycleListeners(): void {
    document.addEventListener("visibilitychange", this.boundVisibility);
    // pageshow with persisted=true => restored from the bfcache (iOS Safari
    // does this aggressively); the old socket is dead.
    window.addEventListener("pageshow", this.boundPageShow);
    window.addEventListener("online", this.boundOnline);
  }

  private removeLifecycleListeners(): void {
    document.removeEventListener("visibilitychange", this.boundVisibility);
    window.removeEventListener("pageshow", this.boundPageShow);
    window.removeEventListener("online", this.boundOnline);
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      // Coming back to the foreground: the socket may look OPEN but be dead
      // (iOS suspends it during background with no onclose). If it's not
      // demonstrably open, or it's been silent, reconnect now.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.forceReconnect();
      } else if (Date.now() - this.lastMsgAt > this.opts.stallTimeoutMs) {
        this.forceReconnect();
      }
    }
  }

  private onPageShow(): void {
    // Restored page → assume socket is gone.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceReconnect();
    }
  }

  private onOnline(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceReconnect();
    }
  }

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    // Cheap 1 Hz check. Only acts while the page is visible (a backgrounded tab
    // is expected to be silent and must not thrash reconnects / drain battery).
    this.stallTimer = setInterval(() => {
      if (this.manualClose) return;
      if (document.visibilityState !== "visible") return;
      if (this.state !== "open") return;
      if (Date.now() - this.lastMsgAt > this.opts.stallTimeoutMs) {
        this.opts.handlers.onError?.("stream stalled — reconnecting");
        this.forceReconnect();
      }
    }, 1000);
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private setState(s: ConnState): void {
    if (s === this.state) return;
    this.state = s;
    this.opts.handlers.onState?.(s);
  }
}

/**
 * Probe GET /health — a cheap connectivity/identity check, and a way to read
 * the source/bus state before opening the stream. Returns null on failure.
 */
export async function probeHealth(
  baseHttpUrl: string,
  timeoutMs = 3000,
): Promise<Health | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseHttpUrl.replace(/\/$/, "")}/health`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
