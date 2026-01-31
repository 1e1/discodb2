// Unit tests for the canonical protocol codec (frontend/shared/protocol.ts).
//
// No test framework: uses Node's built-in `node:test` + `node:assert/strict`
// so it runs with `node --test` (via tsx) and adds zero deps to the contract.
//
// The byte-layout assertions are the load-bearing part: they pin the §3.2
// wire format so any accidental field reorder/endianness flip fails CI.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  BATCH_HEADER_BYTES,
  RECORD_BYTES,
  BatchFlag,
  RecFlag,
  CanIdBits,
  encodeBatch,
  decodeBatch,
  recordTimeUs,
  encodeControl,
  decodeControl,
  isHealth,
  type Health,
  type ClientMessage,
} from "./protocol.ts";

test("§3.2 byte layout: header + one record is exactly 32 bytes, little-endian", () => {
  const baseTimeUs = 0x1122334455667788n;
  const buf = encodeBatch({
    baseTimeUs,
    replay: true,
    records: [
      {
        dtUs: 0x0a0b0c0d,
        canId: 0x280,
        dlc: 8,
        data: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
      },
    ],
  });

  assert.equal(buf.byteLength, BATCH_HEADER_BYTES + RECORD_BYTES, "1 record => 32 bytes");

  const dv = new DataView(buf);

  // --- Header (12 bytes) ---
  assert.equal(dv.getUint8(0), PROTOCOL_VERSION, "byte0 version=1");
  assert.equal(dv.getUint8(1), BatchFlag.REPLAY, "byte1 flags bit0=replay");
  assert.equal(dv.getUint16(2, true), 1, "bytes2-3 count=1 (LE)");
  assert.equal(dv.getBigUint64(4, true), baseTimeUs, "bytes4-11 base_t_us (LE u64)");

  // Prove little-endianness explicitly on the count field: low byte first.
  const u8 = new Uint8Array(buf);
  assert.equal(u8[2], 0x01, "count low byte at offset 2");
  assert.equal(u8[3], 0x00, "count high byte at offset 3");

  // --- Record (offset 12, 20 bytes) ---
  const off = BATCH_HEADER_BYTES;
  assert.equal(dv.getUint32(off + 0, true), 0x0a0b0c0d, "rec dt_us (LE)");
  assert.equal(dv.getUint32(off + 4, true), 0x280, "rec can_id (LE, no flag bits)");
  assert.equal(dv.getUint8(off + 8), 8, "rec dlc");
  assert.equal(dv.getUint8(off + 9), 0, "rec rec_flags=0");
  assert.equal(dv.getUint16(off + 10, true), 0, "rec reserved=0");
  for (let i = 0; i < 8; i++) {
    assert.equal(u8[off + 12 + i], 0x11 * (i + 1), `rec data[${i}]`);
  }
});

