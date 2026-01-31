// Signal extraction from an 8-byte CAN payload, per the §3.5 data model.
//
// A Signal pins a bit range (bitStart/bitLength) with a byteOrder, then a
// physical value = raw * factor + offset, in `unit`.
//
// Endianness conventions (matching DBC / cantools, which §3.5 says we map to):
//   • "little" (Intel): bitStart is the LSB position counting from bit 0 of
//     byte 0; the value grows toward higher bit indices.
//   • "big" (Motorola, sawtooth/MSB): bitStart is the MSB position in DBC
//     "start bit" numbering where bit (7 - bitInByte) within each byte; we walk
//     downward, crossing byte boundaries by moving to the next byte's MSB.
//
// We only support unsigned extraction here (the copilot is a glance view; the
// Project signals it ships are unsigned). Signed/float scaling is a cockpit
// concern. Values stay within 53-bit-safe integers for any <=32-bit field.

import type { Signal } from "./types";

/**
 * Read `bitLength` bits as an unsigned integer from `data` (8 bytes) using the
 * given byte order, starting at `bitStart`. Returns the raw integer (pre
 * factor/offset). Out-of-range bits read as 0.
 */
export function extractRaw(
  data: Uint8Array,
  bitStart: number,
  bitLength: number,
  byteOrder: "big" | "little",
): number {
  let value = 0;

  if (byteOrder === "little") {
    // LSB-first: bit i of the field maps to absolute bit (bitStart + i),
    // where absolute bit b lives in byte (b >> 3) at in-byte position (b & 7).
    for (let i = 0; i < bitLength; i++) {
      const abs = bitStart + i;
      const byteIdx = abs >> 3;
      const bitIdx = abs & 7;
      if (byteIdx >= 0 && byteIdx < data.length) {
        const bit = (data[byteIdx] >> bitIdx) & 1;
        // Use multiplication instead of <<: shifts are 32-bit in JS and the
        // field may exceed 31 bits.
        value += bit * Math.pow(2, i);
      }
    }
    return value;
  }

  // Big-endian / Motorola MSB-first ("sawtooth"). DBC start-bit numbering:
  // within byte k, bit positions are k*8 + (7 - localBit). We start at the MSB
  // (bitStart) and consume toward the LSB; each step decrements the in-byte
  // position and rolls to the next byte's MSB at a boundary.
  let bytePos = bitStart >> 3;
  let bitPos = bitStart & 7;
  for (let i = 0; i < bitLength; i++) {
    if (bytePos >= 0 && bytePos < data.length) {
      const bit = (data[bytePos] >> bitPos) & 1;
      value = value * 2 + bit;
    } else {
      value = value * 2;
    }
    // Move to the next-lower significance bit.
    if (bitPos === 0) {
      bitPos = 7;
      bytePos += 1; // next byte, MSB
    } else {
      bitPos -= 1;
    }
  }
  return value;
}

/** Decode a signal to its physical value: raw * factor + offset. */
export function decodeSignal(sig: Signal, data: Uint8Array): number {
  const raw = extractRaw(data, sig.bitStart, sig.bitLength, sig.byteOrder);
  return raw * sig.factor + sig.offset;
}
