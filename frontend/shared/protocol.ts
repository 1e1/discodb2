// discodb2 — CANONICAL protocol & data-model types (frontend/shared).
//
// SOURCE OF TRUTH: docs/DESIGN.md §3 (THE CONTRACT) and §3.5 (data model).
// This file is framework-free (no Svelte/Vite/DOM-only deps) so it can be
// imported by cockpit, copilot, a Web Worker, or a plain Node test runner.
//
// The cockpit/copilot builder agents implement the protocol independently;
// this module is the version everything CONSOLIDATES onto later. When you
// change the wire format here, you are changing the contract — bump VERSION
// and note the breaking change in DESIGN.md.
//
// Endianness: little-endian everywhere (DESIGN §3.2). Classic CAN only (DLC
// 0..8); CAN-FD is a future v2.

/* ────────────────────────────────────────────────────────────────────────
 * §3.2 — Binary frame stream (batch header + fixed 20-byte records)
 * ──────────────────────────────────────────────────────────────────────── */

/** Wire protocol version. Lives in byte 0 of every batch header. */
export const PROTOCOL_VERSION = 1 as const;

/** Batch header is a fixed 12 bytes. */
export const BATCH_HEADER_BYTES = 12 as const;

/** Each CAN record is a fixed 20 bytes. */
export const RECORD_BYTES = 20 as const;

/** Max classic-CAN payload length. */
export const MAX_DLC = 8 as const;

/** Batch header flag bits (byte 1 of the header). */
export const BatchFlag = {
  /** bit0: this batch was produced by the replay source (not a live bus). */
  REPLAY: 1 << 0,
} as const;
export type BatchFlag = (typeof BatchFlag)[keyof typeof BatchFlag];

/** Per-record flag bits (offset 9 of a record). */
export const RecFlag = {
  /** bit0: Remote Transmission Request. Other bits reserved (must be 0). */
  RTR: 1 << 0,
} as const;
export type RecFlag = (typeof RecFlag)[keyof typeof RecFlag];

/**
 * can_id bit layout (offset 4, u32, DESIGN §3.2).
 * bits 0–28 = identifier · bit30 = error frame · bit31 = extended (29-bit id).
 * (Mirrors the Linux SocketCAN can_id convention; bit29 RTR is carried in
 * rec_flags here, not in can_id.)
 */
export const CanIdBits = {
  /** Mask for the 29-bit identifier field (bits 0–28). */
  ID_MASK: 0x1fffffff,
  /** bit30: error frame. */
  ERROR: 1 << 30,
  /** bit31: extended (29-bit) identifier. Use >>> 0 to keep it unsigned. */
  EXTENDED: (1 << 31) >>> 0,
} as const;

/** A single decoded CAN record (the JS-side shape of a 20-byte record). */
export interface CanRecord {
  /** Offset from the batch `baseTimeUs`, microseconds (u32). */
  dtUs: number;
  /** 11-bit or 29-bit identifier (already masked to bits 0–28). */
  canId: number;
  /** Data length code, 0..8. */
  dlc: number;
  /** True if the extended (29-bit) flag was set. */
  isExtended: boolean;
  /** True if the error-frame flag was set. */
  isError: boolean;
  /** True if the RTR rec_flag bit was set. */
  isRtr: boolean;
  /** Payload. Exactly `dlc` bytes; the wire pads the rest with zeros. */
  data: Uint8Array;
}

/** A decoded batch: header fields plus its records. */
export interface CanBatch {
  /** Protocol version from header byte 0 (should equal PROTOCOL_VERSION). */
  version: number;
  /** True if BatchFlag.REPLAY was set. */
  replay: boolean;
  /** Monotonic microsecond base time for the batch (u64, header). */
  baseTimeUs: bigint;
  /** Decoded records (length === header `count`). */
  records: CanRecord[];
}

/**
 * Encode a batch to the §3.2 binary wire format.
 *
 * Pure: returns a fresh ArrayBuffer, mutates nothing. Throws RangeError on
 * out-of-spec input (DLC > 8, count > u16, etc.) so encode bugs fail loud
 * instead of producing a malformed batch on the hot path.
 */
