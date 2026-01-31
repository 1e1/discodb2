"""Rolling bus/stream statistics for the §3.4 health payload.

Cheap, allocation-light counters updated on the hot path (per frame / per batch)
and snapshotted by the health task. No numpy: just ints, a small deque for the
fps window, and a set of seen ids.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from .clock import now_us


@dataclass(slots=True)
class BusStats:
    """Counters describing the live/replay bus."""

    bitrate: int = 0
    state: str = "IDLE"  # IDLE | LIVE | REPLAY | ERROR
    total: int = 0
    errors: int = 0
    last_frame_us: int = 0
    _unique_ids: set = field(default_factory=set)
    # (monotonic_seconds, on_wire_bits) for frames in the last second; powers
    # both instantaneous fps and bus_load from the SAME window.
    _recent: deque = field(default_factory=lambda: deque())
    _started_us: int = 0

    def start(self, bitrate: int, state: str) -> None:
        self.bitrate = bitrate
        self.state = state
        self.total = 0
        self.errors = 0
        self.last_frame_us = 0
        self._unique_ids.clear()
        self._recent.clear()
        self._started_us = now_us()

    def stop(self) -> None:
        self.state = "IDLE"
        self._recent.clear()

    def record_frame(self, can_id: int, dlc: int, is_error: bool, is_extended: bool) -> None:
        self.total += 1
        if is_error:
            self.errors += 1
        self._unique_ids.add((can_id, is_extended))
        self.last_frame_us = now_us()
        # Approx classic-CAN on-wire frame size in bits for bus_load:
        # ~47 bits overhead (SOF, arb, control, CRC, ACK, EOF, IFS) for an 11-bit
        # id, ~67 for a 29-bit id; +8 bits per data byte. Ignores bit-stuffing
        # (an over-estimate would need it) — good enough for a load gauge.
        bits = (67 if is_extended else 47) + dlc * 8
        self._recent.append((time.monotonic(), bits))

    def _trim(self, now: float, window: float = 1.0) -> None:
        cutoff = now - window
        rec = self._recent
        while rec and rec[0][0] < cutoff:
            rec.popleft()

    def fps(self) -> int:
        now = time.monotonic()
        self._trim(now)
        return len(self._recent)

    def fps_avg(self) -> int:
        if self._started_us == 0:
            return 0
        elapsed_s = max((now_us() - self._started_us) / 1_000_000, 1e-6)
        return int(self.total / elapsed_s)

    def bus_load(self) -> float:
        """Fraction (0..1) of bus capacity actually used over the last second."""
        if self.bitrate <= 0:
            return 0.0
        now = time.monotonic()
        self._trim(now)
        if not self._recent:
            return 0.0
        bits_last_second = sum(bits for _, bits in self._recent)
        return min(bits_last_second / self.bitrate, 1.0)

    def last_frame_ms(self) -> int:
        if self.last_frame_us == 0:
            return 0
        return max(int((now_us() - self.last_frame_us) / 1000), 0)

    @property
    def unique_ids(self) -> int:
        return len(self._unique_ids)


@dataclass(slots=True)
class StreamStats:
    """Counters for the outgoing WebSocket binary stream."""

    out_bytes_total: int = 0
    dropped: int = 0
    _window: deque = field(default_factory=lambda: deque())  # (monotonic_s, bytes)

    def record_out(self, n_bytes: int) -> None:
        self.out_bytes_total += n_bytes
        self._window.append((time.monotonic(), n_bytes))

    def record_drop(self, n: int = 1) -> None:
        self.dropped += n

    def out_bps(self) -> int:
        now = time.monotonic()
        cutoff = now - 1.0
        while self._window and self._window[0][0] < cutoff:
            self._window.popleft()
        return int(sum(b for _, b in self._window) * 8)
