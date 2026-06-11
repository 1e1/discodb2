/**
 * discodb2 protocol client — the integration surface for DESIGN.md §3.1–3.4.
 *
 * ONE WebSocket carries two interleaved channels (§3.1):
 *   - BINARY messages  → CAN stream batches (§3.2). Forwarded RAW to the
 *     caller (and onward to the parser worker) — never JSON, never blocking.
 *   - TEXT messages    → JSON control/status (§3.3/§3.4). Parsed and dispatched
 *     to typed callbacks.
 *
 * Plus a one-shot `GET /health` helper (§3.1/§3.4).
 *
 * This class is transport-only. It does NOT parse binary batches (that is the
 * worker's job) and does NOT buffer frames (the ring buffer lives in app
 * state). It owns: socket lifecycle, hello handshake, control message sending,
 * status/error/files dispatch, and reconnect with backoff.
 */

import {
  isErrorMsg,
  isFilesMsg,
  isHealthStatus,
  isLogbookCmdMsg,
  isTrialFeedbackMsg,
  isWizardMsg,
  type CanSource,
  type ClientKind,
  type ControlMsg,
  type HealthStatus,
  type LogbookCmdMsg,
  type TrialFeedbackMsg,
  type WizardMsg,
} from './types';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'error';

export interface ProtocolClientOptions {
  /** Full WS url, e.g. "ws://localhost:8765/ws". */
  url: string;
  /** Identifies this client in the hello handshake (§3.3). Default "cockpit". */
  client?: ClientKind;
  /** Auto-reconnect with backoff on unexpected close. Default true. */
  autoReconnect?: boolean;
  /** Initial reconnect delay ms (doubles up to maxReconnectDelayMs). */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface ProtocolClientHandlers {
  /** Connection lifecycle changes (drives the UI status pill). */
  onState?: (state: ConnectionState, detail?: string) => void;
  /** A raw binary batch (§3.2). Forward straight to the parser worker. */
  onBatch?: (buffer: ArrayBuffer) => void;
  /** A parsed §3.4 status/health object (server→client text). */
  onStatus?: (status: HealthStatus) => void;
  /** {"type":"files",...} (§3.4). */
  onFiles?: (files: string[]) => void;
  /** {"type":"error",...} (§3.4) OR a client-side protocol error. */
  onError?: (message: string) => void;
  /** Fired exactly once when the socket first opens (post-hello). */
  onOpen?: () => void;
  /** A relayed {"type":"wizard",...} from another host (§3.3). Rare for a cockpit. */
  onWizard?: (msg: WizardMsg) => void;
  /** A relayed {"type":"trialFeedback",...} from a viewer (§3.3) → feed the host FSM. */
  onTrialFeedback?: (msg: TrialFeedbackMsg) => void;
  /** A relayed {"type":"logbookCmd",...} from a viewer (§3.3) → drive the run controller. */
  onLogbookCmd?: (msg: LogbookCmdMsg) => void;
}

/**
 * The public protocol-client interface. Kept small and explicit so the
 * (parallel) shared/ package can implement the same shape later.
 */
export interface IProtocolClient {
  readonly state: ConnectionState;
  connect(): void;
  disconnect(): void;
  /** §3.3 start. listen_only defaults to true and is clamped server-side. */
  start(opts: {
    source: CanSource;
    bitrate?: number;
    listenOnly?: boolean;
    file?: string;
  }): void;
  stop(): void;
  recordStart(name?: string): void;
  recordStop(): void;
  listFiles(): void;
  /** §3.3 Wizard relay: host → viewers (fanned out verbatim by the backend). */
  sendWizard(payload: Record<string, unknown>): void;
  /** §3.3 Logbook relay: host → viewers (the run state, fanned out verbatim). */
  sendLogbook(payload: Record<string, unknown>): void;
  /** One-shot GET /health (§3.1/§3.4). Resolves with the parsed status. */
  fetchHealth(): Promise<HealthStatus>;
}

export class ProtocolClient implements IProtocolClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'idle';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private intentionalClose = false;

  private readonly opts: Required<ProtocolClientOptions>;
  private readonly handlers: ProtocolClientHandlers;

