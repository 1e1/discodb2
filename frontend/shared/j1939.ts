// discodb2 — GENERIC 29-bit extended CAN id decomposition (SAE J1939-style).
//
// IMPORTANT — NOT GROUND TRUTH FOR A VW CAR:
//   A VW passenger car's 29-bit broadcast frames are PROPRIETARY; their bit
//   layout is defined by VW's own DBC, NOT by SAE J1939. This module offers an
//   OPTIONAL, clearly-labelled "generic 29-bit / J1939 interpretation" so the
//   Inspector can show a structured read-out of any extended id — but it must be
//   presented as a guess/heuristic, never as the decoded meaning of the frame.
//
// What it does (the standard J1939 PDU layout of the 29-bit identifier):
//
//   bits 28..26  Priority            (3 bits)
//   bit  25      Extended Data Page  (EDP / reserved, 1 bit)
//   bit  24      Data Page           (DP, 1 bit)
//   bits 23..16  PDU Format          (PF, 8 bits)
//   bits 15..8   PDU Specific        (PS, 8 bits)
//   bits  7..0   Source Address      (SA, 8 bits)
//
// The Parameter Group Number (PGN) and the meaning of PS depend on PF:
//   • PF < 240 (0xF0)  ⇒ PDU1 (destination-specific): PS is the DESTINATION
//     address; the PGN's low byte is forced to 0 (PGN = EDP|DP|PF|0x00).
//   • PF ≥ 240         ⇒ PDU2 (broadcast): PS is a GROUP EXTENSION that is part
//     of the PGN (PGN = EDP|DP|PF|PS).
//
// Pure & framework-free (like protocol.ts / diagnostic.ts): no Svelte/Vite/DOM
// deps; mutates nothing; safe in the cockpit, a Web Worker, or a Node test runner.

export type J1939Format = "PDU1" | "PDU2";

export interface J1939Decomposition {
  /** Priority (bits 26..28), 0 (highest) .. 7 (lowest). */
  priority: number;
  /** Extended Data Page bit (bit 25), often reserved/0. */
  extendedDataPage: number;
  /** Data Page bit (bit 24). */
  dataPage: number;
  /** PDU Format (bits 16..23), 0..255. */
  pduFormat: number;
  /** PDU Specific (bits 8..15), 0..255 — meaning depends on PDU1 vs PDU2. */
  pduSpecific: number;
  /** Source Address (bits 0..7). */
  sourceAddress: number;
  /** "PDU1" (PF < 240, destination-specific) or "PDU2" (PF ≥ 240, broadcast). */
  pduType: J1939Format;
  /** Destination address for PDU1 (= PS); undefined for PDU2 (broadcast). */
  destinationAddress?: number;
  /** Group extension for PDU2 (= PS); undefined for PDU1. */
  groupExtension?: number;
  /** Derived Parameter Group Number (PGN). */
  pgn: number;
}

/**
 * Decompose a 29-bit extended CAN identifier into J1939-style fields.
 *
 * The low 29 bits of `id` are used (higher bits are masked off). This never
 * throws and is purely a bit-field split — see the file header for the layout and
 * the PDU1/PDU2 PGN rules. Caller is responsible for only invoking this on
 * extended (29-bit) ids, and for labelling the output as a generic interpretation.
 */
export function decode29BitId(id: number): J1939Decomposition {
  const v = id >>> 0; // treat as unsigned 32-bit
  // Extract each field with shifts + masks against the low 29 bits.
  const priority = (v >>> 26) & 0x7;
  const extendedDataPage = (v >>> 25) & 0x1;
  const dataPage = (v >>> 24) & 0x1;
  const pduFormat = (v >>> 16) & 0xff;
  const pduSpecific = (v >>> 8) & 0xff;
  const sourceAddress = v & 0xff;

  // PDU1 (destination-specific) vs PDU2 (broadcast), decided by PF threshold 240.
  const isPdu1 = pduFormat < 240;
  const pduType: J1939Format = isPdu1 ? "PDU1" : "PDU2";

  // PGN = EDP(1) | DP(1) | PF(8) | low byte. For PDU1 the low byte is 0; for PDU2
  // the low byte is the group extension (PS).
  const pgnBase = (extendedDataPage << 17) | (dataPage << 16) | (pduFormat << 8);
  const pgn = isPdu1 ? pgnBase : pgnBase | pduSpecific;

  return {
    priority,
    extendedDataPage,
    dataPage,
    pduFormat,
    pduSpecific,
    sourceAddress,
    pduType,
    destinationAddress: isPdu1 ? pduSpecific : undefined,
    groupExtension: isPdu1 ? undefined : pduSpecific,
    pgn,
  };
}
