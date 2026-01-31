/**
 * DBC import/export STUB (DESIGN §3.5: "DBC import/export maps to/from this").
 *
 * --------------------------------------------------------------------------
 * Library choice
 * --------------------------------------------------------------------------
 * Recommended JS DBC library: **@montra-connect/dbc-parser** (pure-TS, MIT,
 * browser-friendly, no Node fs dependency) for PARSING. It exposes messages →
 * signals with bitStart/length/endianness/factor/offset/unit, which maps almost
 * 1:1 onto our §3.5 Signal/FrameDef.
 *
 * Alternatives considered:
 *   - `dbc-can` / `can-dbc`: parse-only, Node-leaning, heavier.
 *   - `cantools` (Python): the de-facto reference, but it is the BACKEND's
 *     forbidden dep (invariant §4.3 — no cantools in backend) AND it's Python,
 *     so it cannot run in the browser. We deliberately keep DBC in the FRONTEND.
 *
 * For EXPORT (serialize → .dbc text) no library is mature in JS; we emit a
 * minimal, valid `BO_`/`SG_` subset ourselves (below). This is the stub seam:
 * wire the real parser into `importDbc` and extend `exportDbc` as needed.
 *
 * Mapping notes (DBC ↔ §3.5):
 *   - DBC byte order char: `1` = little/Intel, `0` = big/Motorola.
 *   - DBC `SG_` start bit numbering matches our `bitStart` (we keep DBC's own
 *     convention per byteOrder; see decode.ts).
 *   - DBC signed flag (`+`/`-`) maps to our EditableSignal.signed extension.
 *   - We import as unsigned-physical by default; min/max/receivers are dropped
 *     (not in §3.5) but can be round-tripped if we extend the model later.
 */

import {
  makeSignal,
  type EditableSignal,
  type FrameDef,
  type Project,
} from '../protocol/datamodel';

export interface DbcImportResult {
  project: Project;
  /** Non-fatal notes (dropped fields, unsupported constructs). */
  warnings: string[];
}

/**
 * Parse DBC text into a §3.5 Project.
 *
 * STUB: implements a minimal `BO_` + `SG_` line parser covering the common
 * case so import is demonstrably wired, and documents where the real
 * `@montra-connect/dbc-parser` plugs in. It does NOT cover value tables,
 * multiplexing, attributes, or comments.
 */
export function importDbc(text: string, projectName = 'imported'): DbcImportResult {
  const warnings: string[] = [];
  const frames: FrameDef[] = [];
  let current: FrameDef | null = null;

  const lines = text.split(/\r?\n/);
  // BO_ <id> <name>: <dlc> <transmitter>
  const boRe = /^BO_\s+(\d+)\s+([^:]+):\s+(\d+)\s+(\S+)/;
  // SG_ <name> : <start>|<len>@<order><sign> (<factor>,<offset>) [min|max] "unit" <recv>
  const sgRe =
    /^\s*SG_\s+(\w+)\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*(?:\[[^\]]*\])?\s*"([^"]*)"/;

  for (const line of lines) {
    const bo = boRe.exec(line);
    if (bo) {
      const rawId = parseInt(bo[1], 10);
      // DBC encodes extended ids by setting bit31 (0x80000000) on the id.
      const isExtended = (rawId & 0x80000000) !== 0;
      const id = rawId & 0x1fffffff;
      current = { id, isExtended, name: bo[2].trim(), signals: [] };
      frames.push(current);
      continue;
    }
    const sg = sgRe.exec(line);
    if (sg) {
      if (!current) {
        warnings.push(`SG_ before any BO_: ${line.trim().slice(0, 60)}`);
        continue;
      }
      const sig: EditableSignal = makeSignal(current.id, current.isExtended, {
        name: sg[1],
        bitStart: parseInt(sg[2], 10),
        bitLength: parseInt(sg[3], 10),
        byteOrder: sg[4] === '1' ? 'little' : 'big',
        signed: sg[5] === '-',
        factor: Number(sg[6]),
        offset: Number(sg[7]),
        unit: sg[8],
      });
      current.signals.push(sig);
      continue;
    }
  }

  if (frames.length === 0) {
    warnings.push(
      'no BO_ definitions parsed — this stub handles only basic BO_/SG_ lines; ' +
        'wire @montra-connect/dbc-parser for full coverage',
    );
  }

  return { project: { name: projectName, frames }, warnings };
}

/**
 * Serialize a §3.5 Project to minimal valid DBC text (BO_/SG_ subset).
 *
 * STUB: emits a header + one BO_ per frame + one SG_ per signal. Sufficient for
 * round-tripping our own model; not a full DBC writer.
 */
export function exportDbc(project: Project): string {
  const out: string[] = [];
  out.push('VERSION ""');
  out.push('');
  out.push('NS_ :');
  out.push('');
  out.push('BS_:');
  out.push('');
  out.push('BU_:');
  out.push('');

  for (const frame of project.frames) {
    const dlc = frameDlc(frame);
    const dbcId = frame.isExtended ? (frame.id | 0x80000000) >>> 0 : frame.id;
    out.push(`BO_ ${dbcId} ${sanitize(frame.name)}: ${dlc} Vector__XXX`);
    for (const s of frame.signals) {
      const order = s.byteOrder === 'little' ? 1 : 0;
      const sign = (s as EditableSignal).signed ? '-' : '+';
      out.push(
        ` SG_ ${sanitize(s.name)} : ${s.bitStart}|${s.bitLength}@${order}${sign}` +
          ` (${s.factor},${s.offset}) [0|0] "${s.unit}" Vector__XXX`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

function frameDlc(frame: FrameDef): number {
  let maxBit = 0;
  for (const s of frame.signals) {
    const top = s.bitStart + s.bitLength;
    if (top > maxBit) maxBit = top;
  }
  return Math.min(8, Math.max(0, Math.ceil(maxBit / 8)));
}

/** DBC identifiers must be [A-Za-z_][A-Za-z0-9_]*. */
function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}
