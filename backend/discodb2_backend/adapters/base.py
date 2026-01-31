"""CAN adapter abstraction (DESIGN.md §5).

Every source -- sim, replay, socketcan, gs_usb, slcan -- exposes the SAME
duck-typed surface:

    msg = bus.recv(timeout)   # -> CanMessage | None  (None on timeout)
    bus.shutdown()

This mirrors the legacy ``app/adapters/can_adapter.py`` surface so existing
adapters (SimulatedBus, GsUsbListenOnlyBus) can be lifted with minimal change,
but adds an explicit, hardware-agnostic :class:`CanMessage` so the rest of the
backend never imports python-can types.

``recv`` is blocking with a timeout (it is called from a dedicated reader
thread), keeping the hot path off the asyncio event loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable


@dataclass(slots=True)
class CanMessage:
    """A raw CAN frame as produced by an adapter.

    ``timestamp_us`` is OPTIONAL and only set by sources that carry their own
    timebase (replay, and hardware HW-timestamping). When None, the reader
    stamps the frame with the backend monotonic clock on arrival. The backend
    treats hardware/replay timestamps as monotonic µs too (never wall clock).
    """

    arbitration_id: int
    data: bytes
    dlc: int
    is_extended: bool = False
    is_error: bool = False
    is_rtr: bool = False
    timestamp_us: Optional[int] = None


@runtime_checkable
class CanBus(Protocol):
    """Structural type implemented by every adapter."""

    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        """Return the next frame, or None if ``timeout`` seconds elapse."""
        ...

    def shutdown(self) -> None:
        """Release the device / stop producing. Idempotent, must not raise."""
        ...
