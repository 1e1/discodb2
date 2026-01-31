// §3.2 Frame stream parser — binary, little-endian, batched ~20–50 ms.
//
// Batch header (12 bytes):
//   version:u8(=1) · flags:u8 (bit0 1=replay) · count:u16 · base_t_us:u64
// Then count × 20-byte record:
//   off 0  dt_us      u32  offset from base_t_us
//   off 4  can_id     u32  bits0–28 id · bit30 error · bit31 extended(29-bit)
//   off 8  dlc        u8   0..8
//   off 9  rec_flags  u8   bit0 RTR (reserved else)
//   off 10 reserved   u16  0
//   off 12 data       u8[8] bytes >= dlc are 0
//
// Fixed-size records → trivial DataView parsing. Classic CAN only (<=8).
//
// Bounded-memory posture: we do NOT allocate a CanRecord array or copy each
// payload. We iterate and invoke a caller-supplied sink per record, reusing a
// single scratch Uint8Array for `data`. The caller must consume synchronously.

import type { CanRecord } from "./types";

export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 12;
export const RECORD_BYTES = 20;

export const FLAG_REPLAY = 0b0000_0001;
export const CAN_ID_MASK = 0x1fff_ffff; // bits 0–28
export const CAN_ID_ERROR = 0x4000_0000; // bit 30
export const CAN_ID_EXTENDED = 0x8000_0000; // bit 31
export const REC_FLAG_RTR = 0b0000_0001;

export interface BatchMeta {
  version: number;
  isReplay: boolean;
  count: number;
  baseTUs: number;
}

export type RecordSink = (rec: CanRecord, meta: BatchMeta) => void;

export class BatchParseError extends Error {}

// Single reusable scratch payload shared across every record of every batch.
// The CanRecord handed to the sink points `data` at this array; never retained.
const scratchData = new Uint8Array(8);

// One mutable CanRecord object reused per record (no per-record allocation).
const scratchRecord: CanRecord = {
  tUs: 0,
  id: 0,
  isError: false,
  isExtended: false,
  dlc: 0,
  isRtr: false,
  data: scratchData,
};

/**
 * Parse one binary batch frame and invoke `sink` for each decoded record.
 *
 * @param buf  the WebSocket binary frame (ArrayBuffer)
 * @param sink called once per record, synchronously, in order
 * @returns the batch metadata (header)
 *
 * Throws BatchParseError on a malformed/truncated frame or unknown version so
 * the caller can decide whether to drop the frame (we never throw past the WS
 * read loop — a bad frame must not kill the connection).
 */
export function parseBatch(buf: ArrayBuffer, sink: RecordSink): BatchMeta {
  if (buf.byteLength < HEADER_BYTES) {
    throw new BatchParseError(
      `batch too short: ${buf.byteLength} < ${HEADER_BYTES}`,
    );
  }

  const view = new DataView(buf);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new BatchParseError(`unsupported protocol version ${version}`);
  }
  const flags = view.getUint8(1);
  const count = view.getUint16(2, /* le */ true);
  // base_t_us is u64 µs. Number can exactly represent integers up to 2^53;
  // monotonic µs stays well under that for any realistic session, so reading
  // as a Number (via getBigUint64 → Number) is safe and avoids BigInt math on
  // the hot path.
  const baseTUs = Number(view.getBigUint64(4, /* le */ true));

  const expected = HEADER_BYTES + count * RECORD_BYTES;
  if (buf.byteLength < expected) {
    throw new BatchParseError(
      `batch truncated: have ${buf.byteLength}, need ${expected} for ${count} records`,
    );
  }

  const meta: BatchMeta = {
    version,
    isReplay: (flags & FLAG_REPLAY) !== 0,
    count,
    baseTUs,
  };

  let off = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const dtUs = view.getUint32(off + 0, true);
    const rawId = view.getUint32(off + 4, true);
    const dlc = view.getUint8(off + 8);
    const recFlags = view.getUint8(off + 9);
    // off+10..11 reserved (ignored)

    scratchRecord.tUs = baseTUs + dtUs;
    scratchRecord.id = rawId & CAN_ID_MASK;
    scratchRecord.isError = (rawId & CAN_ID_ERROR) !== 0;
    scratchRecord.isExtended = (rawId & CAN_ID_EXTENDED) !== 0;
    // Clamp dlc to 0..8 (classic CAN). A misbehaving sender can't make us read
    // out of the 8-byte payload window.
    const n = dlc > 8 ? 8 : dlc;
    scratchRecord.dlc = n;
    scratchRecord.isRtr = (recFlags & REC_FLAG_RTR) !== 0;

    const dataOff = off + 12;
    for (let b = 0; b < 8; b++) {
      scratchData[b] = b < n ? view.getUint8(dataOff + b) : 0;
    }

    sink(scratchRecord, meta);
    off += RECORD_BYTES;
  }

  return meta;
}
