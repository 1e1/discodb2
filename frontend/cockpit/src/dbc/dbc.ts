/**
 * DBC import/export (DESIGN §3.5: "DBC import/export maps to/from this").
 *
 * A dependency-free, line-oriented DBC reader/writer. We hand-roll it (rather
 * than pull in `@montra-connect/dbc-parser` or `cantools`) for the same reason
 * the rest of frontend/shared is hand-rolled: zero runtime deps, full control
 * over the §3.5 mapping, and no remapping layer between a library's shape and
 * ours. cantools is also forbidden in the backend (invariant §4.3) and is
 * Python; we deliberately keep DBC in the FRONTEND.
 *
 * Coverage:
 *   - `BO_` messages, incl. the extended-id convention (bit31 set on the id).
 *   - `SG_` signals, incl. the MULTIPLEXING markers: `M` (this signal selects
 *     the sub-message) and `m<N>` (present only when the multiplexor == N). A
 *     bare `m` (no index) is tolerated as the SELECTOR (`M`) — some real DBCs
 *     (e.g. opendbc vw_pq) tag the selector that way.
 *   - `SG_MUL_VAL_` EXTENDED multiplexing: routed to basic multiplexing — the
 *     multiplexed signal takes the first range's lower bound as its `m<N>`
 *     value (if it has none inline) and the named selector is marked `M`.
 *   - byte order (`1`=little/Intel, `0`=big/Motorola), signed (`-`)/unsigned
 *     (`+`), factor/offset, unit. Optional `[min|max]` is parsed-and-dropped
 *     (not in §3.5), as is the receiver list.
 *   - `VAL_` value tables (enum labels) are parsed and attached to the matching
 *     signal as the cockpit-only `valueLabels` extension; round-tripped on
 *     export. `CM_ SG_`/`CM_ BO_` comments are attached to the signal/frame as
 *     the cockpit-only `comment` extension and round-tripped; other `CM_` forms
 *     (global/`BU_`/`EV_`) are counted in a summary warning.
 *   - on import, a per-frame "Custom" formula is SEEDED from each frame's most
 *     salient signal (widest non-multiplexor, filler names skipped) via
 *     `signalToFormula`, so the Custom column shows a real value immediately.
 *
 * Mapping notes (DBC ↔ §3.5):
 *   - DBC byte order char: `1` = little/Intel, `0` = big/Motorola.
 *   - DBC `SG_` start bit numbering matches our `bitStart` (we keep DBC's own
 *     convention per byteOrder; see decode.ts).
 *   - DBC signed flag (`+`/`-`) maps to our EditableSignal.signed extension.
 *   - DBC `M`/`m<N>` map to EditableSignal.isMultiplexor / multiplexValue.
 *   - DBC `VAL_` enum labels map to EditableSignal.valueLabels.
 *   - min/max/receivers are dropped (not in §3.5).
 */

import {
  frameKey,
  makeSignal,
  type EditableSignal,
  type FormulaDef,
  type FrameDef,
  type Project,
} from '../protocol/datamodel';
import { signalToFormula } from '../protocol/formula';

export interface DbcImportResult {
  project: Project;
  /** Non-fatal notes (dropped fields, unsupported constructs). */
  warnings: string[];
}

// BO_ <id> <name>: <dlc> <transmitter>
const BO_RE = /^BO_\s+(\d+)\s+([^:]+):\s+(\d+)\s+(\S+)/;
// SG_ <name> [M|m<N>] : <start>|<len>@<order><sign> (<factor>,<offset>) [min|max] "unit" <recv>
//        ─┬─  ───┬───      ─┬─ ─┬─    ─┬───┬─   ──────┬──────────              ─┬─
//        name  mux mark    start len  order sign     factor/offset            unit
// The mux marker is `M` (selector), `m<N>` (multiplexed), or a bare `m` —
// tolerated as the selector (see header note).
const SG_RE =
  /^\s*SG_\s+(\w+)\s*(M|m\d+|m)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*(?:\[[^\]]*\])?\s*"([^"]*)"/;
