"""Sanity for rolling stats used by the §3.4 health payload."""

from __future__ import annotations

from discodb2_backend.stats import BusStats, StreamStats


def test_bus_stats_counts_and_unique_ids():
    bs = BusStats()
    bs.start(500000, "LIVE")
    bs.record_frame(0x100, 8, is_error=False, is_extended=False)
    bs.record_frame(0x100, 8, is_error=False, is_extended=False)  # same id
    bs.record_frame(0x200, 4, is_error=False, is_extended=False)
    bs.record_frame(0x1ABCDEF0, 0, is_error=True, is_extended=True)
    assert bs.total == 4
    assert bs.errors == 1
    # (0x100,False) counted once; (0x200,False); (0x1ABCDEF0,True) => 3 unique
    assert bs.unique_ids == 3
    assert bs.fps() == 4  # all within the last second
    assert bs.last_frame_ms() >= 0


def test_bus_load_zero_when_idle():
    bs = BusStats()
    assert bs.bus_load() == 0.0  # no bitrate, no frames
    bs.start(500000, "LIVE")
    assert bs.bus_load() == 0.0  # no frames yet


def test_bus_load_fraction_in_range():
    bs = BusStats()
    bs.start(500000, "LIVE")
    for _ in range(100):
        bs.record_frame(0x100, 8, is_error=False, is_extended=False)
    load = bs.bus_load()
    # 100 frames * (47 + 64) bits = 11100 bits over 500000 bps in the last
    # second => ~0.022; must be a sane fraction.
    assert 0.0 < load < 1.0
    assert abs(load - (100 * (47 + 64)) / 500000) < 1e-6


def test_stream_stats_dropped_and_bps():
    ss = StreamStats()
    ss.record_out(1000)
    ss.record_out(500)
    ss.record_drop()
    ss.record_drop(3)
    assert ss.dropped == 4
    assert ss.out_bps() == (1000 + 500) * 8  # within the 1s window
