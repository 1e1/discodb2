import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyDiagId,
  decodeIsoTp,
  decodeDiagnostic,
  reassembleIsoTp,
  decodeDiagnosticReassembled,
} from "./diagnostic.ts";

test("classifyDiagId maps the standard 11-bit ranges; everything else is null", () => {
  assert.deepEqual(classifyDiagId(0x7df, false), { role: "request-functional" });
  assert.deepEqual(classifyDiagId(0x7e0, false), { role: "request-physical", ecu: 0 });
  assert.deepEqual(classifyDiagId(0x7e7, false), { role: "request-physical", ecu: 7 });
  assert.deepEqual(classifyDiagId(0x7e8, false), { role: "response", ecu: 0 });
  assert.deepEqual(classifyDiagId(0x7ef, false), { role: "response", ecu: 7 });
  assert.equal(classifyDiagId(0x280, false), null); // a normal broadcast id
  assert.equal(classifyDiagId(0x7e8, true), null); // extended id → out of scope (v1)
});

test("decodeIsoTp reads the PCI high nibble", () => {
  assert.deepEqual(decodeIsoTp([0x04, 0x41, 0x0c, 0x1a, 0xf8]), {
    kind: "single",
    length: 4,
    dataStart: 1,
  });
  assert.deepEqual(decodeIsoTp([0x10, 0x14, 0x62, 0xf1, 0x90]), {
    kind: "first",
    length: 0x014,
    dataStart: 2,
  });
  assert.deepEqual(decodeIsoTp([0x21, 0xaa, 0xbb]), {
    kind: "consecutive",
    seq: 1,
    dataStart: 1,
  });
  assert.equal(decodeIsoTp([0x30, 0x00, 0x00]).kind, "flow-control");
  assert.equal(decodeIsoTp([]).kind, "unknown");
});

test("OBD-II mode 01 response decodes service + named PID", () => {
  // 0x7E8 response: SF len 4, 0x41 (= mode 01 response), PID 0x0C (RPM), 2 data bytes.
  const d = decodeDiagnostic(0x7e8, false, [0x04, 0x41, 0x0c, 0x1a, 0xf8, 0, 0, 0]);
  assert.ok(d);
  assert.equal(d.addressing.role, "response");
  assert.equal(d.addressing.ecu, 0);
  assert.equal(d.isotp.kind, "single");
  assert.equal(d.service?.raw, 0x41);
  assert.equal(d.service?.reqSid, 0x01);
  assert.equal(d.service?.isResponse, true);
  assert.equal(d.service?.name, "OBD current data");
  assert.equal(d.identifier?.kind, "PID");
  assert.equal(d.identifier?.value, 0x0c);
  assert.equal(d.identifier?.name, "Engine RPM");
});

test("UDS ReadDataByIdentifier request decodes the 2-byte DID", () => {
  // 0x7E0 physical request: SF len 3, SID 0x22, DID 0xF190.
  const d = decodeDiagnostic(0x7e0, false, [0x03, 0x22, 0xf1, 0x90, 0, 0, 0, 0]);
  assert.ok(d);
  assert.equal(d.addressing.role, "request-physical");
  assert.equal(d.service?.reqSid, 0x22);
  assert.equal(d.service?.isResponse, false);
  assert.equal(d.service?.name, "ReadDataByIdentifier");
  assert.equal(d.identifier?.kind, "DID");
  assert.equal(d.identifier?.value, 0xf190);
});

test("negative response reports rejected service + NRC", () => {
  // 0x7E8: SF len 3, 0x7F (negative), rejected SID 0x22, NRC 0x31 (requestOutOfRange).
  const d = decodeDiagnostic(0x7e8, false, [0x03, 0x7f, 0x22, 0x31, 0, 0, 0, 0]);
  assert.ok(d);
  assert.equal(d.service, undefined);
  assert.equal(d.negative?.rejectedSid, 0x22);
  assert.equal(d.negative?.rejectedName, "ReadDataByIdentifier");
  assert.equal(d.negative?.nrc, 0x31);
  assert.equal(d.negative?.nrcName, "requestOutOfRange");
});

test("a first frame is labelled but not reassembled (no identifier beyond SID)", () => {
  // 0x7E8: FF total 20, SID 0x62 (RDBI response), DID 0xF190.
  const d = decodeDiagnostic(0x7e8, false, [0x10, 0x14, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03]);
  assert.ok(d);
  assert.equal(d.isotp.kind, "first");
  assert.equal(d.isotp.length, 0x14);
  assert.equal(d.service?.reqSid, 0x22);
  assert.equal(d.service?.isResponse, true);
  assert.equal(d.identifier?.kind, "DID");
  assert.equal(d.identifier?.value, 0xf190);
});

test("non-diagnostic id returns null", () => {
  assert.equal(decodeDiagnostic(0x280, false, [0x12, 0x34]), null);
});

/* ── ISO-TP reassembly ──────────────────────────────────────────────────── */

test("reassembleIsoTp: a plain single frame yields the SF payload, complete", () => {
  const r = reassembleIsoTp([[0x04, 0x41, 0x0c, 0x1a, 0xf8, 0, 0, 0]]);
  assert.equal(r.kind, "single");
  assert.equal(r.totalLength, 4);
  assert.deepEqual(r.data, [0x41, 0x0c, 0x1a, 0xf8]);
  assert.equal(r.complete, true);
  assert.equal(r.expected, 0);
});