  constructor(options: ProtocolClientOptions, handlers: ProtocolClientHandlers = {}) {
    this.opts = {
      client: 'cockpit',
      autoReconnect: true,
      reconnectDelayMs: 500,
      maxReconnectDelayMs: 8000,
      ...options,
    };
    this.handlers = handlers;
    this.currentDelay = this.opts.reconnectDelayMs;
  }

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState, detail?: string): void {
    this._state = state;
    this.handlers.onState?.(state, detail);
  }

  connect(): void {
    if (this.ws && (this._state === 'open' || this._state === 'connecting')) return;
    this.intentionalClose = false;
    this.clearReconnect();
    this.openSocket();
  }

  private openSocket(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    // CRITICAL for §3.2: binary frames must arrive as ArrayBuffer so the worker
    // can DataView them directly (not Blob, which would force async reads).
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.currentDelay = this.opts.reconnectDelayMs; // reset backoff
      this.setState('open');
      // §3.3 hello handshake — identify as cockpit.
      this.send({ type: 'hello', client: this.opts.client });
      this.handlers.onOpen?.();
    };

    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);

    ws.onerror = () => {
      // The browser fires error then close; surface state, let onclose reconnect.
      this.setState('error', 'websocket error');
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (this.intentionalClose) {
        this.setState('closed', 'client closed');
        return;
      }
      this.setState('closed', `closed (code ${ev.code})`);
      this.scheduleReconnect();
    };
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data;
    // §3.1: BINARY == CAN stream; TEXT == JSON control/status.
    if (data instanceof ArrayBuffer) {
      this.handlers.onBatch?.(data);
      return;
    }
    if (typeof data === 'string') {
      this.handleText(data);
      return;
    }
    // Defensive: some stacks could deliver a Blob if binaryType were wrong.
    if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => this.handlers.onBatch?.(buf));
      return;
    }
  }

  private handleText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.handlers.onError?.(`non-JSON text frame: ${text.slice(0, 120)}`);
      return;
    }
    if (isHealthStatus(parsed)) {
      this.handlers.onStatus?.(parsed);
      return;
    }
    if (isFilesMsg(parsed)) {
      this.handlers.onFiles?.(parsed.files);
      return;
    }
    if (isErrorMsg(parsed)) {
      this.handlers.onError?.(parsed.message);
      return;
    }
    // §3.3 relayed control messages (the backend fans these out verbatim).
    if (isWizardMsg(parsed)) {
      this.handlers.onWizard?.(parsed);
      return;
    }
    if (isTrialFeedbackMsg(parsed)) {
      this.handlers.onTrialFeedback?.(parsed);
      return;
    }
    if (isLogbookCmdMsg(parsed)) {
      this.handlers.onLogbookCmd?.(parsed);
      return;
    }
    // Unknown but well-formed JSON — surface for forward-compat visibility.
    this.handlers.onError?.(`unrecognized server message: ${text.slice(0, 120)}`);
  }

  private send(msg: ControlMsg): void {
    if (!this.ws || this._state !== 'open') {
      this.handlers.onError?.(`cannot send ${msg.type}: socket not open`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  // ── §3.3 control commands ──────────────────────────────────────────────────

  start(opts: {
    source: CanSource;
    bitrate?: number;
    listenOnly?: boolean;
    file?: string;
  }): void {
    // listen_only defaults TRUE (§4.1). Backend clamps regardless; we never
    // default it to false from the heavy client.
    const msg: ControlMsg = {
      type: 'start',
      source: opts.source,
      bitrate: opts.bitrate ?? 500000,
      listen_only: opts.listenOnly ?? true,
      ...(opts.source === 'replay' && opts.file ? { file: opts.file } : {}),
    };
    this.send(msg);
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  recordStart(name?: string): void {
    this.send({ type: 'record_start', ...(name ? { name } : {}) });
  }

  recordStop(): void {
    this.send({ type: 'record_stop' });
  }

  listFiles(): void {
    this.send({ type: 'list_files' });
  }

  /**
   * §3.3 Wizard relay. The host (cockpit) sends its current Wizard state; the
   * backend fans it out VERBATIM to every other client and never interprets it.
   * Sent best-effort: if the socket is not open the message is simply dropped
   * (a viewer will catch up on the next transition's snapshot).
   */
  sendWizard(payload: Record<string, unknown>): void {
    if (!this.ws || this._state !== 'open') return; // best-effort; drop silently
    this.ws.send(JSON.stringify({ ...payload, type: 'wizard' }));
  }

  /**
   * §3.3 Logbook relay. The host (cockpit) broadcasts its current run state; the
   * backend fans it out verbatim to viewers. Best-effort: dropped silently if the
   * socket is not open (the next state change re-sends a full snapshot).
   */
  sendLogbook(payload: Record<string, unknown>): void {
    if (!this.ws || this._state !== 'open') return;
    this.ws.send(JSON.stringify({ ...payload, type: 'logbook' }));
  }

  // ── GET /health (§3.1/§3.4) ──────────────────────────────────────────────────

  async fetchHealth(): Promise<HealthStatus> {
    const httpUrl = this.healthUrl();
    const res = await fetch(httpUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`GET /health → ${res.status}`);
    const json = (await res.json()) as unknown;
    if (!isHealthStatus(json)) throw new Error('GET /health: unexpected body shape');
    return json;
  }

  /** Derive the http(s) /health url from the ws(s) /ws url. */
  private healthUrl(): string {
    try {
      const u = new URL(this.opts.url);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = u.pathname.replace(/\/ws\/?$/, '/health');
      if (!u.pathname.endsWith('/health')) u.pathname = '/health';
      return u.toString();
    } catch {
      return '/health';
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    if (this.ws) {
      this.setState('closing');
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        /* ignore */
      }
    } else {
      this.setState('closed');
    }
  }

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect || this.intentionalClose) return;
    this.clearReconnect();
    const delay = this.currentDelay;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    this.currentDelay = Math.min(this.currentDelay * 2, this.opts.maxReconnectDelayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
