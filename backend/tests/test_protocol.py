"""Byte-for-byte conformance of the §3.2 binary frame stream.

These tests assert the EXACT wire bytes a frontend's DataView parser will see,
not just round-trip equality, so a future refactor can't silently shift a field.
"""

from __future__ import annotations

import struct

from discodb2_backend.protocol import (
    BATCH_FLAG_REPLAY,
    CAN_EFF_FLAG,
    CAN_ERR_FLAG,
    HEADER_SIZE,
    PROTOCOL_VERSION,
    RECORD_SIZE,
    REC_FLAG_RTR,
    Frame,
    decode_batch,
    encode_batch,
    encode_record,
)


def test_sizes_match_contract():
    assert HEADER_SIZE == 12
    assert RECORD_SIZE == 20


def test_header_exact_bytes():
    base = 0x0102030405060708
    payload = encode_batch([], base, replay=False)
    assert len(payload) == HEADER_SIZE  # no records
    # version u8, flags u8, count u16 LE, base_t_us u64 LE
    assert payload[0] == PROTOCOL_VERSION
    assert payload[1] == 0x00  # flags: not replay
    assert payload[2:4] == struct.pack("<H", 0)  # count 0
    assert payload[4:12] == struct.pack("<Q", base)


def test_header_replay_flag_bit0():
    payload = encode_batch([], 0, replay=True)
    assert payload[1] & BATCH_FLAG_REPLAY == BATCH_FLAG_REPLAY
    assert payload[1] == 0x01


def test_record_exact_bytes_standard_frame():
    base = 1_000_000
    frame = Frame(t_us=base + 0x11223344, can_id=0x123, dlc=3, data=b"\xAA\xBB\xCC")
    rec = encode_record(frame, base)
    assert len(rec) == 20
    # off 0: dt_us u32 LE
    assert rec[0:4] == struct.pack("<I", 0x11223344)
    # off 4: can_id u32 LE (no flags for std)
    assert rec[4:8] == struct.pack("<I", 0x123)
    # off 8: dlc
    assert rec[8] == 3
    # off 9: rec_flags (no RTR)
    assert rec[9] == 0
    # off 10..12: reserved u16 == 0
    assert rec[10:12] == b"\x00\x00"
    # off 12..20: data, zero-padded past dlc
    assert rec[12:20] == b"\xAA\xBB\xCC\x00\x00\x00\x00\x00"


def test_record_extended_id_sets_bit31():
    base = 0
    frame = Frame(t_us=10, can_id=0x1F334455, dlc=0, is_extended=True)
    rec = encode_record(frame, base)
    raw_id = struct.unpack("<I", rec[4:8])[0]
    assert raw_id & CAN_EFF_FLAG  # bit31 set
    assert (raw_id & 0x1FFFFFFF) == 0x1F334455
    assert not (raw_id & CAN_ERR_FLAG)


def test_record_error_frame_sets_bit30():
    frame = Frame(t_us=5, can_id=0x10, dlc=0, is_error=True)
    rec = encode_record(frame, 0)
    raw_id = struct.unpack("<I", rec[4:8])[0]
    assert raw_id & CAN_ERR_FLAG  # bit30
    assert not (raw_id & CAN_EFF_FLAG)


def test_record_rtr_flag_bit0():
    frame = Frame(t_us=5, can_id=0x200, dlc=0, is_rtr=True)
    rec = encode_record(frame, 0)
    assert rec[9] & REC_FLAG_RTR == REC_FLAG_RTR


def test_data_truncated_to_dlc_and_zero_padded():
    # Over-supplied data beyond dlc must NOT leak onto the wire.
    frame = Frame(t_us=0, can_id=1, dlc=2, data=b"\x01\x02")
    rec = encode_record(frame, 0)
    assert rec[12:20] == b"\x01\x02\x00\x00\x00\x00\x00\x00"


def test_full_batch_layout_and_count():
    base = 7_000_000
    frames = [
        Frame(t_us=base + 0, can_id=0x100, dlc=8, data=bytes(range(8))),
        Frame(t_us=base + 1500, can_id=0x7FF, dlc=1, data=b"\x42"),
        Frame(t_us=base + 3000, can_id=0x18DAF110, dlc=0, is_extended=True),
    ]
    payload = encode_batch(frames, base)
    assert len(payload) == HEADER_SIZE + 3 * RECORD_SIZE
    assert struct.unpack("<H", payload[2:4])[0] == 3  # count
    # second record's dt_us at the right offset
    off = HEADER_SIZE + RECORD_SIZE
    assert struct.unpack("<I", payload[off : off + 4])[0] == 1500


def test_round_trip_decode():
    base = 123_456_789
    frames = [
        Frame(t_us=base + 0, can_id=0x100, dlc=8, data=bytes(range(8))),
        Frame(t_us=base + 999, can_id=0x1ABCDEF0, dlc=4, data=b"\xDE\xAD\xBE\xEF", is_extended=True),
        Frame(t_us=base + 2000, can_id=0x200, dlc=0, is_rtr=True),
        Frame(t_us=base + 5000, can_id=0x055, dlc=0, is_error=True),
    ]
    payload = encode_batch(frames, base, replay=True)
    decoded = decode_batch(payload)
    assert decoded.header.version == PROTOCOL_VERSION
    assert decoded.header.is_replay
    assert decoded.header.count == 4
    assert decoded.header.base_t_us == base
    for original, got in zip(frames, decoded.frames):
        assert got.t_us == original.t_us
        assert got.can_id == original.can_id
        assert got.dlc == original.dlc
        assert got.data == original.data[: original.dlc]
        assert got.is_extended == original.is_extended
        assert got.is_error == original.is_error
        assert got.is_rtr == original.is_rtr


def test_decode_rejects_wrong_length():
    payload = encode_batch([Frame(t_us=0, can_id=1, dlc=0)], 0)
    import pytest

    with pytest.raises(ValueError):
        decode_batch(payload[:-1])  # truncated last record


def test_decode_rejects_bad_version():
    payload = bytearray(encode_batch([], 0))
    payload[0] = 99
    import pytest

    with pytest.raises(ValueError):
        decode_batch(bytes(payload))


def test_dlc_out_of_range_rejected():
    import pytest

    with pytest.raises(ValueError):
        Frame(t_us=0, can_id=1, dlc=9)
