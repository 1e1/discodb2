/**
 * User formulas — turn a frame's raw bytes into a human-readable value.
 *
 * Two flavours, same engine: a PER-FRAME formula ("Custom") and a PER-TAB
 * formula ("Tab"). Both are written in a small, SAFE math expression language
 * (expr-eval — no `eval`, fine for the PWA's CSP) over the frame's data bytes.
 *
 * BYTE NAMING follows the OBD-II convention (see Wikipedia "OBD-II PIDs"):
 *   A,B,C,D,E,F,G,H = data[0..7]   (0 when the frame is shorter)
 *   bytes           = the full byte array
 *   len             = DLC (number of bytes)
 * So a 16-bit big-endian value is `256*A + B` and engine RPM is `(256*A+B)/4`.
 *
 * `^` is EXPONENTIATION in expr-eval (not xor). Bitwise ops aren't native, so we
 * inject helper functions: band/bor/bxor/shl/shr/bit and u16/s16/u32 combiners.
 * Standard math (abs, floor, ceil, round, sqrt, min, max, …) is built in.
 */

import { Parser, type Expression } from 'expr-eval';
import { signalBitOrder } from './decode';
import type { EditableSignal, FormulaDef } from './datamodel';

// One parser instance carrying our injected helpers. expr-eval's STATIC
// Parser.parse uses a bare parser without these, so we always use this instance.
const parser = new Parser();

const u8 = (x: number) => x & 0xff;
parser.functions.u16 = (hi: number, lo: number) => ((u8(hi) << 8) | u8(lo)) >>> 0; // big-endian
parser.functions.u16le = (lo: number, hi: number) => ((u8(hi) << 8) | u8(lo)) >>> 0;
parser.functions.s16 = (hi: number, lo: number) => {
  const v = ((u8(hi) << 8) | u8(lo)) & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
};
parser.functions.u32 = (a: number, b: number, c: number, d: number) =>
  (u8(a) * 0x1000000 + (u8(b) << 16) + (u8(c) << 8) + u8(d)) >>> 0;
parser.functions.band = (x: number, m: number) => (x & m) >>> 0;
parser.functions.bor = (x: number, m: number) => (x | m) >>> 0;
parser.functions.bxor = (x: number, m: number) => (x ^ m) >>> 0;
parser.functions.shl = (x: number, n: number) => (x << n) >>> 0;
parser.functions.shr = (x: number, n: number) => x >>> n;
parser.functions.bit = (x: number, n: number) => (x >>> n) & 1;

// Compile-once cache: formulas are evaluated per-row on every snapshot (~10 Hz),
// so we parse each distinct expression a single time.
interface Compiled {
  expr?: Expression;
  error?: string;
}
const cache = new Map<string, Compiled>();

function compile(src: string): Compiled {
  const hit = cache.get(src);
  if (hit) return hit;
  let c: Compiled;
  try {
    c = { expr: parser.parse(src) };
  } catch (e) {
    c = { error: e instanceof Error ? e.message : String(e) };
  }
  cache.set(src, c);
  return c;
}

/** Validate a formula without data — returns an error string, or null if OK. */
export function checkFormula(src: string): string | null {
  if (!src.trim()) return null;
  return compile(src).error ?? null;
}

/** Byte variables (A..H, bytes, len) for an expression. */
function byteVars(data: Uint8Array): Record<string, number | number[]> {
  const at = (i: number) => (i < data.length ? data[i] : 0);
  return {
    A: at(0), B: at(1), C: at(2), D: at(3),
    E: at(4), F: at(5), G: at(6), H: at(7),
    bytes: Array.from(data),
    len: data.length,
  };
}

export interface FormulaResult {
  /** True when a non-empty formula evaluated without error. */
  ok: boolean;
  /** Raw evaluated value (number / boolean / string). */
  value?: number | boolean | string;
  /** Display string (rounded number + unit). */
  display?: string;
  /** Parse or evaluation error, if any. */
  error?: string;
}

