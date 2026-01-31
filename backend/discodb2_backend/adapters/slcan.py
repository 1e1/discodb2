"""slcan source (serial-line CAN, e.g. CANable in slcan firmware).

Wraps python-can's ``slcan`` backend. Listen-only support depends on the
installed python-can version: not every build accepts ``listen_only`` for slcan.
Per invariant 1 we REFUSE to open silently in a transmitting mode when silence
was requested -- failing loud is safer than ACKing on a live vehicle bus by
accident (logic lifted from ``app/adapters/can_adapter.py``).

Imported lazily so the backend runs without python-can; selecting this source
without it fails loudly.
"""

from __future__ import annotations

import inspect
from typing import Optional

from ..clock import now_us
from .base import CanMessage


def _slcan_supports_listen_only() -> bool:
    try:
        from can.interfaces.slcan import slcanBus

        return "listen_only" in inspect.signature(slcanBus.__init__).parameters
    except Exception:
        return False


class SlcanBus:
    """Wraps ``can.Bus(interface='slcan')``, enforcing listen-only."""

    def __init__(self, channel: str, bitrate: int = 500000, *, listen_only: bool = True) -> None:
        try:
            import can
        except Exception as exc:  # pragma: no cover - needs python-can
            raise RuntimeError(
                "slcan source requires python-can. Install it with `pip install python-can`."
            ) from exc

        if listen_only and not _slcan_supports_listen_only():
            raise RuntimeError(
                "listen-only requested but this python-can slcan backend does not "
                "support it. Use a gs_usb adapter, upgrade python-can, or disable "
                "listen-only deliberately (the adapter will then ACK on the bus)."
            )
        if not listen_only:
            raise RuntimeError(
                "listen-only is enforced for slcan; disabling it is refused."
            )
        self.channel = channel
        self.bitrate = bitrate
        self._bus = can.Bus(
            interface="slcan",
            channel=channel,
            bitrate=bitrate,
            listen_only=listen_only,
        )

    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        msg = self._bus.recv(timeout=timeout)
        if msg is None:
            return None
        return CanMessage(
            arbitration_id=msg.arbitration_id,
            data=bytes(msg.data),
            dlc=msg.dlc,
            is_extended=bool(msg.is_extended_id),
            is_error=bool(getattr(msg, "is_error_frame", False)),
            is_rtr=bool(getattr(msg, "is_remote_frame", False)),
            timestamp_us=now_us(),
        )

    def shutdown(self) -> None:
        try:
            self._bus.shutdown()
        except Exception:
            pass