test("encode→decode round-trips a multi-record batch (live, extended, RTR, error)", () => {
  const baseTimeUs = 9_876_543_210n;
  const records = [
    { dtUs: 0, canId: 0x100, dlc: 0, data: [] as number[] },
    {
      dtUs: 1500,
      canId: 0x1abcdef, // 29-bit id
      dlc: 4,
      isExtended: true,
      data: [0xde, 0xad, 0xbe, 0xef],
    },
    { dtUs: 50_000, canId: 0x7df, dlc: 8, isRtr: true, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    { dtUs: 60_000, canId: 0x0, dlc: 0, isError: true, data: [] },
  ];

  const decoded = decodeBatch(encodeBatch({ baseTimeUs, records }));

  assert.equal(decoded.version, PROTOCOL_VERSION);
  assert.equal(decoded.replay, false, "no replay flag => live");
  assert.equal(decoded.baseTimeUs, baseTimeUs);
  assert.equal(decoded.records.length, records.length);

  // record 0: empty payload
  assert.equal(decoded.records[0].dlc, 0);
  assert.equal(decoded.records[0].data.length, 0);
  assert.equal(decoded.records[0].canId, 0x100);

  // record 1: extended id preserved, flags decoded
  const r1 = decoded.records[1];
  assert.equal(r1.canId, 0x1abcdef);
  assert.equal(r1.isExtended, true);
  assert.equal(r1.isError, false);
  assert.deepEqual([...r1.data], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(r1.dtUs, 1500);

  // record 2: RTR flag preserved
  assert.equal(decoded.records[2].isRtr, true);
  assert.deepEqual([...decoded.records[2].data], [1, 2, 3, 4, 5, 6, 7, 8]);

  // record 3: error flag preserved
  assert.equal(decoded.records[3].isError, true);

  // recordTimeUs = base + dt
  assert.equal(recordTimeUs(decoded, r1), baseTimeUs + 1500n);
});

test("empty batch (count=0) is just the 12-byte header", () => {
  const buf = encodeBatch({ baseTimeUs: 42n, records: [] });
  assert.equal(buf.byteLength, BATCH_HEADER_BYTES);
  const decoded = decodeBatch(buf);
  assert.equal(decoded.records.length, 0);
  assert.equal(decoded.baseTimeUs, 42n);
});

test("decode accepts a Uint8Array view with a non-zero byteOffset", () => {
  const inner = encodeBatch({
    baseTimeUs: 7n,
    records: [{ dtUs: 3, canId: 0x123, dlc: 2, data: [0xaa, 0xbb] }],
  });
  // Embed the batch inside a larger buffer with a 5-byte prefix.
  const big = new Uint8Array(5 + inner.byteLength);
  big.set(new Uint8Array(inner), 5);
  const view = big.subarray(5); // byteOffset = 5

  const decoded = decodeBatch(view);
  assert.equal(decoded.baseTimeUs, 7n);
  assert.equal(decoded.records[0].canId, 0x123);
  assert.deepEqual([...decoded.records[0].data], [0xaa, 0xbb]);
});

test("encodeBatch rejects out-of-spec input (loud failure on the hot path)", () => {
  assert.throws(
    () => encodeBatch({ baseTimeUs: 0n, records: [{ dtUs: 0, canId: 1, dlc: 9, data: new Uint8Array(9) }] }),
    /dlc 9 out of range/,
  );
  // canId carrying the extended bit instead of using the flag field is rejected.
  assert.throws(
    () => encodeBatch({ baseTimeUs: 0n, records: [{ dtUs: 0, canId: CanIdBits.EXTENDED | 0x5, dlc: 0, data: [] }] }),
    /bits above 0..28/,
  );
});

test("decodeBatch throws on a truncated batch", () => {
  const buf = encodeBatch({
    baseTimeUs: 0n,
    records: [{ dtUs: 0, canId: 1, dlc: 8, data: [1, 2, 3, 4, 5, 6, 7, 8] }],
  });
  // Lop off the last 4 bytes: header claims count=1 but bytes are missing.
  const truncated = new Uint8Array(buf).subarray(0, buf.byteLength - 4);
  assert.throws(() => decodeBatch(truncated), /truncated/);
});

test("§3.3 control messages round-trip and reject garbage", () => {
  const msgs: ClientMessage[] = [
    { type: "hello", client: "cockpit" },
    { type: "start", source: "socketcan", bitrate: 500000, listen_only: true },
    { type: "start", source: "replay", bitrate: 500000, listen_only: true, file: "drive.canlog" },
    { type: "stop" },
    { type: "record_start", name: "ignition-on" },
    { type: "record_stop" },
    { type: "list_files" },
  ];
  for (const m of msgs) {
    assert.deepEqual(decodeControl(encodeControl(m)), m);
  }
  assert.equal(decodeControl("not json"), null);
  assert.equal(decodeControl('{"type":"bogus"}'), null);
  assert.equal(decodeControl("[]"), null);
});

test("§3.4 health: isHealth distinguishes a bare Health from tagged messages", () => {
  const health: Health = {
    uptime_s: 12,
    source: "sim",
    listen_only: true,
    recording: null,
    bus: {
      bitrate: 500000,
      state: "LIVE",
      fps: 1000,
      fps_avg: 990,
      total: 12345,
      unique_ids: 42,
      errors: 0,
      last_frame_ms: 3,
      bus_load: 0.31,
    },
    stream: { clients: 2, out_bps: 80000, dropped: 0 },
    record: { active: false, file: null, size: 0, disk_free: 1_000_000 },
    proc: { cpu: 4.5, rss: 22_000_000, reader_q: 0, ws_q: 0 },
  };
  // round-trip through JSON the way it travels on the wire
  const roundTripped = JSON.parse(JSON.stringify(health)) as Health;
  assert.equal(isHealth(roundTripped), true);
  assert.equal(isHealth({ type: "files", files: [] }), false);
  assert.equal(isHealth({ type: "error", message: "x" }), false);
});

test("RecFlag/BatchFlag bit values match the contract", () => {
  assert.equal(BatchFlag.REPLAY, 1);
  assert.equal(RecFlag.RTR, 1);
  assert.equal(CanIdBits.ERROR, 0x40000000);
  assert.equal(CanIdBits.EXTENDED >>> 0, 0x80000000);
  assert.equal(CanIdBits.ID_MASK, 0x1fffffff);
});
