/**
 * Per-MESSAGE computation for the master-detail Message list (the DETAIL pane).
 *
 * A "message" is one sub-message of a CAN id, split by a per-frame DISCRIMINATOR
 * byte — the "Message ID" field. That field is resolved per frame in one of
 * three MODES (see `effectiveMessageId`):
 *
 *   • FORCED — the frame has a MULTIPLEXOR signal (datamodel.multiplexorSignal):
 *     the user pinned the discriminator byte. Round-trips to DBC unchanged.
 *   • NONE — `messageIdAuto === false`: plain frame, exactly ONE message row
 *     representing the frame itself; `mux` = null (rendered as "—"), full data.
 *   • AUTO — the default (no mux signal, not None): a DETECTOR proposes a
 *     discriminator byte from the recent frames and only splits when CONFIDENT;
 *     when nothing qualifies it behaves like None (one message). Not persisted.
 *
 * When there IS an effective discriminator byte, we group the recent frames by
 * that byte's value → ONE message row per distinct value; `mux` = that value.
 *
 * Diagnostic (0x7Ex) and J1939 are NOT message-splitters here — they stay in the
 * Inspector lens / badges. This is purely the message-ID fan-out.
 *
 * Each row carries enough to render `Message ID | DLC | Data | Rate | Last |
 * Count`; the Custom / Tab formula columns and the custom-name badge are layered
 * on by the MessageList component (it owns the project formulas & names). The
 * row also carries the effective `idByte` so MessageList can SHORTEN the Data
 * column by factoring the discriminator byte out of the payload.
 */

import type { FrameView } from '../state/ringBuffer';
import { extractRaw } from './decode';
import { multiplexorSignal, type EditableSignal, type FrameDef } from './datamodel';
import { idProfile } from '@shared/analysis/id-profile.ts';
import { payloadDependence } from '@shared/analysis/discriminator-dependence.ts';

export interface MessageRow {
  /** The discriminator (message-ID) value for this message, or null for the non-split single message. */
  mux: number | null;
  /** Latest payload of this message (newest frame in the group). */
  data: Uint8Array;
  /** DLC of the latest payload. */
  dlc: number;
  /** frames/second over the rate WINDOW = windowed count / windowSeconds (decays to 0 as a message goes stale). */
  rate: number;
  /** Backend µs of the most recent frame in this message group (CUMULATIVE — drives the growing "Last" age for aged-out messages). */
  lastTUs: number;
  /**
   * CUMULATIVE number of frames seen in this message group SINCE CONNECT (every
   * frame still in the ring for this group), not just the rate window. The row
   * persists as long as the ring retains a frame for it, so rare mux values do
   * not drop out of the list when they age past the rate window.
   */
  count: number;
  /**
   * The byte index(es) the discriminator (Message ID) field covers for this
   * frame, or null when there is no effective field (None / no-confident-Auto).
   * Same for every row of a frame; used by MessageList to factor those bytes
   * out of the shown Data so the payload reads shorter.
   */
  idBytes: number[] | null;
  /**
   * How many hex digits to zero-pad the Message-ID (mux) to in the UI = the
   * field's width (`ceil(bits/4)`; a whole byte → 2). 0 for the non-split message.
   */
  idHexWidth: number;
}

// ── Auto-detector tunables (named consts per the spec) ───────────────────────

/**
 * A candidate discriminator byte must take at least this many distinct values
 * (≥2: a byte that never changes selects nothing) …
 */
export const AUTO_MIN_DISTINCT = 2;
/**
 * … and at most this many (a discriminator enumerates a SMALL set of
 * sub-messages; a byte smeared over many values is an analog signal, not an ID).
 */
export const AUTO_MAX_DISTINCT = 8;
/**
 * Minimum samples on the candidate byte before Auto trusts it — below this the
 * distinct-count is too noisy to call. Mirrors the histogram's low floor but a
 * touch higher so a couple of stray frames can't fake a 2-value "enum".
 */
export const AUTO_MIN_SAMPLES = 8;

/**
 * A discriminator enumerates a SMALL set of sub-messages. If a field (usually a
 * FORCED multi-byte multiplexor) takes MORE distinct values than this, the split
 * would flood the list with ≈ one row per payload. We still split (so the data
 * is real), but MessageList warns AND renders only the {@link MAX_MESSAGES}
 * most-recently-seen rows so the un-virtualized table stays bounded (bug #1
 * guard; see the virtualization note in MessageList.svelte).
 */
export const MAX_MESSAGES = 64;

