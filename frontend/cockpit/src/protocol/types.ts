/**
 * discodb2 wire protocol types — DIRECT implementation of DESIGN.md §3.2/3.3/3.4.
 *
 * This module is the single source of truth for the on-the-wire shapes. It is
 * intentionally self-contained (no dependency on frontend/shared/, which is
 * built in parallel) so the cockpit is runnable standalone. When shared/ lands
 * we consolidate these against the canonical types.
 *
 * Endianness on the wire: LITTLE-ENDIAN (§3.2). All parsing uses DataView with
 * littleEndian=true explicitly.
 */

// ────────────────────────────────────────────────────────────────────────────
// §3.2 Frame stream (binary, little-endian, batched ~20–50 ms)
// ────────────────────────────────────────────────────────────────────────────

/** Batch header is 12 bytes. */
export const BATCH_HEADER_BYTES = 12;
/** Each record is exactly 20 bytes. */
export const RECORD_BYTES = 20;
/** Protocol version carried in the batch header (§3.2: version:u8 == 1). */
export const PROTOCOL_VERSION = 1;

/** Batch header flags (byte offset 1 in the header). */
export const BATCH_FLAG_REPLAY = 0x01; // bit0 1=replay

/** can_id bit fields (§3.2: bits0–28 id · bit30 error · bit31 extended). */
export const CAN_ID_MASK = 0x1fffffff; // bits 0–28 (29-bit id space)
export const CAN_ID_ERROR_BIT = 1 << 30; // bit30 error
export const CAN_ID_EXTENDED_BIT = 1 << 31; // bit31 extended (29-bit) frame

/** rec_flags bits (§3.2: bit0 RTR, reserved else). */
export const REC_FLAG_RTR = 0x01;

/**
 * A single decoded CAN frame, as produced by the parser worker.
 *
 * `tUs` is the backend monotonic/HW timestamp in microseconds, reconstructed as
 * `base_t_us + dt_us`. It is NOT wall-clock (§4.2): wall clock is assigned by
 * the connecting client (see SessionClock).
 */
export interface CanFrame {
  /** Backend monotonic microsecond timestamp (base_t_us + dt_us). */
  tUs: number;
  /** 11- or 29-bit arbitration id (already masked, no flag bits). */
  id: number;
  /** True if this was an extended (29-bit) frame. */
  isExtended: boolean;
  /** True if this is an error frame (bit30 of can_id). */
  isError: boolean;
  /** True if this is a Remote Transmission Request (rec_flags bit0). */
  isRtr: boolean;
  /** Data length code, 0..8 (classic CAN only). */
  dlc: number;
  /**
   * Payload bytes. Length is exactly `dlc` (we slice off the always-zero
   * padding bytes >= dlc described by §3.2). Backed by a copy so it survives
   * the transferable ArrayBuffer of the source batch.
   */
  data: Uint8Array;
}

