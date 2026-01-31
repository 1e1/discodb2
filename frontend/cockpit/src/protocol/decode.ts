/**
 * Signal decoding: extract a bit range from a CAN payload and apply
 * factor/offset (DESIGN.md §3.5 — "basic decode (bit range, endianness,
 * factor, offset, unit) with a live-computed value").
 *
 * Two conventions are supported via Signal.byteOrder, matching the DBC world:
 *
 *  - "little"  → Intel / LSB-first. `bitStart` is the LSB of the signal,
 *    counted in the standard CAN bit numbering (bit = byteIndex*8 + bitInByte,
 *    bitInByte 0 = LSB of that byte). The signal occupies bitStart ..
 *    bitStart+bitLength-1 ascending.
 *
 *  - "big"     → Motorola / MSB-first (sawtooth). `bitStart` is the MSB of the
 *    signal in DBC "sawtooth" numbering; bits proceed towards the LSB crossing
 *    byte boundaries by the Motorola walk.
 *
 * We decode using BigInt to support up to 64-bit signals without precision
 * loss, then convert to Number for the scaled physical value (phys values are
 * displayed; >53-bit *raw* integers are rare and flagged by the caller if
 * needed).
 */

import type { EditableSignal } from './datamodel';

/** Read a single bit (0/1) from a byte array at standard CAN bit index. */
function getBit(data: Uint8Array, bitIndex: number): number {
  const byteIndex = bitIndex >> 3;
  const bitInByte = bitIndex & 7; // 0 = LSB
  if (byteIndex < 0 || byteIndex >= data.length) return 0;
  return (data[byteIndex] >> bitInByte) & 1;
}

/**
 * Compute the ascending list of standard-CAN bit indices that make up the
 * signal, ordered LSB→MSB (index 0 of the returned array is the signal LSB).
 */
function signalBitOrder(sig: Pick<EditableSignal, 'bitStart' | 'bitLength' | 'byteOrder'>): number[] {
  const { bitStart, bitLength, byteOrder } = sig;
  const bits: number[] = [];

  if (byteOrder === 'little') {
    // Intel: contiguous ascending from the LSB.
    for (let i = 0; i < bitLength; i++) bits.push(bitStart + i);
    return bits;
  }

  // Motorola / big-endian "sawtooth". bitStart is the MSB in DBC numbering,
  // where within a byte the MSB is local bit 7. We walk MSB→LSB and prepend so
  // the returned array stays LSB-first.
  let byteIndex = bitStart >> 3;
  let bitInByte = bitStart & 7; // this is the MSB of the signal (local)
  for (let i = 0; i < bitLength; i++) {
    const canBit = byteIndex * 8 + bitInByte;
    bits.unshift(canBit); // building LSB-first
    if (bitInByte === 0) {
      // crossed to the next byte (Motorola walk moves to higher byte index)
      bitInByte = 7;
      byteIndex += 1;
    } else {
      bitInByte -= 1;
    }
  }
  return bits;
}

/** Extract the raw (unscaled) integer value as a BigInt. */
export function extractRaw(
  data: Uint8Array,
  sig: Pick<EditableSignal, 'bitStart' | 'bitLength' | 'byteOrder' | 'signed'>,
): bigint {
  const order = signalBitOrder(sig);
  let raw = 0n;
  for (let i = 0; i < order.length; i++) {
    if (getBit(data, order[i])) raw |= 1n << BigInt(i);
  }

  if (sig.signed) {
    const signBit = 1n << BigInt(sig.bitLength - 1);
    if ((raw & signBit) !== 0n) {
      raw -= 1n << BigInt(sig.bitLength);
    }
  }
  return raw;
}

export interface DecodeResult {
  /** Raw integer (pre-scale), exact. */
  raw: bigint;
  /** Physical value = raw * factor + offset. */
  value: number;
  /** True if `data` was too short to contain the whole signal. */
  truncated: boolean;
}

/**
 * Decode a single signal against a payload, returning raw + physical value.
 */
export function decodeSignal(data: Uint8Array, sig: EditableSignal): DecodeResult {
  const lastBitIndex = highestBitIndex(sig);
  const truncated = lastBitIndex >> 3 >= data.length;
  const raw = extractRaw(data, sig);
  const value = Number(raw) * sig.factor + sig.offset;
  return { raw, value, truncated };
}

/** The highest standard-CAN bit index touched by the signal (for bounds checks). */
function highestBitIndex(sig: Pick<EditableSignal, 'bitStart' | 'bitLength' | 'byteOrder'>): number {
  const order = signalBitOrder(sig);
  let max = 0;
  for (const b of order) if (b > max) max = b;
  return max;
}

/** Format a physical value for display (trims noise, keeps small magnitudes readable). */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toString();
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  return value.toPrecision(4);
}
