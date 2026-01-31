/**
 * Binary batch parser — DIRECT implementation of DESIGN.md §3.2.
 *
 * Layout (all little-endian):
 *   Batch header (12 bytes):
 *     off 0  version  u8  (== 1)
 *     off 1  flags    u8  (bit0 1=replay)
 *     off 2  count    u16
 *     off 4  base_t_us u64 (monotonic µs)
 *   Then `count` × 20-byte record:
 *     off 0  dt_us     u32  (offset from base_t_us)
 *     off 4  can_id    u32  (bits0–28 id · bit30 error · bit31 extended)
 *     off 8  dlc       u8   (0..8)
 *     off 9  rec_flags u8   (bit0 RTR)
 *     off 10 reserved  u16  (0)
 *     off 12 data      u8[8] (bytes >= dlc are 0)
 *
 * Fixed-size records → trivial DataView parsing. This function is pure and
 * runs inside the parser Web Worker (heavy path off the main thread).
 */

import {
  BATCH_FLAG_REPLAY,
  BATCH_HEADER_BYTES,
  CAN_ID_ERROR_BIT,
  CAN_ID_EXTENDED_BIT,
  CAN_ID_MASK,
  PROTOCOL_VERSION,
  RECORD_BYTES,
  REC_FLAG_RTR,
  type BatchMeta,
  type CanFrame,
} from './types';

export interface ParseResult {
  meta: BatchMeta;
  frames: CanFrame[];
}

export class BatchParseError extends Error {}

/**
 * Parse one binary batch frame.
 *
 * @param buffer the raw ArrayBuffer received from the WebSocket (a single
 *   binary message == one batch).
 * @throws BatchParseError on a truncated/malformed batch or version mismatch.
 */
export function parseBatch(buffer: ArrayBuffer): ParseResult {
  if (buffer.byteLength < BATCH_HEADER_BYTES) {
    throw new BatchParseError(
      `batch too small: ${buffer.byteLength} < header ${BATCH_HEADER_BYTES}`,
    );
  }

  const view = new DataView(buffer);
  const LE = true;

  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new BatchParseError(`unsupported batch version ${version} (expected ${PROTOCOL_VERSION})`);
  }
  const flags = view.getUint8(1);
  const isReplay = (flags & BATCH_FLAG_REPLAY) !== 0;
  const count = view.getUint16(2, LE);

  // base_t_us is u64 µs. JS numbers are safe to 2^53; a 64-bit µs counter wraps
  // 2^53 µs ≈ 285 years, so Number(BigInt) is exact for any realistic uptime.
  const baseTUs = Number(view.getBigUint64(4, LE));

  const expectedBytes = BATCH_HEADER_BYTES + count * RECORD_BYTES;
  if (buffer.byteLength < expectedBytes) {
    throw new BatchParseError(
      `batch truncated: have ${buffer.byteLength}, need ${expectedBytes} for count=${count}`,
    );
  }

  const frames: CanFrame[] = new Array(count);

  let off = BATCH_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const dtUs = view.getUint32(off + 0, LE);
    const rawId = view.getUint32(off + 4, LE);
    const dlcRaw = view.getUint8(off + 8);
    const recFlags = view.getUint8(off + 9);
    // off+10 reserved u16 — ignored.

    const dlc = dlcRaw > 8 ? 8 : dlcRaw; // classic CAN clamps at 8 (§3.2)

    // Copy only the meaningful bytes (0..dlc). Padding bytes are spec-zero.
    const data = new Uint8Array(dlc);
    const dataOff = off + 12;
    for (let b = 0; b < dlc; b++) {
      data[b] = view.getUint8(dataOff + b);
    }

    frames[i] = {
      tUs: baseTUs + dtUs,
      id: rawId & CAN_ID_MASK,
      isExtended: (rawId & CAN_ID_EXTENDED_BIT) !== 0,
      isError: (rawId & CAN_ID_ERROR_BIT) !== 0,
      isRtr: (recFlags & REC_FLAG_RTR) !== 0,
      dlc,
      data,
    };

    off += RECORD_BYTES;
  }

  return {
    meta: { version, isReplay, count, baseTUs },
    frames,
  };
}