test("reassembleIsoTp: FF + CFs reconstruct the full message in order", () => {
  // FF total length 0x14 (20). FF carries 6 payload bytes (62 F1 90 01 02 03);
  // then CF1 (7 bytes), CF2 (7 bytes) → 6 + 7 + 7 = 20.
  const ff = [0x10, 0x14, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03];
  const cf1 = [0x21, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a];
  const cf2 = [0x22, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
  const r = reassembleIsoTp([ff, cf1, cf2]);
  assert.equal(r.kind, "multi");
  assert.equal(r.totalLength, 0x14);
  assert.equal(r.complete, true);
  assert.equal(r.expected, 0);
  assert.equal(r.data.length, 0x14);
  assert.deepEqual(r.data, [
    0x62, 0xf1, 0x90, 0x01, 0x02, 0x03, // FF payload
    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, // CF1
    0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, // CF2 (trimmed to total)
  ].slice(0, 0x14));
});

test("reassembleIsoTp: only the First Frame present → incomplete, reports remaining", () => {
  const ff = [0x10, 0x14, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03];
  const r = reassembleIsoTp([ff]);
  assert.equal(r.kind, "multi");
  assert.equal(r.complete, false);
  assert.equal(r.data.length, 6); // FF payload only
  assert.equal(r.expected, 0x14 - 6); // 14 bytes still expected
  assert.ok(r.note);
});

test("reassembleIsoTp: out-of-order / missing CF stops best-effort with a note", () => {
  const ff = [0x10, 0x14, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03];
  // Expected seq 1, but we get seq 2 (CF1 dropped) → stop after FF payload.
  const cf2 = [0x22, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
  const r = reassembleIsoTp([ff, cf2]);
  assert.equal(r.complete, false);
  assert.equal(r.data.length, 6);
  assert.match(r.note ?? "", /expected seq 1, saw 2/);
});

test("reassembleIsoTp: sequence wraps 0..15 across a long transfer", () => {
  // total = 6 (FF) + 15 CFs * 7 bytes = 6 + 105 = 111 bytes. Seq goes 1..15,0.
  const total = 111;
  const ff = [0x10, (total >> 8) & 0x0f | 0x10, ...Array(6).fill(0xaa)];
  // fix the FF length nibble: byte0 = 0x10 | high nibble of total, byte1 = low byte.
  ff[0] = 0x10 | ((total >> 8) & 0x0f);
  ff[1] = total & 0xff;
  const frames: number[][] = [ff];
  for (let n = 0; n < 15; n++) {
    const seq = (n + 1) & 0x0f; // 1,2,…,15,0
    frames.push([0x20 | seq, ...Array(7).fill(0xbb)]);
  }
  const r = reassembleIsoTp(frames);
  assert.equal(r.complete, true, r.note);
  assert.equal(r.data.length, total);
});

test("reassembleIsoTp: picks the most recent transfer when an old one precedes it", () => {
  const oldSf = [0x03, 0x22, 0xf1, 0x90, 0, 0, 0, 0];
  const ff = [0x10, 0x0a, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03];
  const cf1 = [0x21, 0x04, 0x05, 0x06, 0, 0, 0, 0];
  const r = reassembleIsoTp([oldSf, ff, cf1]);
  // total 10 = 6 (FF) + 4 (CF1 payload that matters); CF1 has 7 payload bytes but
  // we only need 4 more, so it trims to 10.
  assert.equal(r.kind, "multi");
  assert.equal(r.totalLength, 0x0a);
  assert.equal(r.data.length, 0x0a);
  assert.equal(r.complete, true);
});

test("decodeDiagnosticReassembled: multi-frame UDS response decodes SID + DID from full message", () => {
  const ff = [0x10, 0x14, 0x62, 0xf1, 0x90, 0x01, 0x02, 0x03];
  const cf1 = [0x21, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a];
  const cf2 = [0x22, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
  const d = decodeDiagnosticReassembled(0x7e8, false, [ff, cf1, cf2]);
  assert.ok(d);
  assert.equal(d.addressing.role, "response");
  assert.equal(d.isotp.kind, "first");
  assert.equal(d.reassembly.complete, true);
  assert.equal(d.service?.reqSid, 0x22);
  assert.equal(d.service?.isResponse, true);
  assert.equal(d.identifier?.kind, "DID");
  assert.equal(d.identifier?.value, 0xf190);
});

test("decodeDiagnosticReassembled: single frame delegates and decodes like before", () => {
  const d = decodeDiagnosticReassembled(0x7e8, false, [
    [0x04, 0x41, 0x0c, 0x1a, 0xf8, 0, 0, 0],
  ]);
  assert.ok(d);
  assert.equal(d.reassembly.kind, "single");
  assert.equal(d.reassembly.complete, true);
  assert.equal(d.service?.reqSid, 0x01);
  assert.equal(d.identifier?.name, "Engine RPM");
});

test("decodeDiagnosticReassembled: non-diagnostic id returns null", () => {
  assert.equal(decodeDiagnosticReassembled(0x280, false, [[0x10, 0x14]]), null);
});