/** Round to at most 3 decimals, dropping trailing zeros. */
function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/** Evaluate a formula against a frame's bytes. Empty formula → { ok:false }. */
export function evalFormula(src: string, data: Uint8Array, unit?: string): FormulaResult {
  if (!src || !src.trim()) return { ok: false };
  const c = compile(src);
  if (c.error || !c.expr) return { ok: false, error: c.error ?? 'parse error' };
  try {
    const vars = byteVars(data) as Parameters<Expression['evaluate']>[0];
    const v = c.expr.evaluate(vars) as number | boolean | string;
    const display =
      typeof v === 'number' ? fmtNumber(v) + (unit ? ` ${unit}` : '') : String(v);
    return { ok: true, value: v, display };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Evaluate a formula over NAMED variables instead of payload bytes — the basis
 * of a DERIVED signal (a channel over other signals' DECODED values). `vars`
 * maps each in-scope signal NAME to its current physical value; the same parser
 * (math + bit helpers) applies. A reference to an unknown name throws → { ok:false }.
 */
export function evalNamedFormula(
  src: string,
  vars: Record<string, number>,
  unit?: string,
): FormulaResult {
  if (!src || !src.trim()) return { ok: false };
  const c = compile(src);
  if (c.error || !c.expr) return { ok: false, error: c.error ?? 'parse error' };
  try {
    const v = c.expr.evaluate(vars as Parameters<Expression['evaluate']>[0]) as
      | number
      | boolean
      | string;
    const display =
      typeof v === 'number' ? fmtNumber(v) + (unit ? ` ${unit}` : '') : String(v);
    return { ok: true, value: v, display };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── presets ───────────────────────────────────────────────────────────────────

export interface FormulaPreset {
  group: string;
  label: string;
  expr: string;
  unit?: string;
  /** Tooltip — e.g. the source PID. */
  hint?: string;
}

/**
 * Ready-made formulas. The OBD-II ones assume the frame's data bytes START at
 * the PID's A byte (true for raw frames you've isolated; for a full OBD-II
 * response shift the byte letters). Source: en.wikipedia.org/wiki/OBD-II_PIDs.
 */
export const FORMULA_PRESETS: FormulaPreset[] = [
  // Building blocks.
  { group: 'Basics', label: 'Byte A', expr: 'A', hint: 'first byte' },
  { group: 'Basics', label: '16-bit big-endian', expr: '256*A + B', hint: 'A high byte' },
  { group: 'Basics', label: '16-bit little-endian', expr: '256*B + A', hint: 'A low byte' },
  { group: 'Basics', label: '16-bit signed (BE)', expr: 's16(A, B)' },
  { group: 'Basics', label: '32-bit big-endian', expr: 'u32(A, B, C, D)' },
  { group: 'Basics', label: 'High nibble of A', expr: 'shr(A, 4)' },
  { group: 'Basics', label: 'Low nibble of A', expr: 'band(A, 15)' },
  { group: 'Basics', label: 'Bit 0 of A', expr: 'bit(A, 0)' },
  { group: 'Basics', label: '% of 255', expr: '100/255 * A', unit: '%' },

  // OBD-II service 01 (raw, A = first byte).
  { group: 'OBD-II', label: 'Engine RPM', expr: '(256*A + B)/4', unit: 'rpm', hint: 'PID 0C' },
  { group: 'OBD-II', label: 'Vehicle speed', expr: 'A', unit: 'km/h', hint: 'PID 0D' },
  { group: 'OBD-II', label: 'Coolant temperature', expr: 'A - 40', unit: '°C', hint: 'PID 05' },
  { group: 'OBD-II', label: "Intake air temperature", expr: 'A - 40', unit: '°C', hint: 'PID 0F' },
  { group: 'OBD-II', label: 'Ambient air temperature', expr: 'A - 40', unit: '°C', hint: 'PID 46' },
  { group: 'OBD-II', label: 'Oil temperature', expr: 'A - 40', unit: '°C', hint: 'PID 5C' },
  { group: 'OBD-II', label: 'Throttle position', expr: '100/255 * A', unit: '%', hint: 'PID 11' },
  { group: 'OBD-II', label: 'Engine load', expr: '100/255 * A', unit: '%', hint: 'PID 04' },
  { group: 'OBD-II', label: 'Fuel level', expr: '100/255 * A', unit: '%', hint: 'PID 2F' },
  { group: 'OBD-II', label: 'Air flow (MAF)', expr: '(256*A + B)/100', unit: 'g/s', hint: 'PID 10' },
  { group: 'OBD-II', label: 'Ignition timing advance', expr: 'A/2 - 64', unit: '°', hint: 'PID 0E' },
  { group: 'OBD-II', label: 'Control module voltage', expr: '(256*A + B)/1000', unit: 'V', hint: 'PID 42' },
];

// ── DBC signal → Custom formula bridge ──────────────────────────────────────────

const BYTE_LETTERS = 'ABCDEFGH';

/**
 * Build an expr-eval expression that extracts ONE signal from a frame's bytes,
 * matching protocol/decode.ts (`extractRaw` / `signalBitOrder`) bit-for-bit,
 * then applies factor/offset (and two's-complement when `signed`). The result
 * is over the byte variables A..H (= data[0..7]) plus the bit helpers, so it
 * drops straight into a per-frame "Custom" {@link FormulaDef}. This is the
 * bridge a DBC import uses to seed the Custom column from a signal's geometry.
 *
 * Returns null when the signal can't be expressed over A..H: it touches a byte
 * beyond index 7 (classic CAN is ≤8 bytes), or its raw width exceeds the 52-bit
 * exact-integer range JS doubles carry (decode.ts uses BigInt; formulas use
 * doubles — we decline rather than emit a lossy formula).
 */
export function signalToFormula(sig: EditableSignal): FormulaDef | null {
  const order = signalBitOrder(sig); // LSB-first CAN bit indices, == extractRaw
  if (order.length === 0 || order.length > 52) return null;
  for (const b of order) if (b >> 3 > 7) return null; // byte beyond A..H

  // Collapse the LSB-first bit list into per-byte contiguous runs. order[i] is
  // raw dest bit i; a run = consecutive dest bits whose source bits are
  // consecutive within ONE byte (holds for both Intel and the Motorola sawtooth
  // *within* a byte). Each run → one (mask, shift) chunk.
  const chunks: string[] = [];
  let i = 0;
  while (i < order.length) {
    const destLo = i;
    const byteIndex = order[i] >> 3;
    const srcLo = order[i] & 7;
    let width = 1;
    while (
      i + width < order.length &&
      order[i + width] >> 3 === byteIndex &&
      (order[i + width] & 7) === srcLo + width
    ) {
      width += 1;
    }
    i += width;

    const L = BYTE_LETTERS[byteIndex];
    const mask = (1 << width) - 1;
    let src: string; // this run's source bits, aligned to bit 0
    if (srcLo === 0 && width === 8) src = L; // whole byte
    else if (srcLo === 0) src = `band(${L}, ${mask})`;
    else src = `band(shr(${L}, ${srcLo}), ${mask})`;
    // Place at its destination via MULTIPLICATION (exact to 2^52, unlike the
    // 32-bit `shl` helper). A letter / band(...) call binds tighter than `*`,
    // so no parens are needed around `src`.
    chunks.push(destLo === 0 ? src : `${2 ** destLo} * ${src}`);
  }

  const rawSum = chunks.join(' + ');

  // Two's-complement when signed (mirrors extractRaw's sign extension).
  let raw = rawSum;
  if (sig.signed && sig.bitLength > 0) {
    const signBound = 2 ** (sig.bitLength - 1);
    const modulus = 2 ** sig.bitLength;
    raw = `(${rawSum}) >= ${signBound} ? (${rawSum}) - ${modulus} : (${rawSum})`;
  }

  // Physical = raw * factor + offset. Parenthesize only when the raw expression
  // has a top-level `+`/`-`/ternary, so simple signals stay clean (`A`, `C + 256 * D`).
  let expr = sig.signed ? `(${raw})` : raw;
  if (sig.factor !== 1) {
    const base = /[+\-?]/.test(expr) && !expr.startsWith('(') ? `(${expr})` : expr;
    expr = `${base} * ${sig.factor}`;
  }
  if (sig.offset !== 0) {
    expr = sig.offset < 0 ? `${expr} - ${-sig.offset}` : `${expr} + ${sig.offset}`;
  }

  return { expr, unit: sig.unit || undefined };
}

/** The variables + helper functions available in a formula (for the cheat-sheet). */
export const FORMULA_HELP = {
  vars: 'A B C D E F G H = data[0..7] · bytes = array · len = DLC',
  fns: 'u16(hi,lo) u16le(lo,hi) s16(hi,lo) u32(a,b,c,d) · band bor bxor shl shr bit · abs floor ceil round sqrt min max · ^ = power · a>b ? x : y',
};
