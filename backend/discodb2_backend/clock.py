"""Monotonic microsecond timebase (DESIGN.md §4.2).

The backend NEVER trusts the wall clock: a Raspberry Pi has no RTC and may boot
with a year-1970 date. Every CAN frame and every recorded line is stamped with a
strictly monotonic microsecond counter derived from :func:`time.monotonic_ns`.
Absolute (calendar) session time is the connecting client's responsibility.
"""

from __future__ import annotations

import time


def now_us() -> int:
    """Current monotonic time in integer microseconds.

    Monotonic across the life of the process; unaffected by NTP steps, DST, or a
    missing RTC. Not comparable between process runs (that is by design — clients
    assign absolute session time).
    """
    return time.monotonic_ns() // 1000