export function encodeBatch(batch: {
  baseTimeUs: bigint;
  replay?: boolean;
  records: ReadonlyArray<{
    dtUs: number;
    canId: number;
    dlc: number;
    isExtended?: boolean;
    isError?: boolean;
    isRtr?: boolean;
    data: Uint8Array | ReadonlyArray<number>;
  }>;
}): ArrayBuffer {
  const count = batch.records.length;
  if (count > 0xffff) {
    throw new RangeError(`batch count ${count} exceeds u16 max (65535)`);
  }

  const buf = new ArrayBuffer(BATCH_HEADER_BYTES + count * RECORD_BYTES);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Header (12 bytes, little-endian).
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, batch.replay ? BatchFlag.REPLAY : 0);
  view.setUint16(2, count, true);
  view.setBigUint64(4, batch.baseTimeUs, true);

  // Records (20 bytes each).
  for (let i = 0; i < count; i++) {
    const r = batch.records[i];
    const off = BATCH_HEADER_BYTES + i * RECORD_BYTES;

    if (r.dlc < 0 || r.dlc > MAX_DLC) {
      throw new RangeError(`record ${i}: dlc ${r.dlc} out of range 0..8`);
    }
    const idField = r.canId & CanIdBits.ID_MASK;
    if ((r.canId & ~CanIdBits.ID_MASK) !== 0 && r.canId <= CanIdBits.ID_MASK) {
      // canId carried stray high bits but is itself a small number: caller
      // likely OR-ed flag bits into canId. Reject — flags are explicit fields.
      throw new RangeError(`record ${i}: canId has bits above 0..28 set; pass flags via isExtended/isError`);
    }

    let canIdWord = idField >>> 0;
    if (r.isExtended) canIdWord = (canIdWord | CanIdBits.EXTENDED) >>> 0;
    if (r.isError) canIdWord = (canIdWord | CanIdBits.ERROR) >>> 0;

    let recFlags = 0;
    if (r.isRtr) recFlags |= RecFlag.RTR;

    view.setUint32(off + 0, r.dtUs >>> 0, true);
    view.setUint32(off + 4, canIdWord, true);
    view.setUint8(off + 8, r.dlc);
    view.setUint8(off + 9, recFlags);
    view.setUint16(off + 10, 0, true); // reserved
    // data[8]: copy dlc bytes, the ArrayBuffer is already zero-filled past dlc.
    for (let b = 0; b < r.dlc; b++) {
      u8[off + 12 + b] = r.data[b] & 0xff;
    }
  }

  return buf;
}

/**
 * Decode a §3.2 binary batch.
 *
 * Pure: reads `buf`, allocates fresh output, mutates nothing. The returned
 * record `data` arrays are views' copies (length === dlc). Throws RangeError
 * if the buffer is too short for its declared `count` — a truncated frame is
 * a protocol error, not silently tolerated.
 *
 * `buf` may be an ArrayBuffer or any ArrayBufferView (e.g. a Uint8Array
 * received from a WebSocket); the view's byteOffset/byteLength are honored.
 */
export function decodeBatch(buf: ArrayBuffer | ArrayBufferView): CanBatch {
  let ab: ArrayBuffer;
  let byteOffset = 0;
  let byteLength: number;
  if (ArrayBuffer.isView(buf)) {
    ab = buf.buffer as ArrayBuffer;
    byteOffset = buf.byteOffset;
    byteLength = buf.byteLength;
  } else {
    ab = buf;
    byteLength = buf.byteLength;
  }

  if (byteLength < BATCH_HEADER_BYTES) {
    throw new RangeError(`batch shorter than ${BATCH_HEADER_BYTES}-byte header (got ${byteLength})`);
  }

  const view = new DataView(ab, byteOffset, byteLength);
  const version = view.getUint8(0);
  const flags = view.getUint8(1);
  const count = view.getUint16(2, true);
  const baseTimeUs = view.getBigUint64(4, true);

  const need = BATCH_HEADER_BYTES + count * RECORD_BYTES;
  if (byteLength < need) {
    throw new RangeError(`batch truncated: count=${count} needs ${need} bytes, got ${byteLength}`);
  }

  const records: CanRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = BATCH_HEADER_BYTES + i * RECORD_BYTES;
    const dtUs = view.getUint32(off + 0, true);
    const canIdWord = view.getUint32(off + 4, true);
    const dlcRaw = view.getUint8(off + 8);
    const recFlags = view.getUint8(off + 9);
    // off+10..11 reserved (ignored on decode).

    const dlc = Math.min(dlcRaw, MAX_DLC);
    const data = new Uint8Array(dlc);
    for (let b = 0; b < dlc; b++) {
      data[b] = view.getUint8(off + 12 + b);
    }

    records[i] = {
      dtUs,
      canId: canIdWord & CanIdBits.ID_MASK,
      dlc,
      isExtended: (canIdWord & CanIdBits.EXTENDED) !== 0,
      isError: (canIdWord & CanIdBits.ERROR) !== 0,
      isRtr: (recFlags & RecFlag.RTR) !== 0,
      data,
    };
  }

  return {
    version,
    replay: (flags & BatchFlag.REPLAY) !== 0,
    baseTimeUs,
    records,
  };
}

/** Absolute monotonic timestamp of a record = batch base + record offset. */
export function recordTimeUs(batch: CanBatch, rec: CanRecord): bigint {
  return batch.baseTimeUs + BigInt(rec.dtUs);
}

/* ────────────────────────────────────────────────────────────────────────
 * §3.3 — Control messages (client → server, JSON text)
 * ──────────────────────────────────────────────────────────────────────── */