/** Metadata about a parsed batch, surfaced for diagnostics. */
export interface BatchMeta {
  version: number;
  isReplay: boolean;
  count: number;
  baseTUs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// §3.3 Control (client→server, JSON text)
// ────────────────────────────────────────────────────────────────────────────

export type ClientKind = 'cockpit' | 'copilot';

export type CanSource = 'sim' | 'socketcan' | 'gs_usb' | 'slcan' | 'replay';

export interface HelloMsg {
  type: 'hello';
  client: ClientKind;
}

export interface StartMsg {
  type: 'start';
  source: CanSource;
  bitrate: number;
  /**
   * Listen-only is enforced server-side for live sources (§4.1). The client
   * sends `true`; a request to disable is refused/clamped by the backend.
   */
  listen_only: boolean;
  /** Only meaningful for source === 'replay'. */
  file?: string;
}

export interface StopMsg {
  type: 'stop';
}

export interface RecordStartMsg {
  type: 'record_start';
  name?: string;
}

export interface RecordStopMsg {
  type: 'record_stop';
}

export interface ListFilesMsg {
  type: 'list_files';
}

/**
 * §3.3 Wizard relay (host → viewers). The backend fans this out VERBATIM to
 * every OTHER connected client and never interprets it — the payload is opaque
 * to the backend (zero compute). The cockpit is the Wizard HOST and emits its
 * current state (phase, rep/good/target, silence, cue mode, top candidates) so
 * copilot/2nd-screen viewers can mirror the flow.
 */
export interface WizardMsg {
  type: 'wizard';
  /** Opaque to the backend; shape is the host's WizardRelayPayload. */
  [key: string]: unknown;
}

/**
 * §3.3 per-trial verdict (any device → host). A viewer (e.g. copilot phone) can
 * submit the operator's ✓/✗/abandon/skip; the host feeds it into the feedback
 * FSM. The cockpit-as-host RECEIVES these (relayed from viewers); it does not
 * normally send them (it has its own buttons), but the type is defined for the
 * inbound path.
 */
export interface TrialFeedbackMsg {
  type: 'trialFeedback';
  action: 'success' | 'fail' | 'abandon' | 'skip';
  /** Backend µs the verdict was given (optional, advisory). */
  at?: number;
}

/**
 * §3.3 Logbook relay (host → viewers): the cockpit's current run state, fanned out
 * verbatim so a copilot can MIRROR the storyboard read-only. Opaque to the backend
 * (shape = the host's LogbookRelayPayload).
 */
export interface LogbookRelayMsg {
  type: 'logbook';
  [key: string]: unknown;
}

/**
 * §3.3 Logbook command (viewer → host): the copilot can pick + start a scenario,
 * stop a run, or advance an "on input" phase. The cockpit-as-host RECEIVES these
 * (relayed from viewers) and drives its run controller.
 */
export interface LogbookCmdMsg {
  type: 'logbookCmd';
  command: 'start' | 'stop' | 'next';
  /** For 'start': which scenario to run. */
  scenarioId?: string;
}

export type ControlMsg =
  | HelloMsg
  | StartMsg
  | StopMsg
  | RecordStartMsg
  | RecordStopMsg
  | ListFilesMsg
  | WizardMsg
  | TrialFeedbackMsg
  | LogbookRelayMsg
  | LogbookCmdMsg;

/** Structural guard for an inbound Wizard relay message (server→other clients). */
export function isWizardMsg(msg: unknown): msg is WizardMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'wizard';
}

/** Structural guard for an inbound trialFeedback message (viewer→host). */
export function isTrialFeedbackMsg(msg: unknown): msg is TrialFeedbackMsg {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'trialFeedback'
  );
}

/** Structural guard for an inbound Logbook command (viewer→host). */
export function isLogbookCmdMsg(msg: unknown): msg is LogbookCmdMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'logbookCmd';
}

// ────────────────────────────────────────────────────────────────────────────
// §3.4 Status / Health (server→client text, and GET /health JSON)
// ────────────────────────────────────────────────────────────────────────────

export interface BusStatus {
  bitrate: number;
  /** e.g. "LIVE". Free-form per backend. */
  state: string;
  fps: number;
  fps_avg: number;
  total: number;
  unique_ids: number;
  errors: number;
  last_frame_ms: number;
  bus_load: number;
}

export interface StreamStatus {
  clients: number;
  out_bps: number;
  dropped: number;
}

export interface RecordStatus {
  active: boolean;
  file: string | null;
  size: number;
  disk_free: number;
}

export interface ProcStatus {
  cpu: number;
  rss: number;
  reader_q: number;
  ws_q: number;
}

/** The §3.4 status/health object (server→client text AND GET /health body). */
export interface HealthStatus {
  uptime_s: number;
  source: string;
  listen_only: boolean;
  recording: string | null;
  bus: BusStatus;
  stream: StreamStatus;
  record: RecordStatus;
  proc: ProcStatus;
}

/** {"type":"files","files":[...]} */
export interface FilesMsg {
  type: 'files';
  files: string[];
}

/** {"type":"error","message":"..."} */
export interface ErrorMsg {
  type: 'error';
  message: string;
}

/**
 * Server→client JSON text frames. The status object (§3.4) does not carry a
 * `type` discriminator in the contract, so it is detected structurally (it has
 * a `bus` field). `files` and `error` are tagged.
 */
export type ServerMsg = HealthStatus | FilesMsg | ErrorMsg;

/** Structural guard: is this parsed JSON the §3.4 status object? */
export function isHealthStatus(msg: unknown): msg is HealthStatus {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'bus' in msg &&
    'stream' in msg &&
    'uptime_s' in msg
  );
}

export function isFilesMsg(msg: unknown): msg is FilesMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'files';
}

export function isErrorMsg(msg: unknown): msg is ErrorMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'error';
}