/**
 * A resolved discriminator BIT-FIELD — just enough for {@link extractRaw} +
 * geometry. Used uniformly for FORCED (from the multiplexor signal) and AUTO
 * (the detected sub-byte field). Auto fields are unsigned, little-endian, and
 * live within a single byte; forced fields inherit the signal's geometry.
 */
export type MessageIdField = Pick<EditableSignal, 'bitStart' | 'bitLength' | 'byteOrder' | 'signed'>;

/** What the Auto detector decided for a frame (also drives the Inspector read-out). */
export interface AutoDetect {
  /** The detected field's starting byte index, or null when nothing was confident. */
  byteIndex: number | null;
  /** Distinct values seen on the detected field over the history (0 when none). */
  distinct: number;
  /** Samples seen on the detected field (0 when none). */
  samples: number;
  /** The detected discriminator bit-field, or null when not confident. */
  field: MessageIdField | null;
}

/**
 * The resolved Message-ID FIELD for a frame, with its provenance.
 *   • mode 'forced'  → a multiplexor signal pins the field (`signal` set).
 *   • mode 'none'    → no field (`field` null): one message, full data.
 *   • mode 'auto'    → the detector's result (`field` set only when confident;
 *                      null behaves like None but is still mode 'auto').
 */
export interface EffectiveMessageId {
  mode: 'forced' | 'none' | 'auto';
  /** The resolved discriminator bit-field, or null when there is no effective field. */
  field: MessageIdField | null;
  /** The multiplexor signal when mode is 'forced' (provenance / DBC round-trip). */
  signal?: EditableSignal;
  /** The Auto detector's read-out (always present; informs the Inspector). */
  auto: AutoDetect;
}

/**
 * Run the Auto detector over a frame's history (the caller passes the full ring,
 * so this is a cumulative read). Strategy, built on the shared {@link idProfile}
 * substrate:
 *   1. CANDIDATE bytes = non-constant AND non-counter/checksum (the profile has
 *      already excluded constant bytes — incl. zero/padding — and tagger slots).
 *   2. Walk candidates lowest-index first (a discriminator is almost always in
 *      the leftmost byte[s]).
 *   3. Within a candidate byte, the discriminator = the contiguous span of its
 *      NON-CONSTANT bits, so we ignore constant padding bits around a SUB-BYTE
 *      field (real automotive multiplexors are 82% sub-byte — see the decoding-
 *      reality note).
 *   4. Keep only fields whose distinct-value count is a SMALL enum
 *      ([AUTO_MIN_DISTINCT .. AUTO_MAX_DISTINCT], ≥AUTO_MIN_SAMPLES samples); an
 *      analog/wide field is rejected.
 *   5. VALIDATE that the field actually PARTITIONS the payload — the other bytes
 *      DEPEND on its value ({@link payloadDependence}). This rejects a status/enum
 *      byte whose payload is independent of it (a false positive). Accept the
 *      first candidate that passes; none ⇒ not confident.
 * Pure.
 *
 * @param frames frames for ONE id (already filtered to id+extended).
 */
export function detectMessageIdByte(frames: FrameView[]): AutoDetect {
  const none: AutoDetect = { byteIndex: null, distinct: 0, samples: 0, field: null };
  if (frames.length < AUTO_MIN_SAMPLES) return none;

  const id = frames[0].id;
  // FrameView {id,tUs,data:Uint8Array,…} already satisfies ProfileFrame /
  // DependenceFrame, and its `data` is a per-frame Uint8Array copy out of the ring
  // (ringBuffer slices on read) — so pass the frames straight to the analyzers
  // with NO per-frame `Array.from` boxing. The caller filtered to one id+extended,
  // so every frame's id === `id`.
  const prof = idProfile(frames, [id]).ids[0];
  if (!prof) return none;

  for (const byteIndex of prof.candidateBytes) {
    // Contiguous span of this byte's non-constant bits (LSB-first, bit 0 = LSB).
    let lo = -1;
    let hi = -1;
    for (let k = 0; k < 8; k++) {
      const bp = prof.bits[byteIndex * 8 + k];
      if (bp && !bp.constant) {
        if (lo < 0) lo = k;
        hi = k;
      }
    }
    if (lo < 0) continue; // a candidate has ≥1 non-constant bit, but stay safe.
    const field: MessageIdField = {
      bitStart: byteIndex * 8 + lo,
      bitLength: hi - lo + 1,
      byteOrder: 'little',
      signed: false,
    };

    // Cardinality of the sub-field over the whole history.
    const seen = new Set<number>();
    let samples = 0;
    const endByte = (field.bitStart + field.bitLength - 1) >> 3;
    for (const f of frames) {
      if (endByte >= f.data.length) continue;
      seen.add(Number(extractRaw(f.data, field)));
      samples += 1;
    }
    if (samples < AUTO_MIN_SAMPLES) continue;
    if (seen.size < AUTO_MIN_DISTINCT || seen.size > AUTO_MAX_DISTINCT) continue;

    // Predictive validation: a real discriminator PARTITIONS the payload — the
    // OTHER candidate bytes depend on its value. Reject a low-cardinality field
    // whose payload is independent of it (a status/enum byte masquerading as a
    // multiplexor). Thin/ambiguous data never rejects (see payloadDependence).
    const targets = prof.candidateBytes.filter((b) => b !== byteIndex);
    const dep = payloadDependence(
      frames,
      { byteIndex, bitLo: lo, bitLen: field.bitLength },
      targets,
    );
    if (dep.rejects) continue;
    return { byteIndex, distinct: seen.size, samples, field };
  }
  return none;
}

