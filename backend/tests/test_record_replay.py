"""Record -> replay round-trip and candump log fidelity.

Verifies that frames written by the Recorder, read back by ReplayBus, and
re-batched through the SAME encode path reproduce the original frames (ids,
dlc, data, flags) and preserve relative inter-frame timing.
"""

from __future__ import annotations

import os

import pytest

from discodb2_backend.candump_log import format_line, parse_line, parse_lines
from discodb2_backend.protocol import Frame
from discodb2_backend.recorder import Recorder
from discodb2_backend.adapters.replay import ReplayBus


def test_candump_line_round_trip_standard():
    line = format_line(12_500_000, 0x280, b"\x11\x22\x33\x44\x55\x66\x77\x88")
    assert line == "(12.500000) can0 280#1122334455667788"
    entry = parse_line(line)
    assert entry.arbitration_id == 0x280
    assert entry.data == b"\x11\x22\x33\x44\x55\x66\x77\x88"
    assert entry.dlc == 8
    assert not entry.is_extended


def test_candump_line_extended():
    line = format_line(1_000_000, 0x1F334455, b"\xDE\xAD\xBE\xEF", is_extended=True)
    assert line == "(1.000000) can0 1F334455#DEADBEEF"
    entry = parse_line(line)
    assert entry.is_extended
    assert entry.arbitration_id == 0x1F334455
    assert entry.data == b"\xDE\xAD\xBE\xEF"


def test_candump_line_high_std_id_promoted_to_extended():
    # An id > 0x7FF can't be 11-bit; can-utils renders/reads it as extended.
    entry = parse_line("(0.000000) can0 800#00")
    assert entry.is_extended
    assert entry.arbitration_id == 0x800


def test_candump_rtr():
    line = format_line(2_000_000, 0x200, b"", dlc=8, is_rtr=True)
    assert line == "(2.000000) can0 200#R8"
    entry = parse_line(line)
    assert entry.is_rtr
    assert entry.dlc == 8
    assert entry.data == b""


def test_parse_skips_blank_and_comment():
    assert parse_line("") is None
    assert parse_line("   ") is None
    assert parse_line("# a comment") is None


def test_parse_rejects_garbage():
    with pytest.raises(ValueError):
        parse_line("(0.0) can0 ZZZ#GG")


def test_record_then_replay_round_trip(tmp_path):
    rec = Recorder(str(tmp_path))
    info = rec.start(name="rt")
    assert info.active and info.file and info.file.endswith(".log")

    base = 1_000_000
    originals = [
        Frame(t_us=base + 0, can_id=0x100, dlc=8, data=bytes(range(8))),
        Frame(t_us=base + 5_000, can_id=0x7FF, dlc=1, data=b"\x42"),
        Frame(t_us=base + 12_000, can_id=0x1ABCDEF0, dlc=4, data=b"\xDE\xAD\xBE\xEF", is_extended=True),
        Frame(t_us=base + 20_000, can_id=0x200, dlc=0, is_rtr=True),
    ]
    for f in originals:
        rec.write(f)
    done = rec.stop()
    assert done.frames == 4
    log_path = done.file
    assert os.path.exists(log_path)

    # Replay (no pacing) reads the SAME file back through the stream path.
    bus = ReplayBus(log_path, realtime=False)
    got = []
    while True:
        msg = bus.recv(timeout=0.01)
        if msg is None:
            if bus.exhausted:
                break
            continue
        got.append(msg)
    bus.shutdown()

    assert len(got) == len(originals)
    for orig, msg in zip(originals, got):
        assert msg.arbitration_id == orig.can_id
        assert msg.dlc == orig.dlc
        assert msg.data == orig.data[: orig.dlc]
        assert msg.is_extended == orig.is_extended
        assert msg.is_rtr == orig.is_rtr


def test_replay_preserves_relative_timing(tmp_path):
    # Inter-frame offsets in the log must be reproduced in the monotonic
    # timestamps replay assigns (re-anchored to "now", but gaps preserved).
    log = tmp_path / "timing.log"
    log.write_text(
        "(10.000000) can0 100#00\n"
        "(10.010000) can0 101#01\n"  # +10 ms
        "(10.035000) can0 102#02\n"  # +25 ms
    )
    bus = ReplayBus(str(log), realtime=False)
    msgs = []
    while not bus.exhausted:
        m = bus.recv(timeout=0.01)
        if m is not None:
            msgs.append(m)
    assert len(msgs) == 3
    d1 = msgs[1].timestamp_us - msgs[0].timestamp_us
    d2 = msgs[2].timestamp_us - msgs[1].timestamp_us
    assert d1 == 10_000
    assert d2 == 25_000


def test_record_to_batch_encode_round_trip(tmp_path):
    # Full chain: write log -> replay -> encode_batch -> decode_batch.
    from discodb2_backend.protocol import encode_batch, decode_batch

    rec = Recorder(str(tmp_path))
    rec.start(name="chain")
    base = 2_000_000
    originals = [
        Frame(t_us=base, can_id=0x11E, dlc=8, data=bytes(range(8, 16))),
        Frame(t_us=base + 3000, can_id=0x5A0, dlc=2, data=b"\xAB\xCD"),
    ]
    for f in originals:
        rec.write(f)
    done = rec.stop()

    bus = ReplayBus(done.file, realtime=False)
    replay_frames = []
    while not bus.exhausted:
        m = bus.recv(timeout=0.01)
        if m is None:
            continue
        replay_frames.append(
            Frame(
                t_us=m.timestamp_us,
                can_id=m.arbitration_id,
                dlc=m.dlc,
                data=m.data,
                is_extended=m.is_extended,
                is_rtr=m.is_rtr,
            )
        )
    payload = encode_batch(replay_frames, replay_frames[0].t_us, replay=True)
    decoded = decode_batch(payload)
    assert decoded.header.is_replay
    assert [f.can_id for f in decoded.frames] == [0x11E, 0x5A0]
    assert decoded.frames[0].data == bytes(range(8, 16))
    assert decoded.frames[1].data == b"\xAB\xCD"
