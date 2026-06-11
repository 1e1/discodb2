import { test } from "node:test";
import assert from "node:assert/strict";

import { decode29BitId } from "./j1939.ts";

test("decode29BitId: PDU2 (broadcast) — PS is the group extension, part of the PGN", () => {
  // EEC1 (engine) is a classic J1939 broadcast: PGN 0xF004 (61444), priority 3,
  // source address 0x00. id = prio(3)<<26 | PF(0xF0)<<16 | PS(0x04)<<8 | SA(0x00).
  const id = (3 << 26) | (0xf0 << 16) | (0x04 << 8) | 0x00;
  const d = decode29BitId(id);
  assert.equal(d.priority, 3);
  assert.equal(d.extendedDataPage, 0);
  assert.equal(d.dataPage, 0);
  assert.equal(d.pduFormat, 0xf0);
  assert.equal(d.pduSpecific, 0x04);
  assert.equal(d.sourceAddress, 0x00);
  assert.equal(d.pduType, "PDU2");
  assert.equal(d.groupExtension, 0x04);
  assert.equal(d.destinationAddress, undefined);
  assert.equal(d.pgn, 0xf004);
});

test("decode29BitId: PDU1 (destination-specific) — PS is the destination, PGN low byte forced to 0", () => {
  // PF = 0xEF (< 240) → PDU1. PS = 0x21 destination, SA = 0xF9.
  const id = (6 << 26) | (0xef << 16) | (0x21 << 8) | 0xf9;
  const d = decode29BitId(id);
  assert.equal(d.priority, 6);
  assert.equal(d.pduFormat, 0xef);
  assert.equal(d.pduSpecific, 0x21);
  assert.equal(d.sourceAddress, 0xf9);
  assert.equal(d.pduType, "PDU1");
  assert.equal(d.destinationAddress, 0x21);
  assert.equal(d.groupExtension, undefined);
  // PGN = PF << 8 with low byte 0 → 0xEF00.
  assert.equal(d.pgn, 0xef00);
});

test("decode29BitId: data page / extended data page bits feed the PGN", () => {
  // EDP=0, DP=1, PF=0xFE, PS=0xCA → PDU2, PGN = (DP<<16)|(PF<<8)|PS = 0x1FECA.
  const id = (1 << 24) | (0xfe << 16) | (0xca << 8) | 0x17;
  const d = decode29BitId(id);
  assert.equal(d.dataPage, 1);
  assert.equal(d.pduType, "PDU2");
  assert.equal(d.pgn, (1 << 16) | (0xfe << 8) | 0xca);
});

test("decode29BitId: masks to the low 29 bits and reads boundary fields", () => {
  // All-ones 29-bit id: priority 7, EDP 1, DP 1, PF 0xFF, PS 0xFF, SA 0xFF.
  const id = 0x1fffffff;
  const d = decode29BitId(id);
  assert.equal(d.priority, 7);
  assert.equal(d.extendedDataPage, 1);
  assert.equal(d.dataPage, 1);
  assert.equal(d.pduFormat, 0xff);
  assert.equal(d.pduSpecific, 0xff);
  assert.equal(d.sourceAddress, 0xff);
  assert.equal(d.pduType, "PDU2");
});