/** Which frontend is connecting. */
export type ClientKind = "cockpit" | "copilot";

/** CAN source the backend can open (DESIGN §3.3 / §5). */
export type CanSource = "sim" | "socketcan" | "gs_usb" | "slcan" | "replay";

export interface HelloMsg {
  type: "hello";
  client: ClientKind;
}

export interface StartMsg {
  type: "start";
  source: CanSource;
  bitrate: number;
  /**
   * Listen-only request. The SERVER enforces this for any live source
   * (DESIGN §4.1): a request to disable it is refused or clamped. This field
   * is advisory from the client's side — the guarantee is server-side.
   */
  listen_only: boolean;
  /** Replay only: file to stream. */
  file?: string;
}

export interface StopMsg {
  type: "stop";
}

export interface RecordStartMsg {
  type: "record_start";
  /** Optional human name for the recording. */
  name?: string;
}

export interface RecordStopMsg {
  type: "record_stop";
}

export interface ListFilesMsg {
  type: "list_files";
}

/** Discriminated union of every client→server control message. */
export type ClientMessage =
  | HelloMsg
  | StartMsg
  | StopMsg
  | RecordStartMsg
  | RecordStopMsg
  | ListFilesMsg;

/** Serialize a control message to a JSON text frame. */
export function encodeControl(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a JSON text frame into a control message.
 *
 * Returns the parsed object typed as ClientMessage if it has a known `type`,
 * otherwise null. Kept intentionally tiny: the backend is the real validator
 * (DESIGN §4 — the guarantee never depends on the client).
 */
export function decodeControl(text: string): ClientMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const type = (obj as { type?: unknown }).type;
  switch (type) {
    case "hello":
    case "start":
    case "stop":
    case "record_start":
    case "record_stop":
    case "list_files":
      return obj as ClientMessage;
    default:
      return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * §3.4 — Status / Health (server → client text, and GET /health JSON)
 * ──────────────────────────────────────────────────────────────────────── */

/** Bus run state. "LIVE" for a real/sim bus actively streaming. */
export type BusState = "LIVE" | "STOPPED" | "ERROR" | "REPLAY";

export interface BusHealth {
  bitrate: number;
  state: BusState;
  fps: number;
  fps_avg: number;
  total: number;
  unique_ids: number;
  errors: number;
  /** Milliseconds since the last frame (relative; never wall clock). */
  last_frame_ms: number;
  /** Estimated bus load, 0.0..1.0. */
  bus_load: number;
}

export interface StreamHealth {
  clients: number;
  out_bps: number;
  dropped: number;
}

export interface RecordHealth {
  active: boolean;
  file: string | null;
  size: number;
  disk_free: number;
}

export interface ProcHealth {
  cpu: number;
  rss: number;
  reader_q: number;
  ws_q: number;
}

/** The full health/status object (DESIGN §3.4). */
export interface Health {
  /** Seconds since backend start (monotonic; the Pi has no RTC). */
  uptime_s: number;
  source: CanSource;
  listen_only: boolean;
  /** Recording name if active, else null. */
  recording: string | null;
  bus: BusHealth;
  stream: StreamHealth;
  record: RecordHealth;
  proc: ProcHealth;
}

/** server→client: directory listing in response to list_files. */
export interface FilesMsg {
  type: "files";
  files: string[];
}

/** server→client: error notification. */
export interface ErrorMsg {
  type: "error";
  message: string;
}

/**
 * Server→client text frames carry either a tagged message (`files`/`error`)
 * or a bare Health object (which has no `type` field, per §3.4).
 */
export type ServerMessage = FilesMsg | ErrorMsg | Health;

/** True if a parsed server text frame is a Health snapshot (no `type` tag). */
export function isHealth(msg: ServerMessage): msg is Health {
  return !("type" in msg) && "uptime_s" in msg;
}

/* ────────────────────────────────────────────────────────────────────────
 * §3.5 — Data model (Signal / FrameDef / Project)
 * ──────────────────────────────────────────────────────────────────────── */

/** Byte order of a signal's bit range within its frame. */
export type ByteOrder = "big" | "little";

/** One signal: a bit range within a frame mapped to a physical value. */
export interface Signal {
  id: string;
  frameId: number;
  isExtended: boolean;
  bitStart: number;
  bitLength: number;
  byteOrder: ByteOrder;
  /** Physical = raw * factor + offset. */
  factor: number;
  offset: number;
  unit: string;
  name: string;
}

/** A CAN frame definition: an arbitration id carrying multiple signals. */
export interface FrameDef {
  id: number;
  isExtended: boolean;
  name: string;
  signals: Signal[];
}

/** A reverse-engineering project: a named set of frame definitions. */
export interface Project {
  name: string;
  frames: FrameDef[];
}