/**
 * Resolve the EFFECTIVE Message-ID field for a frame (pure):
 *   1. a MULTIPLEXOR signal present ⇒ FORCED at its byte (signal.bitStart >> 3);
 *   2. else `messageIdAuto === false` ⇒ NONE (no field);
 *   3. else AUTO ⇒ run the detector over the recent frames.
 *
 * The detector always runs (cheap, over the same window) so the Inspector can
 * show "auto: byte N · K values" even when the active mode is Forced or None.
 */
export function effectiveMessageId(
  frames: FrameView[],
  def: FrameDef | undefined,
): EffectiveMessageId {
  const auto = detectMessageIdByte(frames);
  const mux = multiplexorSignal(def);
  if (mux) {
    const field: MessageIdField = {
      bitStart: mux.bitStart,
      bitLength: mux.bitLength,
      byteOrder: mux.byteOrder,
      signed: mux.signed,
    };
    return { mode: 'forced', field, signal: mux, auto };
  }
  if (def && def.messageIdAuto === false) {
    return { mode: 'none', field: null, auto };
  }
  return { mode: 'auto', field: auto.field, auto };
}

/**
 * Compute the message rows for a selected frame — a CUMULATIVE per-frame model.
 *
 * DESIGN — cumulative (since-connect) vs rolling-window:
 * The list used to be built from only the last N seconds (`ring.lastSeconds`),
 * so a RARE mux value DROPPED OUT once it aged past the window and the list
 * "shrank suddenly". Instead we now scan the FULL history the caller passes (all
 * frames the bounded ring still holds for this id, since connect) so every mux
 * value seen PERSISTS as a row — the row set is stable and complete. The per-
 * message RATE is still computed over the user's selected window only (windowed
 * count / window), so an aged-out message decays to rate 0 while staying listed,
 * and its `lastTUs` keeps the "Last" age growing so staleness is visible.
 *
 * We derive the cumulative groups straight from the ring (rather than keeping a
 * separate per-id Map updated on ingest) because the ring is ALREADY the single
 * complete since-connect history (cleared on connect); deriving keeps one source
 * of truth, stays pure, and is bounded by mux cardinality (not frame count). The
 * full-ring scan per id at ~10 Hz is the same cost class the Inspector and the
 * old `lastSeconds` already paid.
 *
 * @param frames        ALL buffered frames for the selected id (oldest → newest),
 *                      already filtered to the right id/extended flag by the
 *                      caller (e.g. `ring.lastSeconds(ALL, id)` then filter). The
 *                      cumulative row set is built from these.
 * @param def           the frame's FrameDef (for its multiplexor / Auto flag), or
 *                      undefined when the frame is unmodeled (⇒ Auto by default).
 * @param windowSeconds the rate WINDOW length (the rate denominator). Only frames
 *                      within `windowSeconds` of `nowTUs` count toward the rate.
 * @param nowTUs        the current backend-µs "now" (latest observed time). The
 *                      rate window is `[nowTUs - windowSeconds*1e6, nowTUs]`.
 *                      Defaults to the newest frame's time (rate over the whole
 *                      span when no live clock is supplied — e.g. in tests).
 */