// VAL_ <msgId> <signalName> <int> "<label>" <int> "<label>" … ;
const VAL_RE = /^VAL_\s+(\d+)\s+(\w+)\s+(.+?);?\s*$/;
// One `<int> "<label>"` pair inside a VAL_ line's body.
const VAL_PAIR_RE = /(-?\d+)\s+"([^"]*)"/g;
// SG_MUL_VAL_ <msgId> <multiplexedSignal> <multiplexorSignal> <min>-<max>[, …] ;
const SG_MUL_VAL_RE = /^SG_MUL_VAL_\s+(\d+)\s+(\w+)\s+(\w+)\s+(\d+)-(\d+)/;
// CM_ SG_ <msgId> <signal> "<text>"; and CM_ BO_ <msgId> "<text>";
const CM_SG_RE = /^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"([\s\S]*)"\s*;?\s*$/;
const CM_BO_RE = /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)"\s*;?\s*$/;

/**
 * Parse DBC text into a §3.5 Project.
 *
 * Lines that are not `BO_`/`SG_` (VERSION, NS_, BS_, BU_, CM_, VAL_, …) are
 * skipped; `VAL_`/`CM_` counts are surfaced as a single warning so the caller
 * knows decoding aids were present but are not represented in our model.
 */
export function importDbc(text: string, projectName = 'imported'): DbcImportResult {
  const warnings: string[] = [];
  const frames: FrameDef[] = [];
  let current: FrameDef | null = null;
  let cmDropped = 0; // CM_ forms we don't model (global / BU_ / EV_)
  // Buffer VAL_ lines and apply them AFTER the BO_/SG_ pass: a VAL_ may appear
  // before (or after) its signal, so we resolve against the final frame list.
  const valLines: { msgId: number; signal: string; labels: Record<number, string> }[] = [];
  // Likewise buffer SG_MUL_VAL_ (extended multiplexing) and CM_ SG_/BO_ comments:
  // all reference a signal/message by name+id and may precede their definition.
  const mulVal: { msgId: number; signal: string; selector: string; lo: number }[] = [];
  const sgComments: { msgId: number; signal: string; text: string }[] = [];
  const boComments: { msgId: number; text: string }[] = [];

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const bo = BO_RE.exec(line);
    if (bo) {
      const rawId = parseInt(bo[1], 10) >>> 0;
      // DBC encodes extended ids by setting bit31 (0x80000000) on the id.
      const isExtended = (rawId & 0x80000000) !== 0;
      const id = rawId & 0x1fffffff;
      current = { id, isExtended, name: bo[2].trim(), signals: [] };
      frames.push(current);
      continue;
    }

    const sg = SG_RE.exec(line);
    if (sg) {
      if (!current) {
        warnings.push(`SG_ before any BO_: ${line.trim().slice(0, 60)}`);
        continue;
      }
      const mux = sg[2]; // 'M' | 'm<N>' | bare 'm' | undefined
      const sig: EditableSignal = makeSignal(current.id, current.isExtended, {
        name: sg[1],
        bitStart: parseInt(sg[3], 10),
        bitLength: parseInt(sg[4], 10),
        byteOrder: sg[5] === '1' ? 'little' : 'big',
        signed: sg[6] === '-',
        factor: Number(sg[7]),
        offset: Number(sg[8]),
        unit: sg[9],
        // `M` and bare `m` are the SELECTOR; `m<N>` is a multiplexed signal.
        isMultiplexor: mux === 'M' || mux === 'm' || undefined,
        multiplexValue: mux && /^m\d+$/.test(mux) ? parseInt(mux.slice(1), 10) : undefined,
      });
      current.signals.push(sig);
      continue;
    }

    const val = VAL_RE.exec(line);
    if (val) {
      const labels: Record<number, string> = {};
      VAL_PAIR_RE.lastIndex = 0;
      let pair: RegExpExecArray | null;
      while ((pair = VAL_PAIR_RE.exec(val[3])) !== null) {
        labels[parseInt(pair[1], 10)] = pair[2];
      }
      if (Object.keys(labels).length > 0) {
        valLines.push({ msgId: parseInt(val[1], 10) >>> 0, signal: val[2], labels });
      }
      continue;
    }

    const mv = SG_MUL_VAL_RE.exec(line);
    if (mv) {
      mulVal.push({
        msgId: parseInt(mv[1], 10) >>> 0,
        signal: mv[2],
        selector: mv[3],
        lo: parseInt(mv[4], 10),
      });
      continue;
    }

    const cmSg = CM_SG_RE.exec(line);
    if (cmSg) {
      sgComments.push({ msgId: parseInt(cmSg[1], 10) >>> 0, signal: cmSg[2], text: cmSg[3] });
      continue;
    }
    const cmBo = CM_BO_RE.exec(line);
    if (cmBo) {
      boComments.push({ msgId: parseInt(cmBo[1], 10) >>> 0, text: cmBo[2] });
      continue;
    }
    // Other CM_ forms (global, CM_ BU_, CM_ EV_) have no model field.
    if (line.startsWith('CM_ ')) cmDropped += 1;
  }

  const frameOf = (msgId: number): FrameDef | undefined => {
    const id = msgId & 0x1fffffff;
    const isExtended = (msgId & 0x80000000) !== 0;
    return frames.find((f) => f.id === id && f.isExtended === isExtended);
  };
  const sigOf = (msgId: number, name: string): EditableSignal | undefined =>
    frameOf(msgId)?.signals.find((s) => s.name === name) as EditableSignal | undefined;

  // Attach value-label tables to their signals (raw value → enum label).
  let valDropped = 0;
  for (const v of valLines) {
    const sig = sigOf(v.msgId, v.signal);
    if (sig) sig.valueLabels = { ...(sig.valueLabels ?? {}), ...v.labels };
    else valDropped += 1;
  }

  // Extended multiplexing → basic: give the multiplexed signal an `m<N>` value
  // (the first range's lower bound) if it lacks one inline, and ensure the named
  // selector is marked the multiplexor. This rescues DBCs that rely solely on
  // SG_MUL_VAL_ instead of inline `m<N>` markers.
  for (const mv of mulVal) {
    const sig = sigOf(mv.msgId, mv.signal);
    if (sig && sig.multiplexValue === undefined && !sig.isMultiplexor) {
      sig.multiplexValue = mv.lo;
    }
    const selector = sigOf(mv.msgId, mv.selector);
    if (selector && !selector.isMultiplexor) {
      selector.isMultiplexor = true;
      selector.multiplexValue = undefined;
    }
  }

  // Attach CM_ comments to their signal / frame.
  for (const c of sgComments) {
    const sig = sigOf(c.msgId, c.signal);
    if (sig) sig.comment = c.text;
    else cmDropped += 1;
  }
  for (const c of boComments) {
    const frame = frameOf(c.msgId);
    if (frame) frame.comment = c.text;
    else cmDropped += 1;
  }

  // Seed a per-frame "Custom" formula from each frame's most salient signal so
  // the Custom column shows a real decoded value right after import (the bridge
  // the user otherwise had to write by hand). Non-destructive shape: a fresh map.
  const frameFormulas: Record<string, FormulaDef> = {};
  for (const f of frames) {
    const sig = pickPrimarySignal(f);
    const formula = sig ? signalToFormula(sig) : null;
    if (formula) frameFormulas[frameKey(f.id, f.isExtended)] = formula;
  }

  if (frames.length === 0) {
    warnings.push('no BO_ message definitions found — is this a DBC file?');
  }
  if (valDropped || cmDropped) {
    const parts: string[] = [];
    if (valDropped) parts.push(`${valDropped} value table(s) with no matching signal`);
    if (cmDropped) parts.push(`${cmDropped} comment(s)`);
    warnings.push(`${parts.join(' and ')} ignored (not represented in the §3.5 model)`);
  }

  const project: Project = { name: projectName, frames };
  if (Object.keys(frameFormulas).length > 0) project.frameFormulas = frameFormulas;
  return { project, warnings };
}

