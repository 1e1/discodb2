"""Replay source -- streams a recorded candump ``-l`` file (DESIGN.md §4.4, §5).

Replay reuses the EXACT same stream path as a live source: it exposes the same
``recv()/shutdown()`` surface and yields :class:`CanMessage` objects, so the
batcher / recorder / WebSocket code is identical whether frames come from a real
bus, the simulator, or a file.

Timestamps: the log's relative inter-frame gaps are preserved and re-anchored to
the backend monotonic clock at open time (``timestamp_us`` is set on each
message). By default replay is *paced* to wall time using ``time.sleep`` between
frames so a frontend sees traffic at the original rate; pacing can be disabled
(``realtime=False``) for fast round-trip tests.

The batcher tags batches from a replay source with the replay flag (bit0) -- see
``BatchFlag`` handling in the server.
"""

from __future__ import annotations

import time
from typing import Optional

from ..candump_log import LogEntry, parse_lines
from ..clock import now_us
from .base import CanMessage


class ReplayBus:
    """File-backed CAN source.

    Loads the whole capture eagerly. Captures are small relative to RAM for a
    RE session, and eager loading keeps ``recv`` allocation-free and lets us
    validate the file up front (fail loud on a corrupt capture).
    """

    is_replay = True  # marker the server reads to set the batch replay flag

    def __init__(self, path: str, *, realtime: bool = True, loop: bool = False) -> None:
        self.path = path
        self.realtime = realtime
        self.loop = loop
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            self._entries: list[LogEntry] = list(parse_lines(fh))
        self._index = 0
        # Monotonic anchor: map the first log timestamp to "now".
        self._wall_start = time.monotonic()
        self._mono_base_us = now_us()
        self._log_base_us = self._entries[0].t_us if self._entries else 0

    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        if self._index >= len(self._entries):
            if self.loop and self._entries:
                self._restart()
            else:
                # End of file: behave like an idle bus (timeout) so the reader
                # loop keeps spinning until shutdown.
                time.sleep(min(timeout, 0.05))
                return None

        entry = self._entries[self._index]
        rel_us = entry.t_us - self._log_base_us  # offset within the capture

        if self.realtime:
            # Wait until wall time catches up to this frame's scheduled offset,
            # but never block longer than the caller's timeout in one go.
            target = self._wall_start + rel_us / 1_000_000
            remaining = target - time.monotonic()
            if remaining > 0:
                time.sleep(min(remaining, max(timeout, 0.0)))
                if time.monotonic() < target:
                    return None  # not due yet; caller will re-poll

        self._index += 1
        return CanMessage(
            arbitration_id=entry.arbitration_id,
            data=entry.data,
            dlc=entry.dlc,
            is_extended=entry.is_extended,
            is_rtr=entry.is_rtr,
            timestamp_us=self._mono_base_us + rel_us,
        )

    def _restart(self) -> None:
        self._index = 0
        self._wall_start = time.monotonic()
        self._mono_base_us = now_us()

    def shutdown(self) -> None:
        return None

    @property
    def exhausted(self) -> bool:
        return not self.loop and self._index >= len(self._entries)