export function computeMessages(
  frames: FrameView[],
  def: FrameDef | undefined,
  windowSeconds: number,
  nowTUs?: number,
  precomputedEff?: EffectiveMessageId,
): MessageRow[] {
  if (frames.length === 0) return [];

  // Detection (Auto idProfile + dependence test) is the expensive part and its
  // result is STABLE, so the caller may pass a memoized `precomputedEff` (see
  // createMessageIdResolver) to skip re-detecting on every ~10 Hz snapshot tick.
  const eff = precomputedEff ?? effectiveMessageId(frames, def);

  // Rate window low edge in backend µs: frames at-or-after this count toward the
  // rate. `now` defaults to the newest frame so a window-less call rates over the
  // observed span (tests / the "All" denominator are handled by the caller).
  const now = nowTUs ?? frames[frames.length - 1].tUs;
  const windowLowTUs = now - windowSeconds * 1e6;
  const inWindow = (tUs: number) => tUs >= windowLowTUs;

  // No effective discriminator (None, or Auto found nothing) → one message
  // representing the frame itself. Count is CUMULATIVE; rate uses the window.
  if (eff.field === null) {
    const last = frames[frames.length - 1];
    let windowed = 0;
    for (const f of frames) if (inWindow(f.tUs)) windowed += 1;
    return [
      {
        mux: null,
        data: last.data,
        dlc: last.dlc,
        rate: windowed / windowSeconds,
        lastTUs: last.tUs,
        count: frames.length,
        idBytes: null,
        idHexWidth: 0,
      },
    ];
  }

  // Effective discriminator → group by its value over the FULL history so every
  // mux value seen since connect PERSISTS as a row. `count` is the cumulative
  // total; `windowed` is just the rate-window sub-count.
  const field = eff.field;
  const idBytes = fieldBytes(field);
  const idHexWidth = fieldHexWidth(field);
  // Group by the field's value via the shared extractor (forced multi-byte signal
  // AND auto-detected sub-byte field go through the same code as the incremental
  // messageModel, so they group identically).
  const valueOf = fieldValueOf(field);

  const order: number[] = [];
  const groups = new Map<number, MessageRow>();
  // Per-group windowed sub-count, parallel to `groups` (kept off MessageRow).
  const windowedCount = new Map<number, number>();
  for (const f of frames) {
    const v = valueOf(f);
    let g = groups.get(v);
    if (!g) {
      g = { mux: v, data: f.data, dlc: f.dlc, rate: 0, lastTUs: f.tUs, count: 0, idBytes, idHexWidth };
      groups.set(v, g);
      windowedCount.set(v, 0);
      order.push(v);
    }
    g.count += 1; // cumulative since-connect count
    if (inWindow(f.tUs)) windowedCount.set(v, (windowedCount.get(v) ?? 0) + 1);
    // frames are oldest → newest, so the last write wins as "latest payload".
    g.data = f.data;
    g.dlc = f.dlc;
    g.lastTUs = f.tUs;
  }

  // Sort by value ascending so message ids read naturally (stable & readable —
  // unlike the live rate, the value ordering never moves a row).
  order.sort((a, b) => a - b);
  return order.map((v) => {
    const g = groups.get(v) as MessageRow;
    g.rate = (windowedCount.get(v) ?? 0) / windowSeconds;
    return g;
  });
}

/**
 * The byte index(es) a discriminator field covers (a contiguous span): a single
 * byte for an auto-detected sub-byte field, or the signal's byte span for a
 * FORCED multi-byte multiplexor. Lets MessageList factor the WHOLE field out of
 * the shown Data (not just its first byte).
 */
export function fieldBytes(field: MessageIdField): number[] {
  const start = field.bitStart >> 3;
  const end = (field.bitStart + field.bitLength - 1) >> 3;
  const bytes: number[] = [];
  for (let b = start; b <= end; b++) bytes.push(b);
  return bytes;
}

/** Hex digits to zero-pad the Message-ID to = the field width (ceil bits/4, ≥1). */
export function fieldHexWidth(field: MessageIdField): number {
  return Math.max(1, Math.ceil(field.bitLength / 4));
}

/**
 * The grouping-value extractor for a field: the field's integer value, or -1 for
 * a frame too short to carry the whole field (its own "missing" bucket). Shared
 * by {@link computeMessages} and the incremental messageModel so they group
 * identically — the single source of truth for the discriminator value.
 */
export function fieldValueOf(field: MessageIdField): (f: FrameView) => number {
  const endByte = (field.bitStart + field.bitLength - 1) >> 3;
  return (f) => (endByte < f.data.length ? Number(extractRaw(f.data, field)) : -1);
}