/** Names that are structural/filler, never the "interesting" payload of a frame. */
const FILLER_RE = /free|reserved|unused|spare|checksum|crc|counter|zaehler|\bbz\b|qbit|mux|multiplex/i;

/**
 * Pick the signal a frame's "Custom" formula should default to: the WIDEST
 * non-multiplexor signal whose name isn't structural filler (CRC/counter/free…),
 * tie-broken by lowest bitStart. Falls back to the widest non-multiplexor signal
 * if every signal looks like filler. Returns undefined for an empty frame.
 */
function pickPrimarySignal(frame: FrameDef): EditableSignal | undefined {
  const sigs = frame.signals as EditableSignal[];
  const candidates = sigs.filter((s) => !s.isMultiplexor);
  if (candidates.length === 0) return undefined;
  const meaningful = candidates.filter((s) => !FILLER_RE.test(s.name));
  const pool = meaningful.length > 0 ? meaningful : candidates;
  return pool.reduce((best, s) =>
    s.bitLength > best.bitLength ||
    (s.bitLength === best.bitLength && s.bitStart < best.bitStart)
      ? s
      : best,
  );
}

/**
 * Serialize a §3.5 Project to valid DBC text (BO_/SG_ subset).
 *
 * Round-trips everything `importDbc` reads: id/extended, bit range, endianness,
 * signedness, factor/offset, unit, the multiplexing markers, and `VAL_` enum
 * labels. Comments are not emitted (no model field). The header is the minimal
 * `VERSION`/`NS_`/`BS_`/`BU_` skeleton tools expect.
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
      const sig = s as EditableSignal;
      const order = s.byteOrder === 'little' ? 1 : 0;
      const sign = sig.signed ? '-' : '+';
      const mux = muxMarker(sig);
      out.push(
        ` SG_ ${sanitize(s.name)}${mux} : ${s.bitStart}|${s.bitLength}@${order}${sign}` +
          ` (${s.factor},${s.offset}) [0|0] "${s.unit}" Vector__XXX`,
      );
    }
    out.push('');
  }

  // Value tables (enum labels) — emitted after all messages, per DBC convention.
  for (const frame of project.frames) {
    const dbcId = frame.isExtended ? (frame.id | 0x80000000) >>> 0 : frame.id;
    for (const s of frame.signals) {
      const labels = (s as EditableSignal).valueLabels;
      if (!labels) continue;
      const pairs = Object.keys(labels)
        .map(Number)
        .sort((a, b) => a - b)
        .map((v) => `${v} "${labels[v]}"`);
      if (pairs.length === 0) continue;
      out.push(`VAL_ ${dbcId} ${sanitize(s.name)} ${pairs.join(' ')} ;`);
    }
  }

  // Comments (CM_) — emitted last, after VAL_, per DBC convention.
  for (const frame of project.frames) {
    const dbcId = frame.isExtended ? (frame.id | 0x80000000) >>> 0 : frame.id;
    const fc = (frame as FrameDef).comment;
    if (fc) out.push(`CM_ BO_ ${dbcId} "${escapeComment(fc)}";`);
    for (const s of frame.signals) {
      const sc = (s as EditableSignal).comment;
      if (sc) out.push(`CM_ SG_ ${dbcId} ${sanitize(s.name)} "${escapeComment(sc)}";`);
    }
  }
  return out.join('\n');
}

/** Neutralize quotes/newlines so a comment can't break out of its CM_ string. */
function escapeComment(text: string): string {
  return text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/** The ` M` / ` m<N>` multiplexing marker for a signal, or '' if plain. */
function muxMarker(sig: EditableSignal): string {
  if (sig.isMultiplexor) return ' M';
  if (sig.multiplexValue !== undefined) return ` m${sig.multiplexValue}`;
  return '';
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
